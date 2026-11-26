import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import type { GenericId } from "convex/values";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion, taskRecord } from "./fixtures";

// Match the workspace endpoint fixture. The provider tests cover session
// verification; these calls exercise the registered backup authorization.
vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

const exportWorkspace = makeFunctionReference<"query", { workspaceId: GenericId<"workspaces"> }, { archive: string }>("backups:exportWorkspace");
const restoreWorkspace = makeFunctionReference<"mutation", { archive: string; operationId: string }, {
  workspaceId: GenericId<"workspaces">; workspacePublicId: string;
}>("backups:restoreWorkspace");

function restoreArgs(archive: string, operationId = crypto.randomUUID()) {
  return { archive, operationId };
}

async function setup() {
  const backend = convexTest({ schema, modules: {
    "../convex/_generated/inline-only.ts": async () => ({}),
    "../convex/backups.ts": () => import("../convex/backups"),
  } });
  const { ownerId, foreignId, workspaceId } = await backend.run(async ({ db }) => {
    const ownerId = await db.insert("users", {});
    const foreignId = await db.insert("users", {});
    const workspaceId = await db.insert("workspaces", { ownerId, name: "Example", publicId: "source", ...recordVersion });
    await db.insert("memberships", { workspaceId, userId: ownerId, role: "owner", publicId: "owner", ...recordVersion });
    await db.patch(ownerId, { personalWorkspaceId: workspaceId });
    const projectId = await db.insert("projects", { workspaceId, publicId: "project", name: "Example", rank: 0, ...recordVersion });
    const laneId = await db.insert("lanes", { workspaceId, publicId: "lane", name: "Default", projectId,
      rank: 0, isDefault: true, ...recordVersion });
    await db.patch(projectId, { board: { laneIds: [laneId] } });
    const captureId = await db.insert("captures", { workspaceId, publicId: "capture", body: "Thought ☕", tags: [], ...recordVersion });
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "task", { laneId, projectId,
      status: "archived", archivedFromStatus: "waiting", archivedAt: 7,
      source: { kind: "capture", captureId }, plannedDate: "2026-11-25", rank: 0.5 }));
    await db.patch(captureId, { promotedTaskId: taskId });
    await db.insert("taskSteps", { workspaceId, publicId: "step", taskId, title: "A step", rank: 0.25,
      completed: true, completedAt: 2, ...recordVersion });
    await db.insert("dayNotes", { workspaceId, publicId: "note", localDate: "2026-11-25", body: "", ...recordVersion });
    const planId = await db.insert("dayPlans", { workspaceId, publicId: "plan", localDate: "2026-11-25",
      timezone: "America/Chicago", source: "manual", focusTaskIds: [taskId], ...recordVersion });
    await db.insert("timeBlocks", { workspaceId, publicId: "block", localDate: "2026-11-25",
      timezone: "America/Chicago", startAt: 3, endAt: 4, locked: true, origin: "manual", taskId, planId, ...recordVersion });
    const reminderId = await db.insert("reminders", { workspaceId, publicId: "reminder", taskId, title: "Reminder",
      priority: "high", dueAt: 5, nextTriggerAt: 6, snoozeUntil: 6, timezone: "UTC", state: "snoozed",
      recurrence: { kind: "weekly", weekdays: [0, 6] }, ...recordVersion });
    await db.insert("reminderOccurrences", { workspaceId, reminderId, publicId: "occurrence", reminderRevision: 1,
      occurrenceKey: "private-occurrence", dueAt: 5, timezone: "UTC", state: "snoozed", deliveryState: "scheduled", ...recordVersion });
    const connectionId = await db.insert("integrationConnections", { workspaceId, userId: ownerId,
      publicId: "connection", provider: "linear", accountId: "private-account", scopeIds: [],
      secretRef: "private-connection-secret", state: "active", ...recordVersion });
    await db.insert("externalLinks", { workspaceId, publicId: "link", taskId, connectionId, provider: "linear",
      externalObjectId: "LINEAR-1", canonicalUrl: "https://linear.example/issue/LINEAR-1",
      relationship: "managed_mirror", cached: { title: "private-cache" }, refreshedAt: 4, ...recordVersion });
    await db.insert("dayNotes", { workspaceId, publicId: "linked-note", localDate: "2026-11-26", body: "Attribution",
      source: { kind: "integration", connectionId }, ...recordVersion });
    await db.insert("preferences", { workspaceId, userId: ownerId, publicId: "preferences", timezone: "UTC",
      workHours: [{ weekday: 0, startMinute: 480, endMinute: 960 }],
      autonomyPolicy: { planApplication: "review", lockManuallyMovedBlocks: true },
      notificationSettings: { enabled: true, webPush: true, native: false },
      importFilters: [{ provider: "linear", connectionId, scopeIds: ["private-scope"] },
        { provider: "github", assignedOnly: true }], ...recordVersion });
    return { ownerId, foreignId, workspaceId };
  });
  return { backend, workspaceId, ownerId, foreignId,
    owner: backend.withIdentity({ subject: ownerId }),
    foreign: backend.withIdentity({ subject: foreignId }) };
}

