import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { addLocalDays } from "../convex/model/calendarTime";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function setup(planApplication: "review" | "automatic" = "review") {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentPlans.ts": () => import("../convex/agentPlans"),
  } });
  const auth = { workspacePublicId: "mixed", tokenHash: "d".repeat(64) };
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = addLocalDays(today, -1);
  const localDate = addLocalDays(today, 1);
  const { workspaceId, ownerId, firstId, secondId, sourcePlanId } = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, auth.workspacePublicId);
    const { ownerId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId: ownerId, publicId: "owner", role: "owner", ...recordVersion });
    await db.insert("agentCredentials", { workspaceId, userId: ownerId, publicId: "agent", label: "Planner",
      scopes: ["planning:preview", "planning:apply"], tokenHash: auth.tokenHash, expiresAt: Date.now() + 600_000, ...recordVersion });
    await db.insert("preferences", { workspaceId, userId: ownerId, publicId: "policy", ...recordVersion,
      timezone: "UTC", workHours: [0, 1, 2, 3, 4, 5, 6].map(weekday =>
        ({ weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6, startMinute: 540, endMinute: 1020 })), breaks: [], bufferMinutes: 0,
      autonomyPolicy: { planApplication, lockManuallyMovedBlocks: true, discretionaryMinutes: 0 },
      notificationSettings: { enabled: false, native: false, webPush: false }, importFilters: [] });
    const firstId = await db.insert("tasks", taskRecord(workspaceId, "first", { plannedDate: fromDate, estimateMinutes: 30 }));
    const secondId = await db.insert("tasks", taskRecord(workspaceId, "second", { plannedDate: fromDate, estimateMinutes: 30 }));
    const sourcePlanId = await db.insert("dayPlans", { workspaceId, publicId: "source", localDate: fromDate,
      timezone: "UTC", source: "manual", focusTaskIds: [firstId, secondId], ...recordVersion });
    return { workspaceId, ownerId, firstId, secondId, sourcePlanId };
  });
  const owner = t.withIdentity({ subject: ownerId });
  const carryForwards = ["second", "first"].map(taskPublicId => ({ taskPublicId, expectedRevision: 1,
    fromDate, toDate: localDate, expectedSourceDayPlanRevision: 1, expectedTargetDayPlanRevision: null }));
  const input = { ...auth, localDate, taskPublicIds: ["first"], expectedDayPlanRevision: null, briefing: "Pair on verification",
    carryForwards, reason: "Review unfinished work", operationId: crypto.randomUUID() };
  const preview = (overrides = {}) => t.mutation(anyApi.agentPlans.preview, { ...input, ...overrides });
  const apply = (publicId: string, operationId = crypto.randomUUID()) => t.mutation(anyApi.agentPlans.apply, {
    ...auth, publicId, operationId, expectedRevision: 1, reason: "Apply approved daily plan",
  });
  const approve = (publicId: string, operationId = crypto.randomUUID()) => owner.mutation(anyApi.agentPlans.approve, {
    workspaceId, publicId, operationId, expectedRevision: 1,
  });
  const pending = () => owner.query(anyApi.agentPlans.pending, { workspaceId });
  const tables = () => t.run(async ({ db }) => ({
    tasks: await db.query("tasks").collect(), plans: await db.query("dayPlans").collect(),
    blocks: await db.query("timeBlocks").collect(), activity: await db.query("activityEvents").collect(),
    receipts: await db.query("operationReceipts").collect(),
  }));
  return { t, firstId, secondId, sourcePlanId, workspaceId, fromDate, localDate, carryForwards, preview, apply, approve, pending, tables };
}

test("owner approves the reviewed schedule, briefing, and ordered carry-forwards in one proposal", async () => {
  const f = await setup();
  const before = await f.tables();
  const proposed = await f.preview();
  expect(proposed).toMatchObject({ briefing: "Pair on verification", placements: [{ action: "add", taskPublicId: "first" }],
    carryForwards: f.carryForwards.map(intent => ({ ...intent, taskTitle: intent.taskPublicId })) });
  expect(await f.pending()).toMatchObject([{ publicId: proposed.publicId, briefing: proposed.briefing, carryForwards: proposed.carryForwards }]);
  expect(await f.tables()).toMatchObject({ tasks: before.tasks, plans: before.plans, blocks: [] });
  await expect(f.apply(proposed.publicId)).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  const operationId = crypto.randomUUID();
  const receipt = await f.approve(proposed.publicId, operationId);
  expect(await f.approve(proposed.publicId, operationId)).toEqual(receipt);
  expect(await f.preview()).toEqual(proposed);
  expect(await f.pending()).toEqual([]);
  const changed = await f.tables();
  expect(changed.tasks).toMatchObject([{ plannedDate: f.localDate, revision: 2 }, { plannedDate: f.localDate, revision: 2 }]);
  expect(changed.plans).toMatchObject([
    { localDate: f.fromDate, needsReplan: true, revision: 2 },
    { localDate: f.localDate, briefing: proposed.briefing, focusTaskIds: [f.firstId] },
  ]);
  expect(changed.blocks).toMatchObject([{ taskId: f.firstId }]);
  expect(changed.receipts).toHaveLength(2);
});

