import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function setup(mode: "automatic" | "review" = "review") {
  const modules = {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentPlans.ts": () => import("../convex/agentPlans"),
  };
  const t = convexTest({ schema, modules });
  const workspacePublicId = "plans";
  const tokenHash = "a".repeat(64);
  const anotherTokenHash = "b".repeat(64);
  const { workspaceId, ownerId, credentialId, taskId } = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, workspacePublicId);
    const { ownerId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId: ownerId, role: "owner", publicId: "owner", ...recordVersion });
    await db.insert("preferences", { workspaceId, userId: ownerId, publicId: "settings", ...recordVersion,
      timezone: "UTC", workHours: [{ weekday: 0, startMinute: 540, endMinute: 1020 }], breaks: [], bufferMinutes: 10,
      autonomyPolicy: { planApplication: mode, lockManuallyMovedBlocks: true, discretionaryMinutes: 0 },
      notificationSettings: { enabled: false, native: false, webPush: false }, importFilters: [] });
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "sample", { title: "Write test", estimateMinutes: 30 }));
    const issue = (hash: string, label: string) => db.insert("agentCredentials", {
      workspaceId, userId: ownerId, publicId: label, label, tokenHash: hash, scopes: ["planning:preview", "planning:apply"],
      expiresAt: Date.now() + 600_000, ...recordVersion,
    });
    const [credentialId] = await Promise.all([issue(tokenHash, "Planner"), issue(anotherTokenHash, "Second planner")]);
    return { workspaceId, ownerId, credentialId, taskId };
  });
  const owner = t.withIdentity({ subject: ownerId });
  const reason = "Make time for the selected work";
  const previewArgs = { workspacePublicId, tokenHash, reason, localDate: "2035-01-08", taskPublicIds: ["sample"],
    expectedDayPlanRevision: null, operationId: crypto.randomUUID() };
  const preview = (overrides = {}) => t.mutation(anyApi.agentPlans.preview, { ...previewArgs, ...overrides });
  const apply = (publicId: string, overrides = {}) => t.mutation(anyApi.agentPlans.apply, {
    workspacePublicId, tokenHash, reason, publicId, expectedRevision: 1, operationId: crypto.randomUUID(), ...overrides,
  });
  const pending = () => owner.query(anyApi.agentPlans.pending, { workspaceId });
  const decide = (method: "approve" | "reject", publicId: string, operationId = crypto.randomUUID()) =>
    owner.mutation(anyApi.agentPlans[method], { workspaceId, publicId, expectedRevision: 1, operationId });
  const tables = () => t.run(async ({ db }) => ({
    blocks: await db.query("timeBlocks").collect(), plans: await db.query("dayPlans").collect(),
    events: await db.query("activityEvents").collect(), receipts: await db.query("operationReceipts").collect(),
  }));
  return { t, workspaceId, ownerId, credentialId, taskId, anotherTokenHash, preview, apply, pending, decide, tables };
}

