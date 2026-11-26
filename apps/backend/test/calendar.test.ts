import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

const ms = (value: string) => Date.parse(value);
const operationId = () => crypto.randomUUID();

async function setup() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/calendar.ts": () => import("../convex/calendar"),
    "../convex/planning.ts": () => import("../convex/planning"),
  } });
  const { ownerId, outsiderId, workspaceId } = await t.run(async ({ db }) => {
    const ownerId = await db.insert("users", {});
    const outsiderId = await db.insert("users", {});
    const workspaceId = await db.insert("workspaces", { ownerId, publicId: "test", name: "test", ...recordVersion });
    await db.insert("memberships", { workspaceId, userId: ownerId, publicId: "owner", role: "owner", ...recordVersion });
    return { ownerId, outsiderId, workspaceId };
  });
  const user = t.withIdentity({ subject: ownerId });
  const list = (localDate: string, view: "day" | "week" = "day", timezone = "UTC") =>
    user.query(anyApi.calendar.list, { workspaceId, localDate, view, timezone });
  const block = (command: Record<string, unknown>, id = operationId()) =>
    user.mutation(anyApi.calendar.apply, { workspaceId, operationId: id, command });
  const prefs = (preferences: Record<string, unknown>, expectedRevision = 0) =>
    user.mutation(anyApi.planning.updatePreferences, { workspaceId, operationId: operationId(), expectedRevision, preferences });
  const preview = (localDate: string, taskPublicIds: string[], expectedDayPlanRevision: number | null = null) =>
    user.mutation(anyApi.planning.preview, { workspaceId, operationId: operationId(), localDate, taskPublicIds, expectedDayPlanRevision });
  const applyPlan = (publicId: string, expectedRevision = 1, id = operationId()) =>
    user.mutation(anyApi.planning.apply, { workspaceId, operationId: id, publicId, expectedRevision });
  return { t, user, ownerId, outsiderId, workspaceId, list, block, prefs, preview, applyPlan };
}

test("calendar uses overlapping intervals and local DST boundaries, including old enclosing blocks", async () => {
  const { t, workspaceId, list } = await setup();
  await t.run(async ({ db }) => {
    for (const [publicId, start, end] of [
      ["ends-at-boundary", "2028-03-10T05:00:00Z", "2028-03-12T06:00:00Z"],
      ["enclosing", "2027-02-01T00:00:00Z", "2029-02-01T00:00:00Z"],
      ["crosses-midnight", "2028-03-12T05:00:00Z", "2028-03-12T07:00:00Z"],
      ["starts-at-boundary", "2028-03-13T05:00:00Z", "2028-03-13T06:00:00Z"],
    ]) {
      await db.insert("timeBlocks", { workspaceId, publicId, title: publicId, startAt: ms(start), endAt: ms(end),
        timezone: "UTC", localDate: start.slice(0, 10), locked: false, origin: "manual", ...recordVersion });
    }
  });
  const day = await list("2028-03-12", "day", "America/Chicago");
  expect(day).toMatchObject({ startAt: ms("2028-03-12T06:00:00Z"), endAt: ms("2028-03-13T05:00:00Z") });
  expect(day.blocks.map((row: { publicId: string }) => row.publicId)).toEqual(["enclosing", "crosses-midnight"]);
  const week = await list("2028-10-31", "week", "America/Chicago");
  expect(week.endAt - week.startAt).toBe(169 * 60 * 60 * 1000);
});

test("calendar redacts busy-only metadata and excludes unauthorized, deleted and disconnected events", async () => {
  const { t, ownerId, outsiderId, workspaceId, list } = await setup();
  await t.run(async ({ db }) => {
    for (const [publicId, userId, state, deleted] of [
      ["busy-only", ownerId, "active", false], ["other-user", outsiderId, "active", false],
      ["disconnected", ownerId, "disconnected", false], ["deleted", ownerId, "active", true],
    ] as const) {
      const connectionId = await db.insert("integrationConnections", { workspaceId, userId, provider: "outlook", publicId,
        accountId: publicId, state, metadataPolicy: "busy_only", scopeIds: [], ...recordVersion });
      await db.insert("calendarEvents", { workspaceId, connectionId, provider: "outlook", publicId,
        externalEventId: publicId, title: "Private title", startAt: ms("2028-03-11T23:30:00Z"),
        endAt: ms("2028-03-12T00:30:00Z"), timezone: "UTC", localDate: "2028-03-11", allDay: false,
        availability: "busy", lastSeenAt: 1, ...(deleted ? { deletedAt: 2 } : {}), ...recordVersion });
    }
  });
  const { events } = await list("2028-03-12");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ publicId: "busy-only", availability: "busy" });
  expect(events[0]).not.toHaveProperty("title");
  expect(events[0]).not.toHaveProperty("connectionId");
  const outsider = t.withIdentity({ subject: outsiderId });
  await expect(outsider.query(anyApi.calendar.list, { workspaceId, localDate: "2028-03-12", view: "day" }))
    .rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
});

