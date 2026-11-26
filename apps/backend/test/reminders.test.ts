import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import type { Doc } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

const date = Date.parse;
const api = anyApi.reminders;
const operation = () => ({ operationId: crypto.randomUUID() });
const page = { paginationOpts: { cursor: null, numItems: 40 } };
type Definition = Pick<Doc<"reminders">, "dueAt" | "title"> & Partial<Pick<Doc<"reminders">,
  "timezone" | "recurrence" | "description">> & { taskPublicId?: string };
type HistoryRow = { reminderPublicId: string; publicId: string; state: string };

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/backups.ts": () => import("../convex/backups"),
    "../convex/reminders.ts": () => import("../convex/reminders"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
  const [ownerId, readerId, outsiderId, plannerId] = await t.run(async ({ db }) =>
    Promise.all([db.insert("users", {}), db.insert("users", {}), db.insert("users", {}), db.insert("users", {})]));
  const owner = t.withIdentity({ subject: ownerId });
  const reader = t.withIdentity({ subject: readerId });
  const outsider = t.withIdentity({ subject: outsiderId });
  const planner = t.withIdentity({ subject: plannerId });
  const { _id: workspaceId } = await owner.mutation(anyApi.workspaces.ensurePersonal, {});
  const { _id: otherWorkspaceId } = await outsider.mutation(anyApi.workspaces.ensurePersonal, {});
  await t.run(async ({ db }) => {
    await db.insert("memberships", { workspaceId, userId: readerId, role: "reader", publicId: "reader", ...recordVersion });
    await db.insert("memberships", { workspaceId, userId: plannerId, role: "planner", publicId: "planner", ...recordVersion });
    await db.insert("tasks", taskRecord(workspaceId, "own-task"));
    await db.insert("tasks", taskRecord(otherWorkspaceId, "other-task"));
  });
  const scope = { workspaceId };
  const create = async (reminder: Definition) => {
    const result = await owner.mutation(api.create, { ...scope, ...operation(), reminder });
    return get(result.targetPublicId);
  };
  const get = (publicId: string) => owner.query(api.get, { ...scope, publicId });
  const action = (row: { publicId: string; revision: number; occurrence: { publicId: string } }) =>
    ({ ...scope, ...operation(), publicId: row.publicId, expectedRevision: row.revision, occurrencePublicId: row.occurrence.publicId });
  return { t, ownerId, owner, reader, planner, outsider, otherWorkspaceId, scope, create, get, action };
}

