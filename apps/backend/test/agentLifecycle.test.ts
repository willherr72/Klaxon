import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { addLocalDays } from "../convex/model/calendarTime";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

async function setup({ timezone, mode = "automatic" }: { timezone?: string; mode?: "automatic" | "review" } = {}) {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentLifecycle.ts": () => import("../convex/agentLifecycle"),
    "../convex/agentPlanningContext.ts": () => import("../convex/agentPlanningContext"),
  } });
  const auth = { workspacePublicId: "life", tokenHash: "b".repeat(64) };
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addLocalDays(today, 1);
  const yesterday = addLocalDays(today, -1);
  const { workspaceId, taskId } = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, auth.workspacePublicId);
    const { ownerId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId: ownerId, publicId: "owner", role: "owner", ...recordVersion });
    await db.insert("agentCredentials", { workspaceId, userId: ownerId, publicId: "agent", label: "Planner",
      scopes: ["planning:apply", "planning:read"], tokenHash: auth.tokenHash, expiresAt: Date.now() + 600_000, ...recordVersion });
    if (timezone || mode !== "automatic") {
      await db.insert("preferences", { workspaceId, userId: ownerId, publicId: "policy", ...recordVersion,
        timezone: timezone ?? "UTC", workHours: [], breaks: [], bufferMinutes: 0,
        autonomyPolicy: { planApplication: mode, lockManuallyMovedBlocks: true, discretionaryMinutes: 0 },
        notificationSettings: { enabled: false, native: false, webPush: false }, importFilters: [] });
    }
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "carry", { plannedDate: yesterday, estimateMinutes: 30 }));
    return { workspaceId, taskId };
  });
  const read = (date = today) => t.query(anyApi.agentPlanningContext.get, { ...auth, date, timezone: "UTC" });
  const brief = (overrides = {}) => t.mutation(anyApi.agentLifecycle.publishBriefing, { ...auth, localDate: today,
    expectedDayPlanRevision: null, briefing: "Focus on the test run", reason: "Start-of-day summary",
    operationId: crypto.randomUUID(), ...overrides });
  const carry = (overrides = {}) => t.mutation(anyApi.agentLifecycle.carryForward, { ...auth, publicId: "carry",
    fromDate: yesterday, toDate: today, expectedRevision: 1, reason: "Unfinished work",
    operationId: crypto.randomUUID(), ...overrides });
  const dayPlan = (localDate: string, needsReplan = false) => t.run(({ db }) =>
    db.insert("dayPlans", { workspaceId, publicId: localDate, localDate, needsReplan,
      source: "manual", timezone: "UTC", focusTaskIds: [], ...recordVersion }));
  return { t, workspaceId, taskId, read, brief, carry, dayPlan, yesterday, today, tomorrow };
}