test("time-block editing uses revisions and default move locks, without changing tasks or reminders", async () => {
  const { t, workspaceId, block, list } = await setup();
  const seeded = await t.run(async ({ db }) => {
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "work", { deadline: { kind: "date", date: "2028-03-12" } }));
    const reminderId = await db.insert("reminders", { workspaceId, publicId: "remind", taskId, title: "Call",
      dueAt: ms("2028-03-12T14:00:00Z"), timezone: "UTC", priority: "none", state: "pending", ...recordVersion });
    return { taskId, reminderId };
  });
  const create = { kind: "block.create", publicId: "focus", taskPublicId: "work",
    startAt: ms("2028-03-12T12:00:00Z"), endAt: ms("2028-03-12T13:00:00Z") };
  const id = operationId();
  expect(await block(create, id)).toEqual(await block(create, id));
  await block({ kind: "block.move", publicId: "focus", expectedRevision: 1, startAt: ms("2028-03-12T15:00:00Z") });
  const resize = { kind: "block.resize", publicId: "focus", expectedRevision: 2,
    startAt: ms("2028-03-12T15:00:00Z"), endAt: ms("2028-03-12T17:00:00Z") };
  await expect(block({ ...resize, expectedRevision: 1 })).rejects.toThrow(/REVISION_CONFLICT/);
  await expect(block(resize)).rejects.toThrow(/BLOCK_LOCKED/);
  expect((await list("2028-03-12")).blocks).toMatchObject([
    { publicId: "focus", startAt: ms("2028-03-12T15:00:00Z"), endAt: ms("2028-03-12T16:00:00Z"), locked: true },
  ]);
  await block({ kind: "block.unlock", publicId: "focus", expectedRevision: 2 });
  await block({ ...resize, expectedRevision: 3, lock: false });
  await block({ kind: "block.update", publicId: "focus", expectedRevision: 4, title: "Read" });
  expect((await list("2028-03-12")).blocks).toMatchObject([{ title: "Read", endAt: resize.endAt, locked: false }]);
  await block({ kind: "block.remove", publicId: "focus", expectedRevision: 5 });
  expect((await list("2028-03-12")).blocks).toEqual([]);
  await t.run(async ({ db }) => {
    expect(await db.get("tasks", seeded.taskId)).toMatchObject({ revision: 1, deadline: { kind: "date", date: "2028-03-12" } });
    expect(await db.get("reminders", seeded.reminderId)).toMatchObject({ revision: 1, dueAt: ms("2028-03-12T14:00:00Z") });
  });
});

test("removal retires the public block ID so stale edits cannot target a replacement", async () => {
  const { block } = await setup();
  const create = { kind: "block.create", publicId: "reservation", title: "Reservation",
    startAt: ms("2028-03-12T12:00:00Z"), endAt: ms("2028-03-12T13:00:00Z") };
  await block(create);
  await block({ kind: "block.remove", publicId: create.publicId, expectedRevision: 1 });
  await expect(block(create)).rejects.toThrow(/ALREADY_EXISTS/);
});

const east = {
  timezone: "America/New_York", workHours: [{ weekday: 6, startMinute: 60, endMinute: 300 }],
  breaks: [{ weekday: 6, startMinute: 180, endMinute: 210 }], bufferMinutes: 15,
  discretionaryMinutes: 30, lockManuallyMovedBlocks: true,
};

test("preferences reject a stale revision and preserve unrelated settings", async () => {
  const { t, ownerId, workspaceId, user, prefs } = await setup();
  expect(await user.query(anyApi.planning.getPreferences, { workspaceId })).toMatchObject({ revision: 0, timezone: "UTC" });
  const id = await t.run(({ db }) => db.insert("preferences", { workspaceId, userId: ownerId, publicId: "preference",
    timezone: "UTC", workHours: [], autonomyPolicy: { planApplication: "automatic", lockManuallyMovedBlocks: true },
    notificationSettings: { enabled: true, webPush: true, native: false }, importFilters: [{ provider: "linear" }], ...recordVersion }));
  await expect(prefs(east)).rejects.toThrow(/REVISION_CONFLICT/);
  await prefs({ ...east, lockManuallyMovedBlocks: false }, 1);
  expect(await user.query(anyApi.planning.getPreferences, { workspaceId })).toMatchObject({
    ...east, revision: 2, lockManuallyMovedBlocks: false,
  });
  expect(await t.run(({ db }) => db.get("preferences", id))).toMatchObject({
    autonomyPolicy: { planApplication: "automatic" }, notificationSettings: { enabled: true, webPush: true, native: false },
    importFilters: [{ provider: "linear" }],
  });
});

