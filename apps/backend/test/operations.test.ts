import { expect, test } from "vitest";
import { requireExpectedRevision, runOperation, type OperationRequest } from "../convex/model/operations";
import { insertWorkspace, taskRecord, testBackend } from "./fixtures";

const operationId = "2c28c7dc-b992-4ce0-9b9c-ad748d156587";
const title = "A private task title";

async function setup() {
  const t = testBackend();
  const { workspace, taskId, userId } = await t.run(async ({ db }) => {
    const id = await insertWorkspace(db, "alpha");
    const workspace = (await db.get(id))!;
    const taskId = await db.insert("tasks", taskRecord(id, "task-public-id"));
    return { workspace, taskId, userId: workspace.ownerId };
  });
  const request = {
    workspace,
    actor: { kind: "user", userId },
    origin: "app",
    action: "update_task",
    operationId,
    targetPublicId: "task-public-id",
    expectedRevision: 1,
    input: { title, metadata: { first: 1, second: 2 } },
  } satisfies OperationRequest;

  function update(overrides: Partial<OperationRequest> = {}, fail?: "domain" | "transaction") {
    return t.mutation(async ({ db }) => {
      const result = await runOperation(db, { ...request, ...overrides }, async ({ db, expectedRevision, now }) => {
        const task = (await db.get(taskId))!;
        requireExpectedRevision(expectedRevision!, task.revision);
        const revision = task.revision + 1;
        await db.patch(taskId, { title, revision, updatedAt: now });
        if (fail === "domain") throw new Error("Failed after updating task");
        return { target: { kind: "task", id: taskId }, targetPublicId: task.publicId, beforeRevision: task.revision, revision };
      });
      if (fail === "transaction") throw new Error("Failed after writing audit and receipt");
      return result;
    });
  }

  async function snapshot() {
    return t.query(async ({ db }) => ({
      task: await db.get(taskId),
      receipts: await db.query("operationReceipts").collect(),
      activity: await db.query("activityEvents").collect(),
    }));
  }

  return { t, request, update, snapshot };
}

test("concurrent matching retries commit one change and return the original result", async () => {
  const { request, update, snapshot } = await setup();
  const [first, second] = await Promise.all([
    update(),
    update({ input: { metadata: { second: 2, first: 1 }, title } }),
  ]);
  expect(first).toEqual(second);
  expect(first).toEqual({ workspacePublicId: "alpha", targetPublicId: "task-public-id", revision: 2, activityEventId: expect.any(String) });

  await update({ operationId: "7c28c7dc-b992-4ce0-9b9c-ad748d156587", expectedRevision: 2 });
  expect(await update()).toEqual(first);

  const { task, receipts, activity } = await snapshot();
  expect(task).toMatchObject({ title, revision: 3 });
  expect(receipts).toHaveLength(2);
  expect(activity).toHaveLength(2);
  const receipt = receipts.find(row => row.operationId === operationId);
  const event = activity.find(row => row._id === first.activityEventId);
  expect(receipt).toMatchObject({
    inputFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    result: { targetPublicId: first.targetPublicId, revision: first.revision, activityEventId: first.activityEventId },
  });
  expect(event).toMatchObject({
    actor: request.actor, action: request.action, origin: request.origin, operationId,
    targetPublicId: first.targetPublicId, outcome: "applied", beforeRevision: 1, afterRevision: 2,
  });
  expect(JSON.stringify([receipt, event])).not.toContain(title);
});

test("preserves signed zero in numeric Convex input fingerprints", async () => {
  const { update } = await setup();
  await update({ input: { rank: -0 } });
  await expect(update({ input: { rank: 0 } })).rejects.toThrow(/OPERATION_ID_CONFLICT/);
});

test("rejects reuse with a different action, target, expected revision, or payload", async () => {
  const { update, snapshot } = await setup();
  await update();
  for (const change of [
    { action: "complete_task" },
    { targetPublicId: "different-task" },
    { expectedRevision: 2 },
    { input: { title: "Different title" } },
  ]) {
    await expect(update(change)).rejects.toMatchObject({ data: { code: "OPERATION_ID_CONFLICT" } });
  }
  const { task, receipts, activity } = await snapshot();
  expect(task?.revision).toBe(2);
  expect(receipts).toHaveLength(1);
  expect(activity).toHaveLength(1);
});

test.each(["domain", "transaction"] as const)("rolls back a failed %s and permits retry", async (failure) => {
  const { update, snapshot } = await setup();
  const before = await snapshot();
  await expect(update({}, failure)).rejects.toThrow("Failed after");
  expect(await snapshot()).toEqual(before);
  expect(await update()).toMatchObject({ revision: 2 });
});

test("isolates the same operation ID across actors and workspaces", async () => {
  const { t, request, snapshot } = await setup();
  const { otherUserId, otherWorkspace } = await t.run(async ({ db }) => {
    const otherUserId = await db.insert("users", {});
    const otherWorkspace = (await db.get(await insertWorkspace(db, "beta")))!;
    return { otherUserId, otherWorkspace };
  });
  const create = (workspace: OperationRequest["workspace"], actor: OperationRequest["actor"], publicId: string) =>
    t.mutation(({ db }) => runOperation(db, {
      workspace, actor, origin: "app", action: "create_task", operationId, input: { title },
    }, async ({ db }) => {
      const id = await db.insert("tasks", taskRecord(workspace._id, publicId, { title }));
      return { target: { kind: "task", id }, targetPublicId: publicId, revision: 1 };
    }));

  const otherActor = { kind: "user", userId: otherUserId } as const;
  const first = await create(request.workspace, request.actor, "created-first");
  const second = await create(request.workspace, otherActor, "created-second");
  const third = await create(otherWorkspace, request.actor, "created-first");
  expect(first.targetPublicId).toBe("created-first");
  expect(second.targetPublicId).toBe("created-second");
  expect(third).toMatchObject({ workspacePublicId: "beta", targetPublicId: "created-first" });
  expect(new Set([first.activityEventId, second.activityEventId, third.activityEventId]).size).toBe(3);
  expect(await create(request.workspace, otherActor, "created-second")).toEqual(second);
  const { receipts, activity } = await snapshot();
  expect(receipts).toHaveLength(3);
  expect(activity).toHaveLength(3);
  expect(new Set(activity.map(event => event.publicId)).size).toBe(3);
});

test("two writes based on the same revision cannot both apply", async () => {
  const { update, snapshot } = await setup();
  const results = await Promise.allSettled([
    update(),
    update({ operationId: "7c28c7dc-b992-4ce0-9b9c-ad748d156587" }),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results).toContainEqual({
    status: "rejected",
    reason: expect.objectContaining({ data: { code: "REVISION_CONFLICT", currentRevision: 2 } }),
  });
  const { task, receipts, activity } = await snapshot();
  expect(task?.revision).toBe(2);
  expect(receipts).toHaveLength(1);
  expect(activity).toHaveLength(1);
});

test("rejects invalid UUIDs, invalid revisions and oversized or deeply nested inputs before writing", async () => {
  const { update, snapshot } = await setup();
  const before = await snapshot();
  for (const invalid of [
    { operationId: "not-a-uuid" },
    { expectedRevision: 0 },
    { expectedRevision: 1.25 },
    { input: { title: "é".repeat(40_000) } },
    { input: { metadata: [...Array(100_000)].fill(0) } },
    { input: Array.from({ length: 40 }).reduce<OperationRequest["input"]>(value => [value], null) },
    { input: { rank: Number.NaN } },
  ]) {
    await expect(update(invalid)).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT" } });
  }
  expect(await snapshot()).toEqual(before);
});