test("round-trips portable planning records and remaps all relationships into an isolated workspace", async () => {
  const { backend, owner, workspaceId, ownerId } = await setup();
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  expect(archive).toContain('"archivedFromStatus":"waiting"');
  expect(archive).not.toContain(workspaceId);
  expect(archive).not.toContain(ownerId);
  expect(archive).not.toContain("private-occurrence");
  expect(archive).not.toContain("private-");
  expect(archive).not.toContain("connectionId");
  expect(JSON.parse(archive).payload).toMatchObject({
    workspaceName: "Example",
    projects: [{ publicId: "project", board: { laneIds: ["lane"] } }],
    lanes: [{ publicId: "lane", projectId: "project", isDefault: true }],
    tasks: [{ publicId: "task", projectId: "project", laneId: "lane", rank: 0.5, plannedDate: "2026-11-25" }],
    taskSteps: [{ publicId: "step", taskId: "task", completedAt: 2, rank: 0.25 }],
    captures: [{ publicId: "capture", body: "Thought ☕", promotedTaskId: "task" }],
    dayNotes: [{ publicId: "linked-note" }, { publicId: "note", localDate: "2026-11-25", body: "" }],
    dayPlans: [{ publicId: "plan", focusTaskIds: ["task"] }],
    timeBlocks: [{ publicId: "block", taskId: "task", planId: "plan", locked: true }],
    reminders: [{ publicId: "reminder", taskId: "task", state: "snoozed", snoozeUntil: 6, nextTriggerAt: 6,
      recurrence: { kind: "weekly", weekdays: [0, 6] } }],
    externalLinks: [{ publicId: "link", taskId: "task", relationship: "reference" }],
    preferences: [{ publicId: "preferences", timezone: "UTC", notificationSettings: { enabled: true } }],
  });
  const restored = await owner.mutation(restoreWorkspace, restoreArgs(archive));
  expect(restored.workspaceId).not.toBe(workspaceId);
  const reexported = await owner.query(exportWorkspace, { workspaceId: restored.workspaceId });
  expect(reexported.archive).toBe(archive);
  await backend.run(async ({ db }) => {
    const dest = restored.workspaceId;
    const sourceTask = await db.query("tasks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)).unique();
    const task = (await db.query("tasks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", dest)).unique())!;
    expect(task._id).not.toBe(sourceTask?._id);
    expect(task.source?.kind).toBe("capture");
    if (task.source?.kind !== "capture") throw new Error("Missing capture attribution");
    expect(await db.get(task.source.captureId)).toMatchObject({ workspaceId: dest, promotedTaskId: task._id });
    expect(await db.get(task.projectId!)).toMatchObject({ workspaceId: dest, board: { laneIds: [task.laneId] } });
    expect(await db.get(task.laneId!)).toMatchObject({ workspaceId: dest, projectId: task.projectId });
    expect(await db.query("taskSteps").withIndex("by_workspace_task_rank", q => q.eq("workspaceId", dest)).unique())
      .toMatchObject({ taskId: task._id, rank: 0.25, completed: true });
    expect(await db.query("reminderOccurrences").withIndex("by_workspace_due_at", q => q.eq("workspaceId", dest)).collect()).toEqual([]);
    expect(await db.query("externalLinks").withIndex("by_workspace_task", q => q.eq("workspaceId", dest)).unique())
      .toMatchObject({ taskId: task._id, relationship: "reference", externalObjectId: "LINEAR-1" });
    expect(await db.query("integrationConnections").withIndex("by_workspace_public_id", q => q.eq("workspaceId", dest)).collect()).toEqual([]);
    expect(await db.query("preferences").withIndex("by_workspace_user", q => q.eq("workspaceId", dest)).unique())
      .toMatchObject({ userId: ownerId, importFilters: [{ provider: "github", assignedOnly: true }] });
    expect(await db.query("memberships").withIndex("by_workspace_user", q => q.eq("workspaceId", dest)).collect())
      .toMatchObject([{ userId: ownerId, role: "owner" }]);
  });
});