test("planner schedules against DST, buffers, deadlines, free events and capacity without editing tasks", async () => {
  const { t, ownerId, workspaceId, prefs, preview, applyPlan, list } = await setup();
  await prefs(east);
  const taskId = await t.run(async ({ db }) => {
    const first = await db.insert("tasks", taskRecord(workspaceId, "first", {
      priority: "urgent", estimateMinutes: 30, deadline: { kind: "instant", at: ms("2028-03-12T06:45:00Z") } }));
    await db.insert("tasks", taskRecord(workspaceId, "second", { estimateMinutes: 15 }));
    await db.insert("tasks", taskRecord(workspaceId, "overload", { estimateMinutes: 120 }));
    const connectionId = await db.insert("integrationConnections", { workspaceId, userId: ownerId, publicId: "account",
      accountId: "account", provider: "outlook", scopeIds: [], state: "active", ...recordVersion });
    for (const [publicId, availability, start, end] of [
      ["meeting", "busy", "2028-03-12T07:45:00Z", "2028-03-12T08:00:00Z"],
      ["free", "free", "2028-03-12T06:00:00Z", "2028-03-12T09:00:00Z"],
    ] as const) await db.insert("calendarEvents", { workspaceId, connectionId, provider: "outlook", publicId,
      externalEventId: publicId, startAt: ms(start), endAt: ms(end), timezone: "America/New_York", localDate: "2028-03-12",
      allDay: false, availability, lastSeenAt: 1, ...recordVersion });
    return first;
  });
  const draft = await preview("2028-03-12", ["second", "overload", "first"]);
  expect(draft.placements).toMatchObject([
    { taskPublicId: "first", startAt: ms("2028-03-12T06:00:00Z"), endAt: ms("2028-03-12T06:30:00Z") },
    { taskPublicId: "second", startAt: ms("2028-03-12T06:45:00Z"), endAt: ms("2028-03-12T07:00:00Z") },
  ]);
  expect(draft.unscheduled).toMatchObject([{ taskPublicId: "overload", reason: "capacity" }]);
  expect((await list("2028-03-12")).blocks).toEqual([]);
  const id = operationId();
  expect(await applyPlan(draft.publicId, 1, id)).toEqual(await applyPlan(draft.publicId, 1, id));
  expect((await list("2028-03-12")).blocks).toHaveLength(2);
  await t.run(async ({ db }) => {
    expect(await db.get("tasks", taskId)).toMatchObject({ revision: 1, deadline: { at: ms("2028-03-12T06:45:00Z") } });
    expect(await db.query("planRevisions").collect()).toMatchObject([{ state: "applied", revision: 2, appliedDayPlanRevision: 1 }]);
  });
});

test("apply rejects a preview when a meeting, block, or task changes and flags meeting overlaps on a saved plan", async () => {
  const { t, ownerId, workspaceId, user, prefs, preview, applyPlan, list } = await setup();
  await prefs(east);
  const { taskId, connectionId } = await t.run(async ({ db }) => ({
    taskId: await db.insert("tasks", taskRecord(workspaceId, "work", { estimateMinutes: 30 })),
    connectionId: await db.insert("integrationConnections", { workspaceId, userId: ownerId, publicId: "account",
      accountId: "account", provider: "outlook", scopeIds: [], state: "active", ...recordVersion }),
  }));
  const localDate = "2028-03-12";
  const draft = await preview(localDate, ["work"]);
  const insertMeeting = () => t.run(({ db }) => db.insert("calendarEvents", { workspaceId, connectionId,
    provider: "outlook", publicId: "meeting", externalEventId: "meeting", startAt: ms("2028-03-12T06:00:00Z"),
    endAt: ms("2028-03-12T06:30:00Z"), timezone: "America/New_York", localDate, allDay: false,
    availability: "busy", lastSeenAt: 1, ...recordVersion }));
  const meeting = await insertMeeting();
  await expect(applyPlan(draft.publicId)).rejects.toThrow(/PLAN_CONTEXT_CHANGED/);
  expect((await list(localDate)).blocks).toEqual([]);
  const updated = await preview(localDate, ["work"]);
  await t.run(({ db }) => db.patch("tasks", taskId, { estimateMinutes: 15, revision: 2 }));
  await expect(applyPlan(updated.publicId)).rejects.toThrow(/PLAN_CONTEXT_CHANGED/);
  await t.run(({ db }) => db.delete("calendarEvents", meeting));
  const final = await preview(localDate, ["work"]);
  await applyPlan(final.publicId);
  await insertMeeting();
  const dayPlan = await user.query(anyApi.planning.getDayPlan, { workspaceId, localDate });
  expect(dayPlan.needsReplan).toBe(true);
  expect((await list(localDate)).events).toHaveLength(1);
});

