import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

const auth = { workspacePublicId: "workspace", tokenHash: "a".repeat(64) };
const reason = "Organize the inbox";

async function setup() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentTasks.ts": () => import("../convex/agentTasks"),
    "../convex/agentTaskActions.ts": () => import("../convex/agentTaskActions"),
    "../convex/agentHistory.ts": () => import("../convex/agentHistory"),
    "../convex/agentReferences.ts": () => import("../convex/agentReferences"),
  } });
  const ids = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, "workspace");
    const userId = (await db.get("workspaces", workspaceId))!.ownerId;
    await db.insert("memberships", { workspaceId, userId, role: "owner", publicId: "owner", ...recordVersion });
    await db.insert("agentCredentials", { workspaceId, userId, publicId: "agent", label: "Agent", tokenHash: auth.tokenHash,
      scopes: ["tasks:write", "activity:undo"], expiresAt: Date.now() + 60_000, ...recordVersion });
    const work = await db.insert("projects", { workspaceId, publicId: "work", name: "Work", area: "Work",
      rank: 0, ...recordVersion });
    await db.insert("projects", { workspaceId, publicId: "personal", name: "Personal", area: "Personal",
      rank: 1, ...recordVersion });
    const preferences = await db.insert("preferences", { workspaceId, userId, publicId: "preferences", timezone: "UTC",
      workHours: [], autonomyPolicy: { planApplication: "review", scope: { kind: "work" }, lockManuallyMovedBlocks: true,
        excludedTaskPublicIds: ["anchor"] }, importFilters: [], notificationSettings: { enabled: false, native: false, webPush: false },
      ...recordVersion });
    const task = await db.insert("tasks", taskRecord(workspaceId, "task", { projectId: work, rank: 0, plannedDate: "2030-01-01",
      deadline: { kind: "date", date: "2030-01-10" } }));
    await db.insert("tasks", taskRecord(workspaceId, "adjacent", { projectId: work, rank: 1 }));
    const anchor = await db.insert("tasks", taskRecord(workspaceId, "anchor", { projectId: work, rank: 1, rankTieBreak: 1 }));
    return { task, anchor, preferences };
  });
  const mode = (planApplication: "automatic" | "review",
    schedule?: { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; startMinute: number; endMinute: number }[]) =>
    t.run(async ({ db }) => {
      const row = (await db.get("preferences", ids.preferences))!;
      await db.patch("preferences", row._id, { autonomyPolicy: { ...row.autonomyPolicy, planApplication, schedule } });
    });
  const update = (patch: Record<string, unknown>, expectedRevision = 1, operationId = crypto.randomUUID()) =>
    t.mutation(anyApi.agentTasks.update, { ...auth, publicId: "task", reason, operationId, expectedRevision, patch });
  const write = (command: Record<string, unknown>) => t.mutation(anyApi.agentTaskActions.write, {
    ...auth, command: { reason, operationId: crypto.randomUUID(), ...command },
  });
  const undo = (eventPublicId: string, expectedRevision: number) =>
    t.mutation(anyApi.agentHistory.undo, { ...auth, eventPublicId, reason, expectedRevision, operationId: crypto.randomUUID() });
  return { t, ...ids, mode, update, write, undo };
}

test("review permits metadata edits while preventing planning changes, and protected commitments use guarded workflows", async () => {
  const { t, task, mode, update } = await setup();
  await expect(update({ priority: "urgent" })).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  const operationId = crypto.randomUUID();
  const title = await update({ title: "Clarify" }, 1, operationId);
  const outside = new Date().getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6; // Tomorrow in the policy's Monday-first numbering.
  await mode("automatic", [{ weekday: outside, startMinute: 540, endMinute: 600 }]);
  expect(await update({ title: "Clarify" }, 1, operationId)).toEqual(title);
  await expect(update({ priority: "urgent" }, 2)).rejects.toThrow("AUTONOMY_OUTSIDE_SCHEDULE");
  await mode("automatic");
  await expect(update({ projectPublicId: "personal" }, 2)).rejects.toThrow("AUTONOMY_OUT_OF_SCOPE");
  await expect(update({ plannedDate: null }, 2)).rejects.toThrow("TASK_PLAN_REQUIRED");
  await expect(update({ deadline: { kind: "date", date: "2030-01-11" } }, 2)).rejects.toThrow("TASK_DEADLINE_PROTECTED");
  await expect(update({ deadline: null }, 2)).rejects.toThrow("TASK_DEADLINE_PROTECTED");
  expect(await t.run(({ db }) => db.get("tasks", task))).toMatchObject({
    revision: 2, title: "Clarify", plannedDate: "2030-01-01", deadline: { kind: "date", date: "2030-01-10" },
  });
  await t.run(async ({ db }) => {
    const row = (await db.get("tasks", task))!;
    const personal = await db.query("projects").withIndex("by_workspace_public_id",
      q => q.eq("workspaceId", row.workspaceId).eq("publicId", "personal")).unique();
    await db.patch("tasks", task, { projectId: personal!._id });
  });
  await expect(update({ projectPublicId: "work" }, 2)).rejects.toThrow("AUTONOMY_OUT_OF_SCOPE");
});

test("move, excluded step parents, rank normalization, and undo obey current policy", async () => {
  const { t, anchor, mode, update, write, undo } = await setup();
  await expect(t.mutation(anyApi.agentReferences.link, { ...auth, taskPublicId: "anchor",
    publicId: "reference", expectedRevision: 1, operationId: crypto.randomUUID(), reason,
    url: "https://example.com/notes" })).rejects.toThrow("AUTONOMY_OUT_OF_SCOPE");
  const move = () => write({ kind: "task.move", publicId: "task", lanePublicId: null, expectedRevision: 1, beforePublicId: "anchor" });
  await expect(move()).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  await expect(write({ kind: "step.create", publicId: "step", taskPublicId: "anchor", title: "Excluded" }))
    .rejects.toThrow("AUTONOMY_OUT_OF_SCOPE");
  await mode("automatic");
  await expect(move()).rejects.toThrow("AUTONOMY_OUT_OF_SCOPE");
  expect(await t.run(({ db }) => db.get("tasks", anchor))).toMatchObject({ rank: 1, revision: 1 });
  const revised = await update({ priority: "urgent" });
  await mode("review");
  await expect(undo(revised.activityEventPublicId, 2)).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  await mode("automatic");
  await expect(undo(revised.activityEventPublicId, 2)).resolves.toMatchObject({ revision: 3 });
});