test("workspace roles gate reads and writes, including receipt replay and foreign links", async () => {
  const { t, owner, reader, planner, outsider, otherWorkspaceId, scope } = await fixture();
  const args = { ...scope, ...operation(), reminder: {
    title: "Linked", dueAt: date("2027-01-01T12:00Z"), taskPublicId: "own-task",
  } };
  await expect(t.query(api.list, { ...scope, ...page })).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(outsider.query(api.due, scope)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await expect(reader.mutation(api.create, args)).rejects.toThrow(/FORBIDDEN/);
  const receipt = await planner.mutation(api.create, args);
  const identity = { ...scope, publicId: receipt.targetPublicId };
  expect(await reader.query(api.get, identity)).toMatchObject({ title: "Linked", taskPublicId: "own-task" });
  expect(await outsider.query(api.get, { workspaceId: otherWorkspaceId, publicId: receipt.targetPublicId })).toBeNull();
  await expect(owner.mutation(api.create, { ...args, ...operation(), reminder: {
    ...args.reminder, taskPublicId: "other-task",
  } })).rejects.toThrow(/TASK_UNAVAILABLE/);
  await t.run(async ({ db }) => {
    const membership = await db.query("memberships").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", scope.workspaceId).eq("publicId", "planner")).unique();
    await db.patch("memberships", membership!._id, { role: "reader" });
  });
  await expect(planner.mutation(api.create, args)).rejects.toThrow(/FORBIDDEN/);
});

test("edits and removal invalidate queued identities with idempotent receipts and retained history", async () => {
  const { t, owner, scope, get } = await fixture();
  const args = { ...scope, ...operation(), reminder: { title: "Original", dueAt: date("2027-01-01T12:00Z") } };
  const createReceipt = await owner.mutation(api.create, args);
  expect(await owner.mutation(api.create, args)).toEqual(createReceipt);
  const original = await get(createReceipt.targetPublicId);
  const update = { ...scope, ...operation(), publicId: original.publicId, expectedRevision: 1, patch: { title: "Edited" } };
  const updateReceipt = await owner.mutation(api.update, update);
  expect(await owner.mutation(api.update, update)).toEqual(updateReceipt);
  await expect(owner.mutation(api.update, { ...update, patch: { title: "Other" } })).rejects.toThrow(/OPERATION_ID_CONFLICT/);
  const edited = await get(original.publicId);
  expect(edited).toMatchObject({ title: "Edited", revision: 2, dormant: false, occurrence: { deliveryState: "disabled" } });
  expect(edited.occurrence.publicId).not.toBe(original.occurrence.publicId);
  await expect(owner.mutation(api.snooze, { ...scope, ...operation(), publicId: edited.publicId,
    expectedRevision: 2, occurrencePublicId: original.occurrence.publicId, snoozeUntil: date("2027-02-01T00:00Z"),
  })).rejects.toThrow(/OCCURRENCE_UNAVAILABLE/);
  const remove = { ...scope, ...operation(), publicId: edited.publicId, expectedRevision: 2 };
  const removeReceipt = await owner.mutation(api.remove, remove);
  expect(await owner.mutation(api.remove, remove)).toEqual(removeReceipt);
  expect(await get(edited.publicId)).toBeNull();
  expect((await owner.query(api.list, { ...scope, ...page })).page).toEqual([]);
  const history = await owner.query(api.history, { ...scope, ...page });
  expect(history.page).toEqual(expect.arrayContaining([
    expect.objectContaining({ publicId: original.occurrence.publicId, reminderPublicId: edited.publicId,
      reminderTitle: "Original", state: "cancelled" }),
    expect.objectContaining({ publicId: edited.occurrence.publicId, reminderPublicId: edited.publicId,
      reminderTitle: "Edited", state: "cancelled" }),
  ]));
  expect(await t.run(({ db }) => db.system.query("_scheduled_functions").collect())).toEqual([]);
});

test("snooze defers the due occurrence and completion leaves the linked task alone", async () => {
  const now = date("2027-01-10T12:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const { t, owner, scope, create, get, action } = await fixture();
  const initial = await create({ title: "Follow up", dueAt: now - 1, taskPublicId: "own-task", recurrence: { kind: "daily" } });
  expect((await owner.query(api.due, { ...scope, asOf: now })).items).toEqual([
    expect.objectContaining({ publicId: initial.publicId, dormant: false, overdue: true }),
  ]);
  await expect(owner.mutation(api.snooze, { ...action(initial), snoozeUntil: now })).rejects.toThrow(/INVALID_ARGUMENT/);
  const snooze = { ...action(initial), snoozeUntil: now + 5_000 };
  const receipt = await owner.mutation(api.snooze, snooze);
  expect(await owner.mutation(api.snooze, snooze)).toEqual(receipt);
  await expect(owner.mutation(api.complete, action(initial))).rejects.toThrow(/REVISION_CONFLICT/);
  const snoozed = await get(initial.publicId);
  expect(snoozed).toMatchObject({ state: "snoozed", dueAt: now - 1, nextTriggerAt: now + 5_000 });
  expect(snoozed.occurrence.publicId).not.toBe(initial.occurrence.publicId);
  expect((await owner.query(api.due, { ...scope, asOf: now })).items).toEqual([]);
  expect((await owner.query(api.due, { ...scope, asOf: now + 5_000 })).items).toEqual([
    expect.objectContaining({ publicId: initial.publicId, overdue: false }),
  ]);
  clock.mockReturnValue(now + 5_000);
  await owner.mutation(api.complete, action(snoozed));
  const completed = await get(initial.publicId);
  expect(completed).toMatchObject({ state: "completed", occurrence: null });
  const history = await owner.query(api.history, { ...scope, ...page });
  expect(history.page).toEqual(expect.arrayContaining([
    expect.objectContaining({ publicId: initial.occurrence.publicId, state: "cancelled" }),
    expect.objectContaining({ publicId: snoozed.occurrence.publicId, state: "completed", acknowledgedAt: completed.updatedAt }),
  ]));
  const task = await t.run(({ db }) => db.query("tasks").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", scope.workspaceId).eq("publicId", "own-task")).unique());
  expect(task?.status).toBe("ready");
});

test("daily local recurrence preserves the wall-clock anchor through a DST gap and fold", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(date("2027-03-13T09:00Z"));
  const { owner, scope, create, get, action } = await fixture();
  const first = await create({ title: "Spring", dueAt: date("2027-03-13T08:30:12.500Z"), timezone: "America/Chicago",
    recurrence: { kind: "daily" } });
  await owner.mutation(api.dismiss, action(first));
  const gap = await get(first.publicId);
  expect(gap.dueAt).toBe(date("2027-03-14T08:00:00Z"));
  now.mockReturnValue(date("2027-03-14T09:00Z"));
  await owner.mutation(api.dismiss, action(gap));
  expect((await get(first.publicId)).dueAt).toBe(date("2027-03-15T07:30:12.500Z"));

  now.mockReturnValue(date("2027-11-06T07:00Z"));
  const fall = await create({ title: "Fall", dueAt: date("2027-11-06T06:30Z"), timezone: "America/Chicago",
    recurrence: { kind: "daily" } });
  await owner.mutation(api.dismiss, action(fall));
  expect((await get(fall.publicId)).dueAt).toBe(date("2027-11-07T06:30Z"));
  const history = await owner.query(api.history, { ...scope, ...page });
  const rows: HistoryRow[] = history.page;
  expect(rows.filter(row => row.reminderPublicId === first.publicId && row.state === "pending")).toHaveLength(1);
});

test("daily recurrence preserves the next wall time when a timezone skips an entire date", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(date("2011-12-30T00:00Z"));
  const { owner, create, get, action } = await fixture();
  const first = await create({ title: "Daily in Apia", dueAt: date("2011-12-29T19:00Z"), timezone: "Pacific/Apia",
    recurrence: { kind: "daily" } });
  await owner.mutation(api.dismiss, action(first));
  const skipped = await get(first.publicId);
  expect(skipped.dueAt).toBe(date("2011-12-30T10:00Z"));
  clock.mockReturnValue(date("2011-12-30T11:00Z"));
  await owner.mutation(api.dismiss, action(skipped));
  expect((await get(first.publicId)).dueAt).toBe(date("2011-12-30T19:00Z"));
});

test.each([
  ["weekly after a long delay", { kind: "weekly", weekdays: [0, 4] }, "2027-01-01T15:15Z",
    "2027-03-15T14:16Z", "2027-03-19T14:15Z"],
  ["monthly across a short month", { kind: "monthly", day: 31 }, "2027-01-31T15:00Z",
    "2027-01-31T16:00Z", "2027-02-28T15:00Z"],
  ["interval on elapsed seconds", { kind: "interval", everySeconds: 2700 }, "2027-03-13T08:30Z",
    "2027-03-14T08:00Z", "2027-03-14T08:30Z"],
] as const)("%s produces exactly one next occurrence", async (_, rule, firstDue, asOf, nextDue) => {
  vi.spyOn(Date, "now").mockReturnValue(date(asOf));
  const { owner, create, get, action } = await fixture();
  const first = await create({ title: "Recurring", dueAt: date(firstDue), timezone: "America/Chicago",
    recurrence: rule.kind === "weekly" ? { kind: rule.kind, weekdays: [...rule.weekdays] } : rule });
  const args = action(first);
  const receipt = await owner.mutation(api.dismiss, args);
  expect(await owner.mutation(api.dismiss, args)).toEqual(receipt);
  const next = await get(first.publicId);
  expect(next).toMatchObject({ state: "pending", dueAt: date(nextDue), revision: 2, occurrence: { dueAt: date(nextDue) } });
});

test("legacy and restored reminders are dormant until explicitly activated", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(date("2027-03-13T09:00Z"));
  const { t, owner, scope, get, action } = await fixture();
  const dueAt = date("2027-03-13T08:30Z");
  await t.run(async ({ db }) => {
    for (const [publicId, nextTriggerAt] of [["legacy", undefined], ["restored", dueAt]] as const) {
      await db.insert("reminders", { ...scope, ...recordVersion, publicId, title: publicId, state: "pending",
        priority: "normal", dueAt, timezone: "America/Chicago", nextTriggerAt, source: { kind: "legacy", source: "v1" },
        recurrence: { kind: "daily" }, recurrenceBasis: "legacy_utc" });
    }
  });
  for (const publicId of ["legacy", "restored"]) {
    const reminder = await get(publicId);
    expect(reminder).toMatchObject({ dormant: true, recurrenceBasis: "legacy_utc", occurrence: { deliveryState: "disabled" } });
    const args = { ...scope, publicId, occurrencePublicId: reminder.occurrence.publicId, expectedRevision: reminder.revision };
    expect(await t.mutation(api.fireDue, args)).toMatchObject({ status: "dormant" });
    expect(await t.mutation(api.rollover, args)).toMatchObject({ status: "dormant" });
  }
  expect((await owner.query(api.due, scope)).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ publicId: "legacy", dormant: true }),
    expect.objectContaining({ publicId: "restored", dormant: true }),
  ]));
  expect((await owner.query(api.history, { ...scope, ...page })).page).toEqual([]);

  await owner.mutation(api.update, { ...scope, ...operation(), publicId: "legacy", expectedRevision: 1, patch: { title: "Imported" } });
  expect(await get("legacy")).toMatchObject({ dormant: true, source: { kind: "legacy", source: "v1" } });
  const activate = { ...scope, ...operation(), publicId: "legacy", expectedRevision: 2 };
  const result = await owner.mutation(api.activate, activate);
  expect(await owner.mutation(api.activate, activate)).toEqual(result);
  const active = await get("legacy");
  expect(active).toMatchObject({ dormant: false, revision: 3, nextTriggerAt: dueAt });
  await owner.mutation(api.dismiss, action(active));
  expect(await get("legacy")).toMatchObject({ revision: 4, dueAt: date("2027-03-14T08:30Z"), recurrenceBasis: "legacy_utc" });

  now.mockReturnValue(date("2027-03-14T09:00Z"));
  await owner.mutation(api.dismiss, action(await get("restored")));
  expect(await get("restored")).toMatchObject({ dormant: true, revision: 2, dueAt: date("2027-03-15T08:30Z") });
});

