import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { createAgentTask, getAgentTask, listAgentTasks, updateAgentTask } from "../convex/model/agentTasks";
import schema from "../convex/schema";
import { insertProject, insertWorkspace, recordVersion, taskRecord, testBackend } from "./fixtures";

const operationId = "b635193d-2689-4f94-9610-0d637767dcbb";
const updateId = "49889a6a-9636-435b-98d5-541ad388b8a1";
const reason = "Requested during weekly review";

async function setup() {
  const t = testBackend();
  const [workspace, actor, otherWorkspace] = await t.run(async ({ db }) => {
    const workspace = (await db.get("workspaces", await insertWorkspace(db, "workspace")))!;
    const otherWorkspace = await insertWorkspace(db, "other");
    const credentialId = await db.insert("agentCredentials", {
      workspaceId: workspace._id, userId: workspace.ownerId, publicId: "credential", label: "Reader",
      tokenHash: "fixture", scopes: [], expiresAt: Date.now() + 60_000, ...recordVersion,
    });
    return [workspace, { kind: "agent", credentialId } as const, otherWorkspace] as const;
  });
  const grant = { workspace, actor };
  return { t, workspace, otherWorkspace, grant };
}

test("records a bounded reason in the activity history and replays its portable receipt", async () => {
  const { t, workspace, grant } = await setup();
  const input = { publicId: "task-123", operationId, reason, task: { title: " Prepare sample " } };
  const create = (args = input) => t.run(({ db }) => createAgentTask(db, grant, args));
  const result = await create();
  expect(result).toEqual({ workspacePublicId: "workspace", publicId: "task-123", revision: 1,
    activityEventPublicId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await create()).toEqual(result);
  await expect(create({ ...input, reason: "Changed reason" })).rejects.toThrow("OPERATION_ID_CONFLICT");
  const [task, events] = await t.run(async ({ db }) => [
    await getAgentTask(db, workspace._id, { publicId: "task-123" }),
    await db.query("activityEvents").collect(),
  ]);
  expect(task).toMatchObject({ title: "Prepare sample", revision: 1 });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actor: grant.actor, reason, origin: "api", publicId: result.activityEventPublicId });
});

test("checks expected revisions and shared domain validation before updating", async () => {
  const { t, grant } = await setup();
  await t.run(({ db }) => createAgentTask(db, grant, { publicId: "task-123", operationId, reason, task: { title: "Sample" } }));
  const update = (patch: { plannedDate?: string; title?: string }, expectedRevision = 1, why = reason) =>
    t.run(({ db }) => updateAgentTask(db, grant, { publicId: "task-123", operationId: updateId, reason: why, expectedRevision, patch }));
  await expect(update({ title: "New" }, 1, "  ")).rejects.toThrow("INVALID_ARGUMENT");
  await expect(update({})).rejects.toThrow("INVALID_ARGUMENT");
  await expect(update({ plannedDate: "2027-02-29" })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(update({ title: "New" }, 2)).rejects.toThrow("REVISION_CONFLICT");
  expect(await update({ title: "New" })).toMatchObject({ revision: 2 });
});

test("returns a bounded workspace page containing only portable references", async () => {
  const { t, workspace, otherWorkspace } = await setup();
  await t.run(async ({ db }) => {
    const projectId = await insertProject(db, workspace._id, "project-public");
    await db.insert("tasks", taskRecord(workspace._id, "first", { projectId }));
    await db.insert("tasks", taskRecord(workspace._id, "second", { projectId }));
    await db.insert("tasks", taskRecord(otherWorkspace, "third"));
  });
  const filter = { kind: "project", projectPublicId: "project-public" } as const;
  const list = (limit: number, cursor?: string) =>
    t.run(({ db }) => listAgentTasks(db, workspace._id, { filter, limit, cursor }));
  const first = await list(1);
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ publicId: "first", projectPublicId: "project-public" });
  expect(first.items[0]).not.toHaveProperty("_id");
  expect(first.items[0]).not.toHaveProperty("projectId");
  expect(first.items[0]).not.toHaveProperty("workspaceId");
  expect(first.nextCursor).toBeTruthy();
  expect((await list(1, first.nextCursor!)).items.map(task => task.publicId)).toEqual(["second"]);
  await expect(list(51)).rejects.toThrow("INVALID_ARGUMENT");
  await expect(list(1, "malformed-cursor")).rejects.toThrow("INVALID_ARGUMENT");
  await expect(t.run(({ db }) => getAgentTask(db, workspace._id, { publicId: "third" }))).rejects.toThrow("NOT_FOUND");
});

test("a charged grant is rechecked for revocation before returning a replay receipt", async () => {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentCredentials.ts": () => import("../convex/agentCredentials"),
    "../convex/agentTasks.ts": () => import("../convex/agentTasks"),
  } });
  const tokenHash = "a".repeat(64);
  const workspacePublicId = "agent-workspace";
  const credentialId = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, workspacePublicId);
    const { ownerId: userId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId, role: "owner", publicId: "owner", ...recordVersion });
    return db.insert("agentCredentials", { workspaceId, userId, label: "Test agent", publicId: "registered",
      scopes: ["tasks:write"], tokenHash, expiresAt: Date.now() + 60_000, ...recordVersion });
  });
  const auth = { tokenHash, workspacePublicId };
  const charge = () => t.mutation(anyApi.agentCredentials.chargeAgentRequest, { ...auth, scope: "tasks:write" });
  const create = () => t.mutation(anyApi.agentTasks.create, {
    ...auth, publicId: "registered-task", operationId, reason, task: { title: "Registered" },
  });

  await charge();
  expect(await create()).toMatchObject({ revision: 1 });
  await charge();
  await t.run(({ db }) => db.patch("agentCredentials", credentialId, { revokedAt: Date.now() }));
  await expect(create()).rejects.toThrow("AGENT_UNAUTHORIZED");
});
