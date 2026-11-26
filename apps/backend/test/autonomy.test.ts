import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function setup() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/autonomy.ts": () => import("../convex/autonomy"),
    "../convex/backups.ts": () => import("../convex/backups"),
    "../convex/planning.ts": () => import("../convex/planning"),
  } });
  const { ownerId, plannerId, workspaceId, workTask, personalTask } = await t.run(async ({ db }) => {
    const ownerId = await db.insert("users", {});
    const plannerId = await db.insert("users", {});
    const workspaceId = await db.insert("workspaces", { ownerId, name: "Test", publicId: "test", ...recordVersion });
    for (const [userId, role] of [[ownerId, "owner"], [plannerId, "planner"]] as const) {
      await db.insert("memberships", { workspaceId, userId, role, publicId: role, ...recordVersion });
    }
    const workProject = await db.insert("projects", { workspaceId, publicId: "work", name: "Work",
      rank: 0, area: "Work", ...recordVersion });
    const personalProject = await db.insert("projects", { workspaceId, publicId: "personal", name: "Personal",
      rank: 0, area: "Personal", ...recordVersion });
    const workTask = (await db.get(await db.insert("tasks", taskRecord(workspaceId, "work-task", { projectId: workProject }))))!;
    const personalTask = (await db.get(await db.insert("tasks", taskRecord(workspaceId, "personal-task", { projectId: personalProject }))))!;
    return { ownerId, plannerId, workspaceId, workTask, personalTask };
  });
  const owner = t.withIdentity({ subject: ownerId });
  const update = (policy: Record<string, unknown>, expectedRevision = 0, operationId = crypto.randomUUID()) =>
    owner.mutation(anyApi.autonomy.update, { workspaceId, operationId, expectedRevision, policy });
  return { t, owner, ownerId, plannerId, workspaceId, workTask, personalTask, update };
}

const policy = {
  planApplication: "automatic",
  schedule: [{ weekday: 0, startMinute: 540, endMinute: 600 }],
  scope: { kind: "work" },
  excludedTaskPublicIds: [],
  excludedProjectPublicIds: [],
};

test("owner policy is automatic by default and editable with a revision and replay-safe operation", async () => {
  const { t, owner, plannerId, workspaceId, update } = await setup();
  await expect(owner.query(anyApi.autonomy.get, { workspaceId })).resolves.toMatchObject({
    revision: 0, policy: { planApplication: "automatic", scope: { kind: "all" }, schedule: [] },
  });
  await expect(t.withIdentity({ subject: plannerId }).query(anyApi.autonomy.get, { workspaceId })).rejects.toThrow(/FORBIDDEN/);
  await expect(t.withIdentity({ subject: plannerId }).mutation(anyApi.autonomy.update, {
    workspaceId, expectedRevision: 0, operationId: crypto.randomUUID(), policy,
  })).rejects.toThrow(/FORBIDDEN/);
  const id = crypto.randomUUID();
  await expect(update(policy, 0, id)).resolves.toMatchObject({ revision: 1 });
  await expect(update(policy, 0, id)).resolves.toMatchObject({ revision: 1 });
  await expect(update(policy, 0)).rejects.toThrow(/REVISION_CONFLICT/);
  await expect(update({ ...policy, scope: { kind: "projects", projectPublicIds: ["absent"] } }, 1))
    .rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(update({ ...policy, schedule: [...policy.schedule, ...policy.schedule] }, 1))
    .rejects.toThrow(/INVALID_ARGUMENT/);
});

test("scope, exclusions and the owner's zoned run hours constrain automatic application", async () => {
  const { enforceAutonomy } = await import("../convex/model/autonomy");
  const { t, owner, workspaceId, update, workTask, personalTask } = await setup();
  await update(policy);
  await owner.mutation(anyApi.planning.updatePreferences, { workspaceId, operationId: crypto.randomUUID(),
    expectedRevision: 1, preferences: {
      timezone: "America/Chicago", workHours: [], breaks: [], bufferMinutes: 8,
      discretionaryMinutes: 45, lockManuallyMovedBlocks: false,
    },
  });
  const run = (tasks: typeof workTask[], date: string, phase: "preview" | "apply" | "review") =>
    t.run(async ({ db }) => {
      await enforceAutonomy(db, workspaceId, tasks, Date.parse(date), phase);
      return true;
    });
  const start = "2028-03-13T14:00:00Z";
  const end = "2028-03-13T15:00:00Z";
  await expect(run([workTask], start, "apply")).resolves.toBe(true);
  await expect(run([personalTask], start, "preview")).rejects.toThrow(/AUTONOMY_OUT_OF_SCOPE/);
  await expect(run([workTask], end, "apply")).rejects.toThrow(/AUTONOMY_OUTSIDE_SCHEDULE/);
  await expect(run([workTask], end, "preview")).resolves.toBe(true);
  await update({ ...policy, scope: { kind: "projects", projectPublicIds: ["work"] },
    excludedTaskPublicIds: ["work-task"] }, 2);
  await expect(run([workTask], start, "apply")).rejects.toThrow(/AUTONOMY_OUT_OF_SCOPE/);
  await update({ ...policy, scope: { kind: "all" }, excludedProjectPublicIds: ["personal"], planApplication: "review" }, 3);
  await expect(run([personalTask], end, "review")).rejects.toThrow(/AUTONOMY_OUT_OF_SCOPE/);
  await expect(run([workTask], end, "review")).resolves.toBe(true);
  await expect(run([workTask], start, "apply")).rejects.toThrow(/AUTONOMY_APPROVAL_REQUIRED/);
  await expect(owner.query(anyApi.planning.getPreferences, { workspaceId })).resolves.toMatchObject({
    timezone: "America/Chicago", bufferMinutes: 8, discretionaryMinutes: 45, lockManuallyMovedBlocks: false,
  });
});

test("legacy review persists and a backup preserves policy links by public ID", async () => {
  const { t, owner, ownerId, workspaceId, update } = await setup();
  await t.run(({ db }) => db.insert("preferences", {
    workspaceId, userId: ownerId, publicId: "settings", ...recordVersion, timezone: "UTC", workHours: [],
    autonomyPolicy: { planApplication: "review", lockManuallyMovedBlocks: true },
    notificationSettings: { enabled: true, webPush: true, native: false }, importFilters: [],
  }));
  await expect(owner.query(anyApi.autonomy.get, { workspaceId })).resolves.toMatchObject({
    revision: 1, policy: { planApplication: "review", scope: { kind: "all" }, schedule: [] },
  });
  const persisted = { ...policy, scope: { kind: "projects", projectPublicIds: ["work"] },
    excludedTaskPublicIds: ["work-task"], excludedProjectPublicIds: ["personal"] };
  await update(persisted, 1);
  const { archive } = await owner.query(anyApi.backups.exportWorkspace, { workspaceId });
  const { workspaceId: restored } = await owner.mutation(anyApi.backups.restoreWorkspace, {
    operationId: crypto.randomUUID(), archive,
  });
  await expect(owner.query(anyApi.autonomy.get, { workspaceId: restored })).resolves.toMatchObject({
    revision: 2, policy: persisted, taskNames: [{ publicId: "work-task", name: "work-task" }],
    projectNames: expect.arrayContaining([{ publicId: "work", name: "Work" }, { publicId: "personal", name: "Personal" }]),
  });
});