test("requires an owner to export and an authenticated user to restore", async () => {
  const { backend, owner, foreign, workspaceId, foreignId } = await setup();
  await expect(backend.query(exportWorkspace, { workspaceId })).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(foreign.query(exportWorkspace, { workspaceId })).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await backend.run(({ db }) => db.insert("memberships", { workspaceId, userId: foreignId, role: "planner",
    publicId: "planner", ...recordVersion }));
  await expect(foreign.query(exportWorkspace, { workspaceId })).rejects.toThrow(/FORBIDDEN/);
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  await expect(backend.mutation(restoreWorkspace, restoreArgs(archive))).rejects.toThrow(/UNAUTHENTICATED/);
  const restored = await foreign.mutation(restoreWorkspace, restoreArgs(archive));
  await expect(owner.query(exportWorkspace, { workspaceId: restored.workspaceId })).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  expect(await foreign.query(exportWorkspace, { workspaceId: restored.workspaceId })).toEqual({ archive });
});

test("rejects malformed, stale, tampered and oversized archives without publishing a workspace", async () => {
  const { backend, owner, workspaceId } = await setup();
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  const parsed = JSON.parse(archive);
  await expect(owner.mutation(restoreWorkspace, restoreArgs("{"))).rejects.toThrow(/BACKUP_INVALID/);
  await expect(owner.mutation(restoreWorkspace, restoreArgs(JSON.stringify({ ...parsed, version: 0 }))))
    .rejects.toThrow(/BACKUP_VERSION/);
  await expect(owner.mutation(restoreWorkspace, restoreArgs(archive.replace("Thought", "Forged"))))
    .rejects.toThrow(/BACKUP_CHECKSUM/);
  await expect(owner.mutation(restoreWorkspace, restoreArgs(" ".repeat(524_289)))).rejects.toThrow(/BACKUP_LIMIT/);
  await expect(owner.mutation(restoreWorkspace, restoreArgs("☕".repeat(175_000)))).rejects.toThrow(/BACKUP_LIMIT/);
  expect(await backend.run(({ db }) => db.query("workspaces").collect())).toHaveLength(1);
});

