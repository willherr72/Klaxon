import { expect, test } from "vitest";
import { applyTaskDomainCommand, type TaskDomainCommand } from "../convex/model/taskDomain";
import { taskByPublicId } from "../convex/model/reads";
import { insertProject, insertWorkspace, recordVersion, taskRecord, testBackend } from "./fixtures";

async function setup() {
  const t = testBackend();
  const [alpha, beta] = await t.run(async ({ db }) => [
    await insertWorkspace(db, "alpha"), await insertWorkspace(db, "beta"),
  ]);
  const apply = (command: TaskDomainCommand, workspaceId = alpha) =>
    t.run(({ db }) => applyTaskDomainCommand(db, workspaceId, command));
  const read = (publicId: string) => t.query(({ db }) => taskByPublicId(db, alpha, publicId));
  return { t, alpha, beta, apply, read };
}

test("updates planning dates, priority and rank independently of the deadline", async () => {
  const { apply, read } = await setup();
  const created = await apply({
    kind: "task.create", publicId: "work", title: "  File paperwork  ",
    plannedDate: "2028-02-29", deadline: { kind: "date", date: "2028-02-20" },
  });
  expect(created).toMatchObject({ target: { kind: "task" }, targetPublicId: "work", revision: 1 });
  const before = await read("work");
  expect(before).toMatchObject({ title: "File paperwork", status: "inbox" });
  expect(before?.createdAt).toBeGreaterThan(1);

  expect(await apply({
    kind: "task.update", publicId: "work", expectedRevision: 1,
    patch: { plannedDate: null, priority: "urgent", rank: -2.5, status: "waiting", followUpDate: "2028-03-01" },
  })).toEqual({ ...created, revision: 2 });
  expect(await read("work")).toMatchObject({
    createdAt: before?.createdAt, priority: "urgent", rank: -2.5, status: "waiting",
    followUpDate: "2028-03-01", deadline: { kind: "date", date: "2028-02-20" },
  });
  expect(await read("work")).not.toHaveProperty("plannedDate");
});

test("archives completed tasks, restores completion, then reopens to ready", async () => {
  const { apply, read } = await setup();
  await apply({ kind: "task.create", publicId: "work", title: "File paperwork", status: "done" });
  const completed = await read("work");
  expect(completed?.completedAt).toBe(completed?.createdAt);

  await apply({ kind: "task.archive", publicId: "work", expectedRevision: 1 });
  const archived = await read("work");
  expect(archived).toMatchObject({ status: "archived", completedAt: completed?.completedAt, revision: 2 });
  expect(archived?.archivedAt).toBe(archived?.updatedAt);

  await apply({ kind: "task.restore", publicId: "work", expectedRevision: 2 });
  expect(await read("work")).toMatchObject({ status: "done", completedAt: completed?.completedAt, revision: 3 });
  expect(await read("work")).not.toHaveProperty("archivedAt");

  await apply({ kind: "task.reopen", publicId: "work", expectedRevision: 3 });
  expect(await read("work")).toMatchObject({ status: "ready", revision: 4 });
  expect(await read("work")).not.toHaveProperty("completedAt");
});

test("restores waiting status and follow-up details after archive", async () => {
  const { apply, read } = await setup();
  await apply({ kind: "task.create", publicId: "wait", title: "Wait for form", status: "waiting",
    waitingReason: "Requested form", followUpDate: "2028-03-01" });
  await apply({ kind: "task.archive", publicId: "wait", expectedRevision: 1 });
  await apply({ kind: "task.restore", publicId: "wait", expectedRevision: 2 });

  const restored = await read("wait");
  expect(restored).toMatchObject({ status: "waiting", waitingReason: "Requested form", followUpDate: "2028-03-01" });
  expect(restored).not.toHaveProperty("archivedFromStatus");
});

test("restores imported completed status when the completion time is unknown", async () => {
  const { t, alpha, apply, read } = await setup();
  await t.run(({ db }) => db.insert("tasks", taskRecord(alpha, "legacy", { status: "done" })));
  await apply({ kind: "task.archive", publicId: "legacy", expectedRevision: 1 });
  await apply({ kind: "task.restore", publicId: "legacy", expectedRevision: 2 });

  const restored = await read("legacy");
  expect(restored).toMatchObject({ status: "done" });
  expect(restored).not.toHaveProperty("completedAt");
});

test.each([[undefined, "ready"], [3, "done"]] as const)(
  "restores older archived rows with completion time %s to %s",
  async (completedAt, status) => {
    const { t, alpha, apply, read } = await setup();
    await t.run(({ db }) => db.insert("tasks", taskRecord(alpha, "older-archive", {
      status: "archived", archivedAt: 4, completedAt,
    })));
    await apply({ kind: "task.restore", publicId: "older-archive", expectedRevision: 1 });

    expect(await read("older-archive")).toMatchObject({ status });
    expect(await read("older-archive")).not.toHaveProperty("archivedAt");
  },
);

