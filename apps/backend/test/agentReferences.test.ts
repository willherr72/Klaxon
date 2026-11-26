import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

const tokenHash = "a".repeat(64);
const auth = { tokenHash, workspacePublicId: "workspace" };

async function setup() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentCredentials.ts": () => import("../convex/agentCredentials"),
    "../convex/agentReferences.ts": () => import("../convex/agentReferences"),
  } });
  const context = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, auth.workspacePublicId);
    const otherWorkspaceId = await insertWorkspace(db, "other");
    const userId = (await db.get("workspaces", workspaceId))!.ownerId;
    await db.insert("memberships", { workspaceId, userId, role: "owner", publicId: "owner", ...recordVersion });
    const credentialId = await db.insert("agentCredentials", { workspaceId, userId, publicId: "credential",
      label: "Test agent", tokenHash, scopes: ["tasks:read", "tasks:write", "captures:read", "captures:write"],
      expiresAt: Date.now() + 60_000, ...recordVersion });
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "parent"));
    await db.insert("tasks", taskRecord(otherWorkspaceId, "foreign"));
    const connectionId = await db.insert("integrationConnections", { workspaceId, userId,
      provider: "linear", publicId: "connection", accountId: "secret-account", scopeIds: [], state: "active", ...recordVersion });
    await db.insert("externalLinks", { workspaceId, taskId, connectionId, provider: "linear", publicId: "managed",
      relationship: "managed_mirror", externalObjectId: "hidden", canonicalUrl: "https://example.com/private", ...recordVersion });
    await db.insert("captures", { workspaceId: otherWorkspaceId, publicId: "remote", body: "Project transcript",
      tags: [], ...recordVersion });
    return { credentialId, workspaceId, taskId };
  });
  const charge = (scope: "tasks:read" | "tasks:write" | "captures:read" | "captures:write") =>
    t.mutation(anyApi.agentCredentials.chargeAgentRequest, { ...auth, scope });
  return { ...context, t, charge };
}

test("writes and lists portable HTTPS references, excluding managed integration links", async () => {
  const { t, charge, taskId } = await setup();
  const input = { ...auth, publicId: "link", taskPublicId: "parent", expectedRevision: 1,
    operationId: crypto.randomUUID(), reason: "Reference for task", url: "https://example.com", label: " Example " };
  const create = async (patch: Record<string, unknown> = {}) => {
    await charge("tasks:write");
    return t.mutation(anyApi.agentReferences.link, { ...input, ...patch });
  };
  await expect(create({ url: "https://user:pass@example.com" })).rejects.toThrow("INVALID_ARGUMENT");
  await expect(create({ expectedRevision: 2 })).rejects.toThrow("REVISION_CONFLICT");
  await expect(create({ taskPublicId: "foreign" })).rejects.toThrow("NOT_FOUND");
  const original = await create();
  expect(original).toMatchObject({ publicId: "link", revision: 1, workspacePublicId: "workspace" });
  await t.run(({ db }) => db.patch("tasks", taskId, { revision: 2 }));
  expect(await create()).toEqual(original);
  await charge("tasks:read");
  await expect(t.query(anyApi.agentReferences.listLinks, { ...auth, taskPublicId: "parent", limit: 1 }))
    .resolves.toEqual({ items: [{ publicId: "link", taskPublicId: "parent", revision: 1, url: "https://example.com/",
      label: "Example" }], nextCursor: null });
  await charge("tasks:read");
  await expect(t.query(anyApi.agentReferences.listLinks, { ...auth, taskPublicId: "parent", cursor: "wrong-cursor" }))
    .rejects.toThrow(/INVALID_ARGUMENT/);
  const events = await t.run(({ db }) => db.query("activityEvents").collect());
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ reason: input.reason, origin: "api", action: "link.add" });
});

test("records the actual agent capture source and checks scope before searching bounded workspace data", async () => {
  const { t, charge, credentialId, workspaceId } = await setup();
  const args = { ...auth, publicId: "capture", operationId: crypto.randomUUID(), reason: "Preserve handoff note",
    body: "  Project transcript  ", tags: ["handoff"], origin: "mcp" };
  await charge("captures:write");
  const receipt = await t.mutation(anyApi.agentReferences.createCapture, args);
  await charge("captures:write");
  expect(await t.mutation(anyApi.agentReferences.createCapture, args)).toEqual(receipt);
  await charge("captures:write");
  await expect(t.mutation(anyApi.agentReferences.createCapture, { ...args, body: "Different note" }))
    .rejects.toThrow("OPERATION_ID_CONFLICT");
  await charge("captures:read");
  const { items } = await t.query(anyApi.agentReferences.searchCaptures, { ...auth, text: "transcript" });
  expect(items).toEqual([{ publicId: "capture", revision: 1, body: "Project transcript", tags: ["handoff"],
    archived: false, promoted: false, source: "agent", createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
  await t.run(({ db }) => db.insert("captures", { workspaceId, publicId: "long", tags: [],
    body: `Overflow ${"x".repeat(2_500)}`, ...recordVersion }));
  await charge("captures:read");
  const longPage = await t.query(anyApi.agentReferences.searchCaptures, { ...auth, text: "Overflow" });
  expect(longPage.items[0]).toMatchObject({ publicId: "long", bodyTruncated: true });
  expect(longPage.items[0].body).toHaveLength(2_000);
  await t.run(async ({ db }) => {
    const capture = await db.query("captures").filter(q => q.eq(q.field("publicId"), "capture")).unique();
    expect(capture?.source).toEqual({ kind: "agent", credentialId });
    const activity = await db.query("activityEvents").unique();
    expect(activity).toMatchObject({ reason: args.reason, origin: "mcp", actor: { kind: "agent", credentialId } });
    await db.patch("agentCredentials", credentialId, { scopes: ["tasks:read"] });
  });
  await expect(t.query(anyApi.agentReferences.searchCaptures, { ...auth, text: "transcript" })).rejects.toThrow(/FORBIDDEN/);
});