test("a review preview writes no calendar rows and only the owner can commit its proposed placements", async () => {
  const f = await setup();
  expect(await f.pending()).toEqual([]);
  const proposed = await f.preview();
  expect(proposed).toMatchObject({ revision: 1, focusTaskPublicIds: ["sample"], placements: [
    { taskPublicId: "sample", taskTitle: "Write test", action: "add", startAt: Date.parse("2035-01-08T09:00:00Z") },
  ] });
  expect(await f.preview()).toEqual(proposed);
  expect(await f.tables()).toMatchObject({ blocks: [], plans: [] });
  await expect(f.apply(proposed.publicId)).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  await expect(f.apply(proposed.publicId, { tokenHash: f.anotherTokenHash })).rejects.toThrow("PLAN_UNAVAILABLE");
  expect(await f.pending()).toMatchObject([{ publicId: proposed.publicId, agentLabel: "Planner" }]);

  const approvalId = crypto.randomUUID();
  const receipt = await f.decide("approve", proposed.publicId, approvalId);
  expect(receipt).toEqual({ workspacePublicId: "plans", publicId: proposed.publicId,
    revision: 2, activityEventPublicId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.decide("approve", proposed.publicId, approvalId)).toEqual(receipt);
  expect(await f.preview()).toEqual(proposed);
  expect(await f.pending()).toEqual([]);
  const { blocks, events, receipts } = await f.tables();
  expect(blocks).toHaveLength(1);
  expect(blocks[0]).toMatchObject({ taskId: f.taskId, origin: "agent", locked: false });
  expect(receipts).toHaveLength(2);
  expect(events).toMatchObject([{ actor: { kind: "agent", credentialId: f.credentialId }, reason: proposed.reason },
    { actor: { kind: "user" }, action: "planning.approve" }]);
});

test("a stale task prevents every write in an automatic plan application", async () => {
  const f = await setup("automatic");
  const proposed = await f.preview();
  await f.t.run(({ db }) => db.patch("tasks", f.taskId, { revision: 2, title: "Changed" }));
  const before = await f.tables();
  await expect(f.apply(proposed.publicId)).rejects.toThrow("PLAN_CONTEXT_CHANGED");
  expect(await f.tables()).toEqual(before);
});

test("revoking the grant denies automatic receipt replay", async () => {
  const f = await setup("automatic");
  const preview = await f.preview();
  const operationId = crypto.randomUUID();
  expect(await f.apply(preview.publicId, { operationId })).toMatchObject({ publicId: preview.publicId, revision: 2 });
  await f.t.run(({ db }) => db.patch("agentCredentials", f.credentialId, { revokedAt: Date.now() }));
  await expect(f.apply(preview.publicId, { operationId })).rejects.toThrow("AGENT_UNAUTHORIZED");
});

test("the owner can discard a preview and cannot subsequently approve it", async () => {
  const f = await setup();
  const preview = await f.preview();
  expect(await f.decide("reject", preview.publicId)).toMatchObject({ revision: 2 });
  expect(await f.pending()).toEqual([]);
  await expect(f.decide("approve", preview.publicId)).rejects.toThrow("REVISION_CONFLICT");
  expect(await f.tables()).toMatchObject({ blocks: [], plans: [] });
});

test("a newly locked morning block cancels the whole proposed move, addition, and focus update", async () => {
  const f = await setup("automatic");
  const day = "2035-01-08";
  const blockId = await f.t.run(async ({ db }) => {
    await db.insert("tasks", taskRecord(f.workspaceId, "new", { estimateMinutes: 45 }));
    const planId = await db.insert("dayPlans", { workspaceId: f.workspaceId, publicId: "today", timezone: "UTC",
      localDate: day, source: "agent", focusTaskIds: [], ...recordVersion });
    return db.insert("timeBlocks", { workspaceId: f.workspaceId, publicId: "existing", timezone: "UTC",
      localDate: day, origin: "agent", locked: false, taskId: f.taskId, planId,
      startAt: Date.parse(day + "T11:00:00Z"), endAt: Date.parse(day + "T11:30:00Z"), ...recordVersion });
  });
  const proposed = await f.preview({ taskPublicIds: ["sample", "new"], expectedDayPlanRevision: 1 });
  expect(proposed.placements).toMatchObject([
    { action: "add", taskPublicId: "new" },
    { action: "move", blockPublicId: "existing", previousStartAt: Date.parse(day + "T11:00:00Z") },
  ]);
  expect(proposed.focusTaskPublicIds).toEqual(expect.arrayContaining(["sample", "new"]));
  await f.t.run(({ db }) => db.patch("timeBlocks", blockId, { revision: 2, locked: true }));
  const before = await f.tables();
  await expect(f.apply(proposed.publicId)).rejects.toThrow("PLAN_CONTEXT_CHANGED");
  expect(await f.tables()).toEqual(before);
});

test("an expired review preview cannot be applied", async () => {
  const f = await setup();
  const proposed = await f.preview();
  await f.t.run(async ({ db }) => {
    const row = (await db.query("planRevisions").unique())!;
    await db.patch("planRevisions", row._id, { expiresAt: Date.now() - 1 });
  });
  await expect(f.decide("approve", proposed.publicId)).rejects.toThrow("PLAN_EXPIRED");
  expect(await f.pending()).toEqual([]);
  expect(await f.tables()).toMatchObject({ blocks: [], plans: [] });
});

test("a former owner's grant cannot read the new owner's planning context", async () => {
  const f = await setup();
  await f.preview();
  await f.t.run(async ({ db }) => {
    const ownerId = await db.insert("users", {});
    await db.patch("workspaces", f.workspaceId, { ownerId });
    const former = (await db.query("memberships").withIndex("by_workspace_user", q =>
      q.eq("workspaceId", f.workspaceId).eq("userId", f.ownerId)).unique())!;
    await db.patch("memberships", former._id, { role: "planner" });
    await db.insert("memberships", { workspaceId: f.workspaceId, userId: ownerId, role: "owner",
      publicId: "new-owner", ...recordVersion });
  });
  await expect(f.preview()).rejects.toThrow("FORBIDDEN");
  await expect(f.preview({ operationId: crypto.randomUUID() })).rejects.toThrow("FORBIDDEN");
});

test("the owner may reject a proposal whose original grant expired or was revoked", async () => {
  const f = await setup();
  const proposed = await f.preview();
  await f.t.run(({ db }) => db.patch("agentCredentials", f.credentialId, { revokedAt: Date.now() }));
  await expect(f.decide("approve", proposed.publicId)).rejects.toThrow("AGENT_UNAUTHORIZED");
  expect(await f.decide("reject", proposed.publicId)).toMatchObject({ revision: 2 });
  expect(await f.tables()).toMatchObject({ blocks: [], plans: [] });
});
