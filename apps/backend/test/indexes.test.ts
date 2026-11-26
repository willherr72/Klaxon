import { expect, test } from "vitest";
import { insertWorkspace, recordVersion, taskRecord, testBackend } from "./fixtures";

test("queries pending reminders in a workspace by the next trigger window", async () => {
  const t = testBackend();
  const alpha = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    const pending = {
      ...recordVersion,
      workspaceId: alpha,
      title: "Synthetic reminder",
      priority: "normal",
      timezone: "America/Chicago",
      state: "pending",
    } as const;

    await db.insert("reminders", { ...pending, publicId: "last", dueAt: 19, nextTriggerAt: 19 });
    await db.insert("reminders", { ...pending, publicId: "first", dueAt: 10, nextTriggerAt: 10 });
    await db.insert("reminders", { ...pending, publicId: "before", dueAt: 9, nextTriggerAt: 9 });
    await db.insert("reminders", { ...pending, publicId: "after", dueAt: 20, nextTriggerAt: 20 });
    await db.insert("reminders", { ...pending, publicId: "done", dueAt: 10, state: "completed" });
    await db.insert("reminders", {
      ...pending, publicId: "snoozed", dueAt: 5, snoozeUntil: 15, nextTriggerAt: 15, state: "snoozed",
    });
    await db.insert("reminders", { ...pending, publicId: "foreign", workspaceId: beta, dueAt: 10, nextTriggerAt: 10 });
    return alpha;
  });

  const due = (state: "pending" | "snoozed") => t.query(({ db }) => db.query("reminders")
    .withIndex("by_workspace_state_trigger", (q) => q.eq("workspaceId", alpha).eq("state", state)
      .gte("nextTriggerAt", 10).lt("nextTriggerAt", 20))
    .collect());

  expect((await due("pending")).map((row) => row.publicId)).toEqual(["first", "last"]);
  expect((await due("snoozed")).map((row) => row.publicId)).toEqual(["snoozed"]);
});

test("distinguishes a managed external mirror from manual links on the same object", async () => {
  const t = testBackend();
  const { alpha, beta, primary, secondary, foreign } = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    const connection = async (workspaceId: typeof alpha, publicId: string) => {
      const workspace = await db.get(workspaceId);
      if (!workspace) throw new Error("Missing fixture workspace");
      return db.insert("integrationConnections", {
        ...recordVersion, workspaceId, publicId, userId: workspace.ownerId, provider: "linear",
        accountId: publicId, scopeIds: [], state: "active",
      });
    };
    const primary = await connection(alpha, "primary");
    const secondary = await connection(alpha, "secondary");
    const foreign = await connection(beta, "primary");
    const taskId = await db.insert("tasks", taskRecord(alpha, "alpha-task"));
    const otherTaskId = await db.insert("tasks", taskRecord(beta, "beta-task"));
    const mirror = {
      ...recordVersion,
      workspaceId: alpha,
      taskId,
      provider: "linear",
      connectionId: primary,
      externalObjectId: "synthetic-issue",
      canonicalUrl: "https://example.invalid/issue",
      relationship: "managed_mirror",
    } as const;

    await db.insert("externalLinks", { ...mirror, publicId: "primary-mirror" });
    await db.insert("externalLinks", { ...mirror, publicId: "manual-reference", relationship: "reference" });
    await db.insert("externalLinks", { ...mirror, publicId: "secondary-mirror", connectionId: secondary });
    await db.insert("externalLinks", { ...mirror, publicId: "other-object", externalObjectId: "different-issue" });
    await db.insert("externalLinks", {
      ...mirror, publicId: "foreign-mirror", workspaceId: beta, connectionId: foreign, taskId: otherTaskId,
    });
    return { alpha, beta, primary, secondary, foreign };
  });

  const mirror = (workspaceId: typeof alpha, connectionId: typeof primary) =>
    t.query(({ db }) => db.query("externalLinks").withIndex("by_workspace_connection_external_id", (q) => q
      .eq("workspaceId", workspaceId).eq("connectionId", connectionId)
      .eq("externalObjectId", "synthetic-issue").eq("relationship", "managed_mirror"))
      .unique());

  expect((await mirror(alpha, primary))?.publicId).toBe("primary-mirror");
  expect((await mirror(alpha, secondary))?.publicId).toBe("secondary-mirror");
  expect((await mirror(beta, foreign))?.publicId).toBe("foreign-mirror");
  expect(await mirror(beta, primary)).toBeNull();
});

test("scopes identical legacy import IDs by workspace and original source table", async () => {
  const t = testBackend();
  const { alpha, beta } = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    const mapping = {
      ...recordVersion,
      workspaceId: alpha,
      sourceTable: "reminders",
      legacyId: "legacy-id",
      state: "pending" as const,
      candidates: [],
    };

    await db.insert("importMappings", { ...mapping, publicId: "alpha-reminder" });
    await db.insert("importMappings", { ...mapping, publicId: "alpha-note", sourceTable: "day_notes" });
    await db.insert("importMappings", { ...mapping, publicId: "other-reminder", legacyId: "different-id" });
    await db.insert("importMappings", { ...mapping, publicId: "beta-reminder", workspaceId: beta });
    return { alpha, beta };
  });

  const lookup = (workspaceId: typeof alpha, sourceTable: string) =>
    t.query(({ db }) => db.query("importMappings").withIndex("by_workspace_source_legacy_id", (q) => q
      .eq("workspaceId", workspaceId).eq("sourceTable", sourceTable).eq("legacyId", "legacy-id"))
      .unique());

  expect((await lookup(alpha, "reminders"))?.publicId).toBe("alpha-reminder");
  expect((await lookup(alpha, "day_notes"))?.publicId).toBe("alpha-note");
  expect((await lookup(beta, "reminders"))?.publicId).toBe("beta-reminder");
  expect(await lookup(beta, "day_notes")).toBeNull();
});
