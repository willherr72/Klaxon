import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { taskRecord } from "./fixtures";

// Isolate membership policy from provider verification. The live provider test
// exercises the session-to-user lookup and revocation with signed tokens.
vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

function endpointBackend() {
  return convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/tasks.ts": () => import("../convex/tasks"),
    "../convex/projects.ts": () => import("../convex/projects"),
    "../convex/steps.ts": () => import("../convex/steps"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
}

test("registered queries return the caller's rows and reject a foreign workspace or an absent session", async () => {
  const t = endpointBackend();
  const [aliceId, bobId] = await t.run(async ({ db }) => [await db.insert("users", {}), await db.insert("users", {})]);
  const alice = t.withIdentity({ subject: aliceId });
  const bob = t.withIdentity({ subject: bobId });
  const personal = await alice.mutation(anyApi.workspaces.ensurePersonal, {});
  await bob.mutation(anyApi.workspaces.ensurePersonal, {});
  await t.run(({ db }) => db.insert("tasks", taskRecord(personal._id, "task-1")));
  const paginationOpts = { cursor: null, numItems: 5 };
  const args = { workspaceId: personal._id, filter: { kind: "status", status: "ready" }, paginationOpts };
  expect((await alice.query(anyApi.tasks.list, args)).page.map((row: { publicId: string }) => row.publicId)).toEqual(["task-1"]);
  expect((await alice.query(anyApi.workspaces.list, { paginationOpts })).page).toHaveLength(1);
  await expect(bob.query(anyApi.tasks.list, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await expect(bob.query(anyApi.tasks.get, { workspaceId: personal._id, publicId: "task-1" })).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await expect(t.query(anyApi.tasks.list, args)).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(t.mutation(anyApi.workspaces.ensurePersonal, {})).rejects.toThrow(/UNAUTHENTICATED/);
});

test("projects and ordered steps can be read back from their workspace", async () => {
  const t = endpointBackend();
  const userId = await t.run(({ db }) => db.insert("users", {}));
  const user = t.withIdentity({ subject: userId });
  const { _id: workspaceId } = await user.mutation(anyApi.workspaces.ensurePersonal, {});
  const apply = (command: Record<string, string | number>) =>
    user.mutation(anyApi.tasks.apply, { workspaceId, operationId: crypto.randomUUID(), command });
  await apply({ kind: "project.create", publicId: "course", name: "Course" });
  const paginationOpts = { cursor: null, numItems: 8 };
  const projects = await user.query(anyApi.projects.list, { workspaceId, paginationOpts });
  expect(projects.page.map((p: { name: string }) => p.name)).toEqual(["Course"]);
  await apply({ kind: "task.create", publicId: "learn", title: "Practice", projectId: projects.page[0]._id });
  const task = await user.query(anyApi.tasks.get, { workspaceId, publicId: "learn" });
  await apply({ kind: "step.create", publicId: "later", taskId: task._id, title: "Review", rank: 2 });
  await apply({ kind: "step.create", publicId: "first", taskId: task._id, title: "Prepare", rank: 1 });
  const steps = await user.query(anyApi.steps.list, { workspaceId, taskId: task._id, paginationOpts });
  expect(steps.page.map((s: { title: string }) => s.title)).toEqual(["Prepare", "Review"]);
});

test("registered writes require current access even when replaying a successful operation", async () => {
  const t = endpointBackend();
  const { owner, planner } = await t.run(async ({ db }) => ({
    owner: await db.insert("users", {}), planner: await db.insert("users", {}),
  }));
  const user = t.withIdentity({ subject: planner });
  const workspace = await t.withIdentity({ subject: owner }).mutation(anyApi.workspaces.ensurePersonal, {});
  const args = { workspaceId: workspace._id, operationId: crypto.randomUUID(),
    command: { kind: "task.create", publicId: "new-task", title: "Plan tomorrow" } };
  await expect(user.mutation(anyApi.tasks.apply, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  const grant = await t.run(({ db }) => db.insert("memberships", {
    workspaceId: workspace._id, userId: planner, publicId: "planner", role: "planner",
    createdAt: 1, updatedAt: 1, revision: 1,
  }));
  const created = await user.mutation(anyApi.tasks.apply, args);
  expect(await user.mutation(anyApi.tasks.apply, args)).toEqual(created);
  await expect(user.mutation(anyApi.tasks.apply, { ...args, command: { ...args.command, title: "Changed" } }))
    .rejects.toThrow(/OPERATION_ID_CONFLICT/);
  await t.run(({ db }) => db.patch(grant, { role: "reader" }));
  await expect(user.mutation(anyApi.tasks.apply, args)).rejects.toThrow(/FORBIDDEN/);
  expect((await user.query(anyApi.tasks.get, { workspaceId: workspace._id, publicId: "new-task" })).title).toBe("Plan tomorrow");
  await t.run(async ({ db }) => {
    expect(await db.query("operationReceipts").collect()).toHaveLength(1);
    expect(await db.query("activityEvents").collect()).toHaveLength(1);
    expect(await db.query("tasks").collect()).toHaveLength(1);
  });
});
