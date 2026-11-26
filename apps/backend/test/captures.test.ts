import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function setup() {
  const backend = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/captures.ts": () => import("../convex/captures"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
  const [owner, visitor] = await backend.run(async ({db}) => [await db.insert("users", {}), await db.insert("users", {})]);
  const client = backend.withIdentity({ subject: owner });
  const other = backend.withIdentity({ subject: visitor });
  const { _id: workspaceId } = await client.mutation(anyApi.workspaces.ensurePersonal, {});
  return { backend, client, other, workspaceId };
}

test("quick capture, search and promotion preserve one source across retries", async () => {
  const { backend, client, other, workspaceId } = await setup();
  const args = { workspaceId, operationId: crypto.randomUUID(), command: {
    kind: "capture.create", publicId: "thought", body: "Call the roofer\nAsk about Friday", tags: ["home"],
  }};
  const created = await client.mutation(anyApi.captures.apply, args);
  expect(await client.mutation(anyApi.captures.apply, args)).toEqual(created);
  const page = { workspaceId, paginationOpts: { numItems: 10, cursor: null } };
  const inbox = await client.query(anyApi.captures.list, page);
  expect(inbox.page).toHaveLength(1);
  expect(inbox.page[0]).toMatchObject({ body: args.command.body, source: { kind: "manual" } });
  expect((await client.query(anyApi.captures.search, { ...page, text: "roofer" })).page).toHaveLength(1);
  await expect(other.query(anyApi.captures.search, { ...page, text: "roofer" })).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  const promote = { workspaceId, operationId: crypto.randomUUID(), command: {
    kind: "capture.promote", publicId: "thought", expectedRevision: 1, taskPublicId: "quote", title: "Get roofing quote",
  }};
  const promoted = await client.mutation(anyApi.captures.apply, promote);
  expect(await client.mutation(anyApi.captures.apply, promote)).toEqual(promoted);
  expect((await client.query(anyApi.captures.list, page)).page).toEqual([]);
  await expect(client.mutation(anyApi.captures.apply, { ...promote, operationId: crypto.randomUUID() })).rejects.toThrow(/REVISION_CONFLICT/);
  await backend.run(async ({ db }) => {
    const task = await db.query("tasks").unique();
    expect(task).toMatchObject({ publicId: "quote", status: "inbox", tags: ["home"], description: args.command.body,
      source: { kind: "capture", captureId: inbox.page[0]._id } });
    expect(task?.deadline).toBeUndefined();
    expect(task?.plannedDate).toBeUndefined();
    expect(await db.get(inbox.page[0]._id)).toMatchObject({ promotedTaskId: task?._id, revision: 2 });
  });
});

test("triage retains archived notes and rejects stale edits and promotion collisions", async () => {
  const { backend, client, other, workspaceId } = await setup();
  const apply = (command: object) => client.mutation(anyApi.captures.apply, {
    workspaceId, operationId: crypto.randomUUID(), command,
  });
  const create = { kind: "capture.create", publicId: "ideas", body: "Paint the porch", tags: ["house"] };
  await expect(apply({ ...create, body: "  " })).rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(other.mutation(anyApi.captures.apply, { workspaceId, operationId: crypto.randomUUID(), command: create }))
    .rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await apply(create);
  await apply({ kind: "capture.update", publicId: "ideas", expectedRevision: 1, body: "Paint the fence" });
  await expect(apply({ kind: "capture.archive", publicId: "ideas", expectedRevision: 1 })).rejects.toThrow(/REVISION_CONFLICT/);
  await backend.run(({ db }) => db.insert("tasks", {
    workspaceId, publicId: "painting", title: "Existing project", status: "ready", priority: "none",
    rank: 0, revision: 1, createdAt: 1, updatedAt: 1,
  }));
  await expect(apply({ kind: "capture.promote", publicId: "ideas", expectedRevision: 2, taskPublicId: "painting", title: "Paint" }))
    .rejects.toThrow(/ALREADY_EXISTS/);
  const args = { workspaceId, paginationOpts: { cursor: null, numItems: 5 } };
  expect((await client.query(anyApi.captures.list, args)).page[0]).toMatchObject({ revision: 2, tags: ["house"] });
  await apply({ kind: "capture.archive", publicId: "ideas", expectedRevision: 2 });
  expect((await client.query(anyApi.captures.list, args)).page).toEqual([]);
  expect((await client.query(anyApi.captures.search, { ...args, text: "fence" })).page[0])
    .toMatchObject({ publicId: "ideas", revision: 3 });
});