test("internal firing claims the current due revision once and rollover preserves its history", async () => {
  const dueAt = date("2027-01-10T12:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(dueAt - 1_000);
  const { t, owner, scope, create, get } = await fixture();
  const first = await create({ title: "Queued", dueAt, recurrence: { kind: "daily" } });
  const target = (row: typeof first) => ({
    ...scope, publicId: row.publicId, occurrencePublicId: row.occurrence.publicId, expectedRevision: row.revision,
  });
  expect(await t.mutation(api.fireDue, target(first))).toEqual({ status: "not_due", triggerAt: dueAt });
  expect(await t.mutation(api.rollover, target(first))).toMatchObject({ status: "not_fired" });
  await owner.mutation(api.update, { ...scope, ...operation(), publicId: first.publicId, expectedRevision: first.revision,
    patch: { title: "Replacement" } });
  const replacement = await get(first.publicId);
  clock.mockReturnValue(dueAt + 1_000);
  expect(await t.mutation(api.fireDue, target(first))).toEqual({ status: "stale" });
  expect(await t.mutation(api.rollover, target(first))).toEqual({ status: "stale" });
  const claims = await Promise.all([t.mutation(api.fireDue, target(replacement)), t.mutation(api.fireDue, target(replacement))]);
  expect(claims.map(result => result.status).sort()).toEqual(["already_fired", "fired"]);
  const fired = await get(first.publicId);
  expect(fired).toMatchObject({ state: "fired", revision: replacement.revision, dormant: false,
    occurrence: { publicId: replacement.occurrence.publicId, state: "fired", deliveryState: "disabled" } });
  expect(fired).not.toHaveProperty("nextTriggerAt");
  expect((await owner.query(api.due, { ...scope, asOf: dueAt + 1_000 })).items).toEqual([
    expect.objectContaining({ state: "fired", overdue: true }),
  ]);

  clock.mockReturnValue(date("2027-01-13T14:00Z"));
  const rollover = await t.mutation(api.rollover, target(fired));
  expect(rollover).toMatchObject({ status: "advanced", revision: fired.revision + 1, dueAt: date("2027-01-14T12:00Z") });
  expect(await t.mutation(api.rollover, target(fired))).toMatchObject({ status: "already_advanced" });
  expect(await t.mutation(api.fireDue, target(fired))).toMatchObject({ status: "already_fired" });
  expect(await get(first.publicId)).toMatchObject({ state: "pending", dueAt: rollover.dueAt });
  expect((await owner.query(api.due, scope)).items).toEqual([]);
  const history = await owner.query(api.history, { ...scope, ...page });
  expect(history.page).toHaveLength(3);
  expect(history.page).toEqual(expect.arrayContaining([
    expect.objectContaining({ publicId: first.occurrence.publicId, state: "cancelled" }),
    expect.objectContaining({ publicId: fired.occurrence.publicId, state: "fired", deliveryState: "disabled",
      firedAt: expect.any(Number), rolledOverAt: expect.any(Number) }),
    expect.objectContaining({ dueAt: rollover.dueAt, state: "pending" }),
  ]));
  expect(await t.run(({ db }) => db.system.query("_scheduled_functions").collect())).toEqual([]);
});

test("metadata edits after firing preserve the firing time without making the reminder claimable again", async () => {
  const dueAt = date("2027-01-10T12:00Z");
  vi.spyOn(Date, "now").mockReturnValue(dueAt + 1_000);
  const { t, owner, scope, create, get } = await fixture();
  const first = await create({ title: "Original", dueAt, recurrence: { kind: "daily" } });
  const target = (row: typeof first) => ({
    ...scope, publicId: row.publicId, occurrencePublicId: row.occurrence.publicId, expectedRevision: row.revision,
  });
  const claim = await t.mutation(api.fireDue, target(first));
  await owner.mutation(api.update, { ...scope, ...operation(), publicId: first.publicId, expectedRevision: first.revision,
    patch: { description: "Updated metadata" } });
  const revised = await get(first.publicId);
  expect(revised.occurrence.publicId).not.toBe(first.occurrence.publicId);
  expect(revised).toMatchObject({ state: "fired", occurrence: { firedAt: claim.firedAt } });
  expect(await t.mutation(api.fireDue, target(revised))).toEqual({ status: "already_fired", firedAt: claim.firedAt });
  expect(await t.mutation(api.rollover, target(revised))).toMatchObject({ status: "advanced" });
});

test("workspace backup preserves the wall-clock recurrence anchor and drops firing history", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(date("2027-03-13T09:00Z"));
  const { owner, scope, create, action } = await fixture();
  const first = await create({ title: "Preserve anchor", dueAt: date("2027-03-13T08:30Z"), timezone: "America/Chicago",
    recurrence: { kind: "daily" } });
  await owner.mutation(api.dismiss, action(first));
  const { archive } = await owner.query(anyApi.backups.exportWorkspace, scope);
  const restored = await owner.mutation(anyApi.backups.restoreWorkspace, { archive, ...operation() });
  const restoredScope = { workspaceId: restored.workspaceId };
  const readRestored = () => owner.query(api.get, { ...restoredScope, publicId: first.publicId });
  const gap = await readRestored();
  expect(gap).toMatchObject({ dueAt: date("2027-03-14T08:00Z"), dormant: true });
  expect((await owner.query(api.history, { ...restoredScope, ...page })).page).toEqual([]);
  now.mockReturnValue(date("2027-03-14T09:00Z"));
  await owner.mutation(api.dismiss, { ...action(gap), ...restoredScope });
  expect(await readRestored()).toMatchObject({ dueAt: date("2027-03-15T07:30Z"), dormant: true });
});