test("updates a project and archives it while preserving assigned tasks", async () => {
  const { t, apply, read } = await setup();
  const { target } = await apply({ kind: "project.create", publicId: "p", name: "Preparation", area: "Work" });
  if (target.kind !== "project") throw new Error("Expected a project result");
  await apply({ kind: "task.create", publicId: "work", title: "File paperwork", projectId: target.id });
  await apply({ kind: "project.update", publicId: "p", expectedRevision: 1,
    patch: { name: "Follow up", rank: 7, area: null } });
  await apply({ kind: "project.archive", publicId: "p", expectedRevision: 2 });
  const archived = await t.query(({ db }) => db.get("projects", target.id));
  expect(archived).toMatchObject({ name: "Follow up", rank: 7, revision: 3, archivedAt: expect.any(Number) });
  expect(archived).not.toHaveProperty("area");
  expect(await read("work")).toMatchObject({ projectId: target.id, revision: 1 });
  await apply({ kind: "project.restore", publicId: "p", expectedRevision: 3 });
  expect(await t.query(({ db }) => db.get("projects", target.id))).not.toHaveProperty("archivedAt");
});

test("adds, reorders, completes and removes a step without changing its parent task", async () => {
  const { t, apply, read } = await setup();
  const task = await apply({ kind: "task.create", publicId: "work", title: "File paperwork" });
  if (task.target.kind !== "task") throw new Error("Expected a task result");
  const step = await apply({ kind: "step.create", publicId: "step", taskId: task.target.id, title: "Find form" });
  const target = step.target;
  if (target.kind !== "task_step") throw new Error("Expected a step result");
  const readStep = () => t.query(({ db }) => db.get("taskSteps", target.id));
  await apply({ kind: "step.update", publicId: "step", expectedRevision: 1,
    patch: { completed: true, rank: 1.5, title: "Find the latest form" } });
  const completed = await readStep();
  expect(completed).toMatchObject({ completed: true, rank: 1.5, title: "Find the latest form", revision: 2 });
  expect(completed?.completedAt).toBe(completed?.updatedAt);

  await apply({ kind: "step.update", publicId: "step", expectedRevision: 2, patch: { completed: false } });
  expect(await readStep()).not.toHaveProperty("completedAt");
  expect(await apply({ kind: "step.delete", publicId: "step", expectedRevision: 3 }))
    .toEqual({ ...step, revision: 4 });
  expect(await readStep()).toBeNull();
  if (step.target.kind !== "task_step") throw new Error("Expected a step result");
  const originalTask = await read("work");
  if (!originalTask) throw new Error("Expected original task");
  await expect(apply({ kind: "step.create", publicId: "step", taskId: originalTask._id, title: "Replacement" }))
    .rejects.toThrow(/ALREADY_EXISTS/);
  expect(await read("work")).toMatchObject({ status: "inbox", revision: 1 });
});

test("a project-specific lane cannot be assigned to another project or its task", async () => {
  const { t, alpha, apply } = await setup();
  const { own, other, lane } = await t.run(async ({ db }) => {
    const own = await insertProject(db, alpha, "one");
    const other = await insertProject(db, alpha, "two");
    const lane = await db.insert("lanes", { ...recordVersion, workspaceId: alpha, publicId: "lane",
      name: "Work", projectId: own, rank: 1, isDefault: false });
    return { own, other, lane };
  });
  await apply({ kind: "task.create", publicId: "work", title: "Work", projectId: own, laneId: lane });
  await expect(apply({ kind: "task.update", publicId: "work", expectedRevision: 1, patch: { projectId: other } }))
    .rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(apply({ kind: "project.update", publicId: "two", expectedRevision: 1,
    patch: { board: { laneIds: [lane] } } })).rejects.toThrow(/INVALID_ARGUMENT/);
  await apply({ kind: "task.update", publicId: "work", expectedRevision: 1, patch: { projectId: other, laneId: null } });
});

test("appends new steps by default in insertion order", async () => {
  const { t, alpha, apply } = await setup();
  const { target } = await apply({ kind: "task.create", publicId: "work", title: "File paperwork" });
  if (target.kind !== "task") throw new Error("Expected a task result");
  await apply({ kind: "step.create", publicId: "z-first", taskId: target.id, title: "Find form", rank: 6.5 });
  await apply({ kind: "step.create", publicId: "a-last", taskId: target.id, title: "Send form" });
  const steps = await t.query(({ db }) => db.query("taskSteps").withIndex("by_workspace_task_rank", q =>
    q.eq("workspaceId", alpha).eq("taskId", target.id)).collect());

  expect(steps.map(step => step.publicId)).toEqual(["z-first", "a-last"]);
});