test("a newly locked carry-forward task prevents every proposed effect from applying", async () => {
  const f = await setup("automatic");
  const proposed = await f.preview();
  await f.t.run(({ db }) => db.insert("timeBlocks", {
    workspaceId: f.workspaceId, publicId: "locked", taskId: f.secondId, timezone: "UTC", localDate: f.fromDate,
    startAt: Date.parse(f.fromDate + "T10:00:00Z"), endAt: Date.parse(f.fromDate + "T11:00:00Z"),
    origin: "manual", locked: true, ...recordVersion,
  }));
  const before = await f.tables();
  await expect(f.apply(proposed.publicId)).rejects.toThrow("BLOCK_LOCKED");
  expect(await f.tables()).toEqual(before);
});

test("a source day revision drift rejects a briefing and carry-only proposal", async () => {
  const f = await setup();
  const proposed = await f.preview({ taskPublicIds: [] });
  expect(proposed.placements).toEqual([]);
  await f.t.run(({ db }) => db.patch("dayPlans", f.sourcePlanId, { revision: 2 }));
  const before = await f.tables();
  await expect(f.approve(proposed.publicId)).rejects.toThrow("REVISION_CONFLICT");
  expect(await f.tables()).toEqual(before);
});

test("briefing-only approval creates no schedule or focus changes", async () => {
  const f = await setup();
  const proposed = await f.preview({ taskPublicIds: [], carryForwards: undefined });
  expect(proposed).toMatchObject({ carryForwards: [], focusTaskPublicIds: [], placements: [] });
  await f.approve(proposed.publicId);
  expect(await f.tables()).toMatchObject({ plans: [{}, { localDate: f.localDate, revision: 1,
    focusTaskIds: [], briefing: proposed.briefing }], blocks: [] });
});

test("carry-only approval does not create unrelated day plans or overwrite an existing focus list", async () => {
  const f = await setup();
  const proposed = await f.preview({ taskPublicIds: [], briefing: undefined });
  await f.approve(proposed.publicId);
  const changed = await f.tables();
  expect(changed.plans).toMatchObject([{ localDate: f.fromDate,
    focusTaskIds: [f.firstId, f.secondId], needsReplan: true }]);
  expect(changed.blocks).toEqual([]);
  expect(changed.tasks).toMatchObject([{ plannedDate: f.localDate }, { plannedDate: f.localDate }]);
});

test("a change to a non-anchor destination day invalidates every effect", async () => {
  const f = await setup("automatic");
  const later = addLocalDays(f.localDate, 1);
  const proposed = await f.preview({ taskPublicIds: [], carryForwards: f.carryForwards.map(intent => ({
    ...intent, toDate: later,
  })) });
  await f.t.run(({ db }) => db.insert("dayPlans", { workspaceId: f.workspaceId, publicId: "new-destination",
    localDate: later, timezone: "UTC", source: "manual", focusTaskIds: [], ...recordVersion }));
  const before = await f.tables();
  await expect(f.apply(proposed.publicId)).rejects.toThrow("REVISION_CONFLICT");
  expect(await f.tables()).toEqual(before);
});

test("a protected briefing cannot be included in a review proposal", async () => {
  const f = await setup();
  await f.t.run(({ db }) => db.insert("dayPlans", { workspaceId: f.workspaceId, publicId: "private-target",
    localDate: f.localDate, timezone: "UTC", source: "manual", focusTaskIds: [], briefing: "Owner only", ...recordVersion }));
  const before = await f.tables();
  await expect(f.preview({ taskPublicIds: [], expectedDayPlanRevision: 1, carryForwards: [] })).rejects.toThrow("BRIEFING_PROTECTED");
  expect(await f.tables()).toEqual(before);
});