test("preview explains past deadlines, inactive tasks and missing estimates and replays the original summary", async () => {
  const { t, workspaceId, user, prefs } = await setup();
  await prefs(east);
  const archived = await t.run(async ({ db }) => {
    await db.insert("tasks", taskRecord(workspaceId, "already-due", {
      deadline: { kind: "date", date: "2028-03-11" }, estimateMinutes: 45 }));
    await db.insert("tasks", taskRecord(workspaceId, "unknown"));
    return db.insert("tasks", taskRecord(workspaceId, "archived", { status: "archived", estimateMinutes: 20 }));
  });
  const args = { workspaceId, operationId: operationId(), localDate: "2028-03-12",
    taskPublicIds: ["archived", "unknown", "already-due"], expectedDayPlanRevision: null };
  const draft = await user.mutation(anyApi.planning.preview, args);
  expect(draft.unscheduled).toEqual([
    { taskPublicId: "already-due", reason: "deadline", remainingMinutes: 45 },
    { taskPublicId: "archived", reason: "inactive", remainingMinutes: 20 },
    { taskPublicId: "unknown", reason: "missing_estimate" },
  ]);
  await t.run(({ db }) => db.patch("tasks", archived, { status: "ready", estimateMinutes: 40, revision: 2 }));
  expect(await user.mutation(anyApi.planning.preview, args)).toEqual(draft);
});

test("a spring-forward gap contributes zero work minutes", async () => {
  const { t, workspaceId, prefs, preview } = await setup();
  const workHours = [{ weekday: 6, startMinute: 135, endMinute: 150 }];
  await prefs({ ...east, workHours, breaks: [], bufferMinutes: 0, discretionaryMinutes: 0 });
  await t.run(({ db }) => db.insert("tasks", taskRecord(workspaceId, "work", { estimateMinutes: 10 })));
  const skipped = await preview("2028-03-12", ["work"]);
  expect(skipped.placements).toEqual([]);
  expect(skipped.unscheduled).toEqual([{ taskPublicId: "work", reason: "capacity", remainingMinutes: 10 }]);
  await prefs({ ...east, workHours: [{ weekday: 6, startMinute: 135, endMinute: 210 }], breaks: [],
    bufferMinutes: 0, discretionaryMinutes: 0 }, 1);
  const resumed = await preview("2028-03-12", ["work"]);
  expect(resumed.placements).toMatchObject([{ startAt: ms("2028-03-12T07:00:00Z"), endAt: ms("2028-03-12T07:10:00Z") }]);
});

test("a fall-back work window includes both occurrences of the repeated hour", async () => {
  const { t, workspaceId, prefs, preview } = await setup();
  await prefs({ ...east, workHours: [{ weekday: 6, startMinute: 60, endMinute: 120 }], breaks: [],
    bufferMinutes: 0, discretionaryMinutes: 0 });
  await t.run(({ db }) => db.insert("tasks", taskRecord(workspaceId, "long", { estimateMinutes: 100 })));
  const draft = await preview("2028-11-05", ["long"]);
  expect(draft.placements).toMatchObject([{ startAt: ms("2028-11-05T05:00:00Z"), endAt: ms("2028-11-05T06:40:00Z") }]);
});