test("default recurrence timezone follows workspace owner preferences and rejects invalid rules", async () => {
  const { t, ownerId, planner, scope, get } = await fixture();
  await t.run(({ db }) => db.insert("preferences", { ...scope, ...recordVersion, userId: ownerId, publicId: "owner-prefs",
    timezone: "America/Chicago", workHours: [], notificationSettings: { enabled: true, webPush: true, native: true },
    autonomyPolicy: { planApplication: "review", lockManuallyMovedBlocks: true }, importFilters: [] }));
  const reminder = { title: "Rule", dueAt: date("2027-01-01T15:00Z") };
  await expect(planner.mutation(api.create, { ...scope, ...operation(), reminder: {
    ...reminder, recurrence: { kind: "weekly", weekdays: [] },
  } })).rejects.toThrow(/INVALID_ARGUMENT/);
  await expect(planner.mutation(api.create, { ...scope, ...operation(), reminder: {
    ...reminder, timezone: "+01:00",
  } })).rejects.toThrow(/INVALID_ARGUMENT/);
  const result = await planner.mutation(api.create, { ...scope, ...operation(), reminder: {
    ...reminder, recurrence: { kind: "daily" },
  } });
  expect(await get(result.targetPublicId)).toMatchObject({ timezone: "America/Chicago", recurrenceBasis: "local_timezone",
    occurrence: { deliveryState: "disabled" } });
});