async function rechecksum(archive: ReturnType<typeof JSON.parse>) {
  const canonical = JSON.stringify(archive.payload, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  archive.checksum = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify(archive, null, 2);
}

test("rejects correctly checksummed payloads with stale, foreign or malformed relationships", async () => {
  const { owner, backend, workspaceId, foreignId } = await setup();
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  const otherTask = await backend.run(async ({ db }) => {
    const otherWorkspace = await db.insert("workspaces", { ownerId: foreignId,
      name: "Other", publicId: "other", ...recordVersion });
    return db.insert("tasks", taskRecord(otherWorkspace, "foreign-task"));
  });
  for (const invalidId of ["deleted-task", "foreign-task", otherTask]) {
    const envelope = JSON.parse(archive);
    envelope.payload.externalLinks[0].taskId = invalidId;
    await expect(owner.mutation(restoreWorkspace, restoreArgs(await rechecksum(envelope))))
      .rejects.toThrow(/BACKUP_RELATIONSHIP/);
  }
  const malformed = JSON.parse(archive);
  malformed.payload.tasks[0].deadline = { kind: "date", date: "2026-02-30" };
  await expect(owner.mutation(restoreWorkspace, restoreArgs(await rechecksum(malformed)))).rejects.toThrow(/BACKUP_INVALID/);
  const ambiguous = JSON.parse(archive);
  ambiguous.payload.tasks.push(ambiguous.payload.tasks[0]);
  await expect(owner.mutation(restoreWorkspace, restoreArgs(await rechecksum(ambiguous)))).rejects.toThrow(/BACKUP_RELATIONSHIP/);
  const wrongProject = JSON.parse(archive);
  const project = wrongProject.payload.projects[0];
  wrongProject.payload.projects.push({ ...project, publicId: "other-project", board: { laneIds: [] } });
  wrongProject.payload.tasks[0].projectId = "other-project";
  await expect(owner.mutation(restoreWorkspace, restoreArgs(await rechecksum(wrongProject))))
    .rejects.toThrow(/BACKUP_RELATIONSHIP/);
  expect(await backend.run(({ db }) => db.query("workspaces").collect())).toHaveLength(2);

  await backend.run(async ({ db }) => {
    const link = (await db.query("externalLinks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)).unique())!;
    await db.patch(link._id, { taskId: otherTask });
  });
  await expect(owner.query(exportWorkspace, { workspaceId })).rejects.toThrow(/BACKUP_RELATIONSHIP/);
  await backend.run(({ db }) => db.delete(otherTask));
  await expect(owner.query(exportWorkspace, { workspaceId })).rejects.toThrow(/BACKUP_RELATIONSHIP/);
});

test("bounds record count in both directions without silently truncating", async () => {
  const { owner, backend, workspaceId } = await setup();
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  const envelope = JSON.parse(archive);
  const task = envelope.payload.tasks[0];
  envelope.payload.tasks = Array.from({ length: 500 }, (_, i) => ({ ...task, publicId: `task-${i}` }));
  await expect(owner.mutation(restoreWorkspace, restoreArgs(await rechecksum(envelope)))).rejects.toThrow(/BACKUP_LIMIT/);
  expect(await backend.run(({ db }) => db.query("workspaces").collect())).toHaveLength(1);

  await backend.run(async ({ db }) => {
    for (let i = 0; i < 500; i++) await db.insert("tasks", taskRecord(workspaceId, `extra-${i}`));
  });
  await expect(owner.query(exportWorkspace, { workspaceId })).rejects.toThrow(/BACKUP_LIMIT/);
});

test("restore replays safely after rejection, concurrent retries and a lost response", async () => {
  const { owner, backend, workspaceId, foreign } = await setup();
  const { archive } = await owner.query(exportWorkspace, { workspaceId });
  const args = restoreArgs(archive);
  await expect(owner.mutation(restoreWorkspace, { ...args, operationId: "not-a-uuid" })).rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(owner.mutation(restoreWorkspace, { ...args, archive: archive.replace("Thought", "Forged") }))
    .rejects.toThrow(/BACKUP_CHECKSUM/);
  expect(await backend.run(({ db }) => db.query("operationReceipts").collect())).toEqual([]);

  const [, retry] = await Promise.all([
    owner.mutation(restoreWorkspace, args),
    owner.mutation(restoreWorkspace, args),
  ]);
  const reformatted = JSON.stringify(JSON.parse(archive), null, 2);
  expect(await owner.mutation(restoreWorkspace, { ...args, archive: reformatted })).toEqual(retry);

  const changed = JSON.parse(archive);
  changed.payload.workspaceName = "Changed";
  await expect(owner.mutation(restoreWorkspace, { ...args, archive: await rechecksum(changed) }))
    .rejects.toThrow(/OPERATION_ID_CONFLICT/);
  await backend.run(async ({ db }) => {
    expect(await db.query("workspaces").collect()).toHaveLength(2);
    const receipt = await db.query("operationReceipts").unique();
    expect(receipt).toMatchObject({ workspaceId, operationId: args.operationId, result: {
      target: { kind: "workspace", id: retry.workspaceId }, targetPublicId: retry.workspacePublicId,
    } });
  });

  expect((await owner.mutation(restoreWorkspace, restoreArgs(archive))).workspaceId).not.toBe(retry.workspaceId);
  expect((await foreign.mutation(restoreWorkspace, args)).workspaceId).not.toBe(retry.workspaceId);
});