test("versioned briefing survives repeat publication and preserves an existing stale-plan flag", async () => {
  const f = await setup();
  await f.dayPlan(f.today, true);
  const operationId = crypto.randomUUID();
  const receipt = await f.brief({ expectedDayPlanRevision: 1, operationId });
  expect(receipt).toEqual({ workspacePublicId: "life", publicId: f.today, revision: 2,
    activityEventPublicId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(await f.brief({ expectedDayPlanRevision: 1, operationId })).toEqual(receipt);
  await expect(f.brief({ expectedDayPlanRevision: 1 })).rejects.toThrow("REVISION_CONFLICT");
  const { dayPlan } = await f.read();
  expect(dayPlan).toMatchObject({ briefing: "Focus on the test run", briefingUpdatedAt: expect.any(Number), needsReplan: true,
    revision: 2 });
});

test("an existing private briefing stays private and cannot be overwritten by an agent", async () => {
  const f = await setup();
  const dayPlanId = await f.dayPlan(f.today);
  await f.t.run(({ db }) => db.patch("dayPlans", dayPlanId, { briefing: "Private notes" }));
  await expect(f.brief({ expectedDayPlanRevision: 1 })).rejects.toThrow("BRIEFING_PROTECTED");
  expect((await f.read()).dayPlan.briefing).toBeUndefined();
  expect(await f.t.run(({ db }) => db.get("dayPlans", dayPlanId))).toMatchObject({ briefing: "Private notes", revision: 1 });
});

test("carry-forward advances planned date once, preserves deadline, and makes affected plans visibly stale", async () => {
  const f = await setup();
  await f.dayPlan(f.yesterday);
  await f.dayPlan(f.today);
  const deadline = { kind: "date" as const, date: f.today };
  await f.t.run(({ db }) => db.patch("tasks", f.taskId, { deadline }));
  const operationId = crypto.randomUUID();
  const receipt = await f.carry({ operationId });
  expect(receipt).toMatchObject({ publicId: "carry", revision: 2 });
  expect(await f.carry({ operationId })).toEqual(receipt);
  await expect(f.carry({ expectedRevision: 2 })).rejects.toThrow("CARRY_FORWARD_STALE");
  expect((await f.read()).tasks.items).toMatchObject([{ publicId: "carry", plannedDate: f.today, deadline }]);
  expect((await f.read()).dayPlan).toMatchObject({ needsReplan: true, revision: 2 });
  expect((await f.read(f.yesterday)).dayPlan).toMatchObject({ needsReplan: true, revision: 2 });
});

test("an enclosing locked block prevents carry-forward even when it started before the source date", async () => {
  const f = await setup();
  await f.t.run(({ db }) => db.insert("timeBlocks", {
    workspaceId: f.workspaceId, publicId: "old-lock", taskId: f.taskId, timezone: "UTC", localDate: addLocalDays(f.yesterday, -1),
    startAt: Date.parse(addLocalDays(f.yesterday, -1) + "T23:00:00Z"), endAt: Date.parse(f.today + "T01:00:00Z"),
    origin: "manual", locked: true, ...recordVersion,
  }));
  await expect(f.carry()).rejects.toThrow("BLOCK_LOCKED");
  expect(await f.t.run(({ db }) => db.get("tasks", f.taskId))).toMatchObject({ revision: 1, plannedDate: f.yesterday });
});

test("completed work and destination dates beyond a deadline are rejected", async () => {
  const f = await setup();
  const update = (status: "ready" | "done", deadline: { kind: "date"; date: string } | { kind: "instant"; at: number }) =>
    f.t.run(({ db }) => db.patch("tasks", f.taskId, { status, deadline }));
  await update("done", { kind: "date", date: f.today });
  await expect(f.carry()).rejects.toThrow("INVALID_STATE");
  await update("ready", { kind: "date", date: f.today });
  await expect(f.carry({ toDate: f.tomorrow })).rejects.toThrow("CARRY_FORWARD_DEADLINE");
  await update("ready", { kind: "instant", at: Date.parse(f.tomorrow + "T00:00:00Z") });
  await expect(f.carry({ toDate: f.tomorrow })).rejects.toThrow("CARRY_FORWARD_DEADLINE");
  expect(await f.t.run(({ db }) => db.query("activityEvents").collect())).toEqual([]);
});

test("instant deadlines use the destination's local day on a daylight-saving transition", async () => {
  const f = await setup({ timezone: "America/Chicago" });
  await f.t.run(({ db }) => db.patch("tasks", f.taskId, {
    deadline: { kind: "instant", at: Date.parse("2035-03-11T05:30:00Z") },
  }));
  await expect(f.carry({ toDate: "2035-03-11" })).rejects.toThrow("CARRY_FORWARD_DEADLINE");
});

test("review mode refuses direct agent lifecycle changes", async () => {
  const f = await setup({ mode: "review" });
  await expect(f.carry()).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  await expect(f.brief()).rejects.toThrow("AUTONOMY_APPROVAL_REQUIRED");
  expect(await f.t.run(({ db }) => db.query("activityEvents").collect())).toEqual([]);
});

test("planning context surfaces tasks to follow up on independently of the ranked task list", async () => {
  const f = await setup();
  for (const [publicId, status, followUpDate] of [
    ["overdue", "waiting", f.yesterday], ["due", "waiting", f.today],
    ["future", "waiting", f.tomorrow], ["completed", "done", f.today],
  ] as const) {
    await f.t.run(({ db }) => db.insert("tasks", taskRecord(f.workspaceId, publicId, { status, followUpDate })));
  }
  expect((await f.read()).followUps).toEqual({ partial: false, items: [
    { publicId: "overdue", title: "overdue", followUpDate: f.yesterday, revision: 1 },
    { publicId: "due", title: "due", followUpDate: f.today, revision: 1 },
  ] });
});
