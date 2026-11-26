import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

test("manual links stay task-scoped, cannot overwrite managed references and retain retired IDs", async () => {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
    "../convex/links.ts": () => import("../convex/links"),
  } });
  const [a,b] = await t.run(async ({ db }) => [await db.insert("users", {}), await db.insert("users", {})]);
  const alice = t.withIdentity({ subject: a });
  const bob = t.withIdentity({ subject: b });
  const { _id: workspaceId } = await alice.mutation(anyApi.workspaces.ensurePersonal, {});
  const { _id: otherId } = await bob.mutation(anyApi.workspaces.ensurePersonal, {});
  const taskId = await t.run(({ db }) => db.insert("tasks", taskRecord(workspaceId, "first")));
  const secondTaskId = await t.run(({ db }) => db.insert("tasks", taskRecord(workspaceId, "second")));
  const create = { kind: "link.add", publicId: "link-a", url: "https://example.com/docs", label: "Notes" };
  const call = (command: object, id = taskId, operationId = crypto.randomUUID()) =>
    alice.mutation(anyApi.links.apply, { workspaceId, taskId: id, operationId, command });
  const operationId = crypto.randomUUID();
  const added = await call(create, taskId, operationId);
  expect(await call(create, taskId, operationId)).toEqual(added);
  await expect(call(create, secondTaskId, operationId)).rejects.toThrow(/OPERATION_ID_CONFLICT/);
  const page = { workspaceId, taskId, paginationOpts: { numItems: 10, cursor: null } };
  expect((await alice.query(anyApi.links.list, page)).page).toMatchObject([{ label: "Notes", relationship: "reference", editable: true }]);
  await expect(bob.query(anyApi.links.list, { ...page, workspaceId: otherId })).rejects.toThrow(/NOT_FOUND/);
  await expect(call({ ...create, publicId: "invalid", url: "javascript:void(0)" })).rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(call({ ...create, publicId: "invalid", url: "https://account:password@example.com" })).rejects.toThrow(/INVALID_ARGUMENT/);
  await call({ ...create, publicId: "link-b" }, secondTaskId);
  await expect(call({ kind: "link.remove", publicId: "link-b", expectedRevision: 1 })).rejects.toThrow(/NOT_FOUND/);
  await call({ kind: "link.edit", publicId: "link-a", url: "https://example.com/new", label: "Edit", expectedRevision: 1 });
  await expect(call({ kind: "link.remove", publicId: "link-a", expectedRevision: 1 })).rejects.toThrow(/REVISION_CONFLICT/);
  await call({ kind: "link.remove", publicId: "link-a", expectedRevision: 2 });
  expect((await alice.query(anyApi.links.list, page)).page).toHaveLength(0);
  await expect(call(create)).rejects.toThrow(/ALREADY_EXISTS/);
  await t.run(({ db }) => db.insert("externalLinks", { workspaceId, taskId, provider: "linear", externalObjectId: "issue",
    relationship: "managed_mirror", publicId: "managed", revision: 1, createdAt: 1, updatedAt: 1 }));
  await expect(call({ kind: "link.remove", publicId: "managed", expectedRevision: 1 })).rejects.toThrow(/MANAGED_LINK/);
  await t.run(({ db }) => db.insert("externalLinks", { workspaceId, taskId, provider: "obsidian",
    relationship: "reference", publicId: "imported", revision: 1, createdAt: 1, updatedAt: 1 }));
  expect((await alice.query(anyApi.links.list, page)).page.every((link: {editable: boolean}) => link.editable === false)).toBe(true);
  await expect(call({ kind: "link.remove", publicId: "imported", expectedRevision: 1 })).rejects.toThrow(/MANAGED_LINK/);
});