test("replanning leaves a manually locked reservation in place and moves it after explicit unlock", async () => {
  const { t, ownerId, workspaceId, user, prefs, preview, applyPlan, list, block } = await setup();
  await prefs(east);
  const connectionId = await t.run(async ({ db }) => {
    await db.insert("tasks", taskRecord(workspaceId, "work", { estimateMinutes: 30 }));
    return db.insert("integrationConnections", { workspaceId, userId: ownerId, publicId: "account",
      accountId: "account", provider: "outlook", scopeIds: [], state: "active", ...recordVersion });
  });
  const localDate = "2028-03-12";
  const original = await preview(localDate, ["work"]);
  await applyPlan(original.publicId);
  const [saved] = (await list(localDate)).blocks;
  await t.run(({ db }) => db.insert("calendarEvents", { workspaceId, connectionId,
    provider: "outlook", publicId: "meeting", externalEventId: "meeting", startAt: saved.startAt, endAt: saved.endAt,
    timezone: "America/New_York", localDate, allDay: false, availability: "busy", lastSeenAt: 1, ...recordVersion }));
  const stale = await preview(localDate, ["work"], 1);
  expect(stale.placements).toMatchObject([{ action: "move", blockPublicId: saved.publicId }]);
  await block({ kind: "block.lock", publicId: saved.publicId, expectedRevision: 1 });
  await expect(applyPlan(stale.publicId)).rejects.toThrow(/PLAN_CONTEXT_CHANGED/);
  const locked = await preview(localDate, ["work"], 2);
  expect(locked.placements).toEqual([]);
  await applyPlan(locked.publicId);
  expect((await list(localDate)).blocks).toMatchObject([{ publicId: saved.publicId, startAt: saved.startAt, locked: true }]);
  await block({ kind: "block.unlock", publicId: saved.publicId, expectedRevision: 2 });
  const draft = await preview(localDate, ["work"], 4);
  await applyPlan(draft.publicId);
  expect((await list(localDate)).blocks).toMatchObject([{ publicId: saved.publicId, startAt: ms("2028-03-12T07:30:00Z"), locked: false }]);
  expect(await user.query(anyApi.planning.getDayPlan, { workspaceId, localDate })).toMatchObject({ needsReplan: false });
});

test("live placement checks reject overlaps, and stale or expired plans cannot add blocks", async () => {
  const { t, workspaceId, user, prefs, preview, applyPlan, list, block } = await setup();
  await prefs(east);
  await t.run(({ db }) => db.insert("tasks", taskRecord(workspaceId, "work", { estimateMinutes: 30 })));
  const localDate = "2028-03-12";
  const draft = await preview(localDate, ["work"]);
  const { startAt, endAt } = draft.placements[0];
  await block({ kind: "block.create", title: "Reservation", publicId: "reservation", startAt, endAt });
  const placement = await user.query(anyApi.calendar.checkPlacement, { workspaceId, startAt, endAt });
  expect(placement.conflicts).toMatchObject([{ kind: "block", publicId: "reservation" }]);
  await expect(block({ kind: "block.create", title: "Other", publicId: "other", startAt, endAt })).rejects.toThrow(/CALENDAR_CONFLICT/);
  await expect(applyPlan(draft.publicId)).rejects.toThrow(/PLAN_CONTEXT_CHANGED/);
  const updated = await preview(localDate, ["work"]);
  await t.run(async ({ db }) => {
    const row = await db.query("planRevisions").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", updated.publicId)).unique();
    await db.patch("planRevisions", row!._id, { expiresAt: 1 });
  });
  await expect(applyPlan(updated.publicId)).rejects.toThrow(/PLAN_EXPIRED/);
  expect((await list(localDate)).blocks.map((value: { publicId: string }) => value.publicId)).toEqual(["reservation"]);
});

test("unsafe imported-event overlap scans fail closed even with an empty target day", async () => {
  const { t, ownerId, workspaceId, prefs, preview, list, block } = await setup();
  await prefs(east);
  await t.run(async ({ db }) => {
    await db.insert("tasks", taskRecord(workspaceId, "work", { estimateMinutes: 30 }));
    const connectionId = await db.insert("integrationConnections", { workspaceId, userId: ownerId, publicId: "account",
      accountId: "account", provider: "outlook", scopeIds: [], state: "active", ...recordVersion });
    for (const localDate of ["2028-03-11", "2028-03-13"]) {
      const startAt = ms(`${localDate}T12:00:00Z`);
      for (let index = 0; index < 1025; index++) {
        const publicId = `${localDate}-${index}`;
        await db.insert("calendarEvents", { workspaceId, connectionId, provider: "outlook", publicId,
          externalEventId: publicId, startAt, endAt: startAt + 3_600_000, timezone: "UTC", localDate,
          allDay: false, availability: "busy", lastSeenAt: 1, ...recordVersion });
      }
    }
  });
  await expect(list("2028-03-12")).rejects.toThrow(/CALENDAR_RANGE_LIMIT/);
  await expect(preview("2028-03-12", ["work"])).rejects.toThrow(/CALENDAR_RANGE_LIMIT/);
  await expect(block({ kind: "block.create", publicId: "work", title: "Work", startAt: ms("2028-03-12T12:00:00Z"),
    endAt: ms("2028-03-12T13:00:00Z") })).rejects.toThrow(/CALENDAR_RANGE_LIMIT/);
});