test("editing legacy completed work preserves an unknown completion time", async () => {
  const { t, alpha, apply, read } = await setup();
  const stepId = await t.run(async ({ db }) => {
    const taskId = await db.insert("tasks", taskRecord(alpha, "legacy", { status: "done" }));
    return db.insert("taskSteps", {
      ...recordVersion, workspaceId: alpha, taskId, publicId: "legacy-step", title: "Original", rank: 1, completed: true,
    });
  });
  await apply({ kind: "task.update", publicId: "legacy", expectedRevision: 1, patch: { status: "done", title: "Renamed" } });
  await apply({ kind: "step.update", publicId: "legacy-step", expectedRevision: 1,
    patch: { completed: true, title: "Renamed" } });

  expect(await read("legacy")).not.toHaveProperty("completedAt");
  expect(await t.query(({ db }) => db.get("taskSteps", stepId))).not.toHaveProperty("completedAt");
});

test("scopes stable IDs by workspace and refuses duplicate live tasks", async () => {
  const { apply, beta, read } = await setup();
  const command = { kind: "task.create", publicId: "shared", title: "First" } as const;
  const first = await apply(command);
  const second = await apply(command, beta);
  expect(second.target.id).not.toBe(first.target.id);
  await expect(apply({ ...command, title: "Duplicate" })).rejects.toThrow(/ALREADY_EXISTS/);
  expect(await read("shared")).toMatchObject({ title: "First", revision: 1 });
});

test("rejects stale revisions with the current revision and rolls back earlier writes", async () => {
  const { t, apply, alpha, read } = await setup();
  await apply({ kind: "task.create", publicId: "work", title: "First" });
  await expect(t.run(async ({ db }) => {
    await applyTaskDomainCommand(db, alpha, {
      kind: "task.update", publicId: "work", expectedRevision: 1, patch: { title: "Temporary" },
    });
    await applyTaskDomainCommand(db, alpha, { kind: "task.archive", publicId: "work", expectedRevision: 1 });
  })).rejects.toMatchObject({ data: { code: "REVISION_CONFLICT", currentRevision: 2 } });
  expect(await read("work")).toMatchObject({ title: "First", revision: 1, status: "inbox" });
});

test("rejects cross-workspace task, lane, project and board references", async () => {
  const { t, alpha, beta, apply, read } = await setup();
  const { taskId, projectId, laneId } = await t.run(async ({ db }) => {
    const projectId = await insertProject(db, beta, "foreign-project");
    const laneId = await db.insert("lanes", {
      workspaceId: beta, publicId: "foreign-lane", name: "Foreign", rank: 0,
      isDefault: false, projectId, ...recordVersion,
    });
    const taskId = await db.insert("tasks", taskRecord(beta, "foreign-task"));
    return { taskId, projectId, laneId };
  });
  await apply({ kind: "task.create", publicId: "work", title: "Safe" });
  for (const command of [
    { kind: "task.update", publicId: "work", expectedRevision: 1, patch: { projectId } },
    { kind: "task.update", publicId: "work", expectedRevision: 1, patch: { laneId } },
    { kind: "task.archive", publicId: "foreign-task", expectedRevision: 1 },
    { kind: "step.create", publicId: "step", taskId, title: "Foreign" },
    { kind: "project.create", publicId: "board", name: "Foreign", board: { laneIds: [laneId] } },
  ] satisfies TaskDomainCommand[]) {
    await expect(apply(command, alpha)).rejects.toThrow(/NOT_FOUND/);
  }
  expect(await read("work")).toMatchObject({ title: "Safe", revision: 1 });
});

test.each([
  { title: "  " },
  { title: "x".repeat(10_000) },
  { rank: Number.POSITIVE_INFINITY },
  { plannedDate: "2027-02-29" },
  { followUpDate: "2027-04-31" },
  { deadline: { kind: "date", date: "2027-04-31" } },
  { deadline: { kind: "instant", at: 1.5 } },
  { deadline: { kind: "instant", at: 0, timezone: "+02:00" } },
  { estimateMinutes: -1 },
  { tags: Array(1000).fill("tag") },
] as const)("rejects invalid task input %# without persisting the task", async (invalid) => {
  const { apply, read } = await setup();
  await expect(apply({ kind: "task.create", publicId: "invalid", title: "File paperwork", ...invalid }))
    .rejects.toThrow(/INVALID_ARGUMENT/);
  expect(await read("invalid")).toBeNull();
});
