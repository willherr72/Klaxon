import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

const api = anyApi.delivery;
const page = { paginationOpts: { cursor: null, numItems: 40 } };
// P-256 generator point and disposable fixture bytes. Tests never send a request.
const p256dh = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const auth = "AAAAAAAAAAAAAAAAAAAAAA";
const endpoint = "https://fcm.googleapis.com/fcm/send/fixture";
const subscription = { endpoint, keys: { p256dh, auth } };
const write = (expectedRevision = 0) => ({ operationId: crypto.randomUUID(), expectedRevision });
const device = { deviceId: "test-device" };

function configure() {
  vi.stubEnv("KLAXON_WEB_PUSH_ENABLED", "true");
  vi.stubEnv("KLAXON_WEB_PUSH_STORAGE_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_SUBJECT", "mailto:push@example.invalid");
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_PUBLIC_KEY", p256dh);
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_PRIVATE_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/delivery.ts": () => import("../convex/delivery"),
    "../convex/deliveryWorker.ts": () => import("../convex/deliveryWorker"),
    "../convex/deliveryTransport.ts": () => import("../convex/deliveryTransport"),
    "../convex/reminders.ts": () => import("../convex/reminders"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
  const [ownerId, readerId, outsiderId] = await t.run(async ({ db }) =>
    Promise.all([db.insert("users", {}), db.insert("users", {}), db.insert("users", {})]));
  const owner = t.withIdentity({ subject: ownerId });
  const reader = t.withIdentity({ subject: readerId });
  const outsider = t.withIdentity({ subject: outsiderId });
  const { _id: workspaceId } = await owner.mutation(anyApi.workspaces.ensurePersonal, {});
  await t.run(({ db }) => db.insert("memberships", { workspaceId, userId: readerId, role: "reader", publicId: "reader", ...recordVersion }));
  const scope = { workspaceId };
  const status = () => owner.query(api.status, { ...scope, ...device });
  const enable = () => owner.mutation(api.setEnabled, { ...scope, ...write(), enabled: true });
  const registration = { ...scope, ...device, permission: "granted", subscription } as const;
  const register = (expectedRevision = 0) => owner.mutation(api.register, { ...registration, ...write(expectedRevision) });
  return { t, owner, ownerId, reader, outsider, scope, status, enable, register, registration };
}

test("delivery defaults disabled and requires both a user grant and device registration", async () => {
  vi.stubEnv("KLAXON_WEB_PUSH_ENABLED", "false");
  const { owner, outsider, scope, status, enable, register } = await fixture();
  expect(await status()).toEqual({ available: false, enabled: false, grantRevision: 0, device: null });
  await expect(enable()).rejects.toThrow(/DELIVERY_UNAVAILABLE/);
  await expect(register()).rejects.toThrow(/DELIVERY_UNAVAILABLE/);
  await expect(outsider.query(api.status, { ...scope, ...device })).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);

  configure();
  await expect(register()).rejects.toThrow(/DELIVERY_NOT_ENABLED/);
  await enable();
  expect(await status()).toMatchObject({ enabled: true, available: true, grantRevision: 1, device: null, publicKey: p256dh });
  await owner.mutation(api.setPermission, { ...scope, ...device, ...write(), permission: "denied" });
  expect(await status()).toMatchObject({ device: { permission: "denied", active: false, revision: 1 } });
  await register(1);
  expect(await status()).toMatchObject({ device: { permission: "granted", active: true, revision: 2 } });
});

test("subscription rotation preserves private storage and rejects a stale or replayed revoke", async () => {
  configure();
  const { t, owner, reader, scope, status, enable, registration } = await fixture();
  await enable();
  const initial = { ...registration, ...write() };
  const receipt = await owner.mutation(api.register, initial);
  expect(await owner.mutation(api.register, initial)).toEqual(receipt);
  const revoke = { ...scope, ...device, ...write(1) };
  await owner.mutation(api.revoke, revoke);
  expect(await t.run(({ db }) => db.query("pushSubscriptionSecrets").collect())).toEqual([]);
  const nextEndpoint = "https://fixture.notify.windows.com/new-fixture";
  await owner.mutation(api.register, { ...registration, ...write(2), subscription: { ...subscription, endpoint: nextEndpoint } });
  expect(await owner.mutation(api.revoke, revoke)).toMatchObject({ revision: 2 });
  await expect(owner.mutation(api.revoke, { ...revoke, ...write(1) })).rejects.toThrow(/REVISION_CONFLICT/);
  expect(await status()).toMatchObject({ device: { active: true, revision: 3 } });
  const storage = await t.run(async ({ db }) => ({ routes: await db.query("pushSubscriptions").collect(),
    secrets: await db.query("pushSubscriptionSecrets").collect(), receipts: await db.query("operationReceipts").collect() }));
  expect(storage.secrets).toHaveLength(1);
  expect(storage.secrets[0]).toMatchObject({ sealed: expect.any(String), iv: expect.any(String) });
  for (const privateValue of [nextEndpoint, endpoint, p256dh, auth]) expect(JSON.stringify(storage)).not.toContain(privateValue);
  expect(await reader.query(api.status, { ...scope, ...device })).toMatchObject({ enabled: false, device: null });
  expect((await reader.query(api.history, { ...scope, ...page })).page).toEqual([]);
});

test.each([
  "http://fcm.googleapis.com/fixture",
  "https://fcm.googleapis.com.evil.invalid/fixture",
  "https://fcm.googleapis.com:443/fixture",
  "https://name@fixture.notify.windows.com/fixture",
  "https://notify.windows.com/fixture",
  "https://127.0.0.1/fixture",
  "https://fcm.googleapis.com/fixture#fragment",
])("register rejects an unsupported push endpoint %s", async badEndpoint => {
  configure();
  const { owner, enable, registration } = await fixture();
  await enable();
  await expect(owner.mutation(api.register, { ...registration, ...write(),
    subscription: { ...subscription, endpoint: badEndpoint } })).rejects.toThrow(/INVALID_SUBSCRIPTION/);
});

async function liveFixture() {
  const now = Date.parse("2027-01-01T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  configure();
  const helpers = await fixture();
  await helpers.enable();
  await helpers.register();
  const dueAt = now + 60_000;
  const args = { ...helpers.scope, operationId: crypto.randomUUID(), reminder: { title: "Private title", dueAt } };
  const created = await helpers.owner.mutation(anyApi.reminders.create, args);
  const reminder = () => helpers.owner.query(anyApi.reminders.get, { ...helpers.scope, publicId: created.targetPublicId });
  const occurrences = () => helpers.t.run(({ db }) => db.query("reminderOccurrences").collect());
  const attempts = () => helpers.t.run(({ db }) => db.query("deliveryAttempts").collect());
  const system = () => helpers.t.run(({ db }) => db.system.query("_scheduled_functions").collect());
  return { ...helpers, dueAt, clock, created, reminder, occurrences, attempts, system };
}

test("an edit atomically cancels its old job and dispatch selects just the current due revision", async () => {
  const h = await liveFixture();
  const worker = anyApi.deliveryWorker;
  const [first] = await h.occurrences();
  expect(first.jobId).toBeDefined();
  const jobs = await h.system();
  expect(jobs.find(row => row._id === first.jobId)?.scheduledTime).toBe(h.dueAt);
  await h.owner.mutation(anyApi.reminders.update, { ...h.scope, ...write(1), publicId: h.created.targetPublicId,
    patch: { title: "New private title" } });
  const rows = await h.occurrences();
  const current = rows.find(row => row.reminderRevision === 2)!;
  expect(current.jobId).toBeDefined();
  expect((await h.system()).find(row => row._id === first.jobId)?.state.kind).toBe("canceled");
  h.clock.mockReturnValue(h.dueAt + 1);
  await h.t.mutation(worker.dispatch, { occurrenceId: first._id });
  expect(await h.attempts()).toEqual([]);
  await h.t.mutation(worker.dispatch, { occurrenceId: current._id });
  await h.t.mutation(worker.dispatch, { occurrenceId: current._id });
  const attempts = await h.attempts();
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  expect(attempt).toMatchObject({ status: "scheduled", occurrenceId: current._id, attempt: 1 });
  const claims = await Promise.all([h.t.mutation(worker.claim, { attemptId: attempt._id }),
    h.t.mutation(worker.claim, { attemptId: attempt._id })]);
  expect(claims.filter(value => value !== null)).toEqual([expect.objectContaining({
    subscription, payload: expect.objectContaining({ version: 1, kind: "klaxon.reminder", title: "Klaxon reminder",
      attemptPublicId: attempt.publicId, occurrencePublicId: current.publicId, reminderRevision: 2 }),
  })]);
  await h.t.mutation(worker.finish, { attemptId: attempt._id, outcome: { kind: "accepted", providerStatus: 201 } });
  expect((await h.reminder()).occurrence).toMatchObject({ state: "fired", deliveryState: "accepted_by_provider" });
  const history = await h.owner.query(api.history, { ...h.scope, ...page });
  expect(history.page).toEqual([expect.objectContaining({ status: "accepted_by_provider", providerStatus: 201 })]);
  expect(JSON.stringify(history)).not.toContain(endpoint);
  expect(JSON.stringify(history)).not.toContain("New private title");
  await expect(h.reader.mutation(api.acknowledge, { ...h.scope, ...device, attemptPublicId: attempt.publicId }))
    .rejects.toThrow(/ATTEMPT_UNAVAILABLE/);
  const ack = { ...h.scope, ...device, attemptPublicId: attempt.publicId };
  const result = await h.owner.mutation(api.acknowledge, ack);
  expect(await h.owner.mutation(api.acknowledge, ack)).toEqual(result);
  expect((await h.attempts())[0]).toMatchObject({ status: "acknowledged", acknowledgedAt: result.acknowledgedAt });
});

test("a scheduled action that never started gets a bounded replacement", async () => {
  const h = await liveFixture();
  const worker = anyApi.deliveryWorker;
  h.clock.mockReturnValue(h.dueAt + 1);
  const [row] = await h.occurrences();
  await h.t.mutation(worker.dispatch, { occurrenceId: row._id });
  const [first] = await h.attempts();
  h.clock.mockReturnValue(h.dueAt + 46_000);
  await h.t.mutation(worker.recover, { attemptId: first._id });
  await h.t.mutation(worker.recover, { attemptId: first._id });
  expect(await h.t.mutation(worker.claim, { attemptId: first._id })).toBeNull();
  expect(await h.attempts()).toEqual(expect.arrayContaining([
    expect.objectContaining({ attempt: 1, status: "failed", error: { code: "action_not_started" } }),
    expect.objectContaining({ attempt: 2, status: "scheduled" }),
  ]));
  expect(await h.attempts()).toHaveLength(2);
});

test("the registered action uses the offline provider response and cleans up an expired device", async () => {
  const h = await liveFixture();
  const worker = anyApi.deliveryWorker;
  const transport = vi.fn(async () => new Response(null, { status: 410 }));
  vi.stubGlobal("fetch", transport);
  h.clock.mockReturnValue(h.dueAt + 1);
  const [row] = await h.occurrences();
  await h.t.mutation(worker.dispatch, { occurrenceId: row._id });
  const [attempt] = await h.attempts();
  await h.t.action(anyApi.deliveryTransport.send, { attemptId: attempt._id });
  await h.t.action(anyApi.deliveryTransport.send, { attemptId: attempt._id });
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await h.attempts())[0]).toMatchObject({ status: "failed", providerStatus: 410, error: { code: "subscription_gone" } });
  expect(await h.status()).toMatchObject({ device: { active: false, revision: 2 } });
  expect(await h.t.run(({ db }) => db.query("pushSubscriptionSecrets").collect())).toEqual([]);
});

test("the scheduler runs the mutation-to-action path with a stubbed provider", async () => {
  const h = await liveFixture();
  const transport = vi.fn(async () => new Response(null, { status: 201 }));
  vi.stubGlobal("fetch", transport);
  h.clock.mockReturnValue(h.dueAt + 1);
  await h.t.finishAllScheduledFunctions(() => vi.runAllTimers());
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await h.attempts()).toEqual([expect.objectContaining({ status: "accepted_by_provider" })]);
});

test("device enrollment reconciles future occurrences and leaves dormant rows inert", async () => {
  const h = await fixture();
  configure();
  const after = Date.now();
  const dueAt = after + 60_000;
  await h.owner.mutation(anyApi.reminders.create, {
    ...h.scope, operationId: crypto.randomUUID(), reminder: { title: "Before enrollment", dueAt },
  });
  await h.t.run(({ db }) => db.insert("reminders", { ...h.scope, ...recordVersion, publicId: "restored", title: "Restored",
    priority: "normal", state: "pending", dueAt, nextTriggerAt: dueAt, timezone: "UTC" }));
  await h.enable();
  await h.register();
  await h.t.mutation(anyApi.deliveryWorker.reconcile, { ...h.scope, after, state: "pending", cursor: null });
  const rows = await h.t.run(({ db }) => db.query("reminderOccurrences").collect());
  expect(rows).toEqual([expect.objectContaining({ reminderTitle: "Before enrollment", jobId: expect.any(String) })]);
  const dormant = await h.owner.query(anyApi.reminders.get, { ...h.scope, publicId: "restored" });
  expect(dormant).toMatchObject({ dormant: true, occurrence: { deliveryState: "disabled" } });
});

test("only a proven retry is requeued, and an expired claimed send remains uncertain", async () => {
  const h = await liveFixture();
  const worker = anyApi.deliveryWorker;
  h.clock.mockReturnValue(h.dueAt + 1);
  const [row] = await h.occurrences();
  await h.t.mutation(worker.dispatch, { occurrenceId: row._id });
  const [first] = await h.attempts();
  expect(await h.t.mutation(worker.claim, { attemptId: first._id })).not.toBeNull();
  const limited = { attemptId: first._id, outcome: { kind: "retry", providerStatus: 429, retryAfterMs: 5_000 } };
  await h.t.mutation(worker.finish, limited);
  await h.t.mutation(worker.finish, limited);
  const attempts = await h.attempts();
  const second = attempts.find(row => row.attempt === 2)!;
  expect(attempts).toHaveLength(2);
  expect(await h.t.mutation(worker.claim, { attemptId: second._id })).toBeNull();
  h.clock.mockReturnValue(h.dueAt + 5_010);
  expect(await h.t.mutation(worker.claim, { attemptId: second._id })).not.toBeNull();
  h.clock.mockReturnValue(h.dueAt + 55_000);
  await h.t.mutation(worker.recover, { attemptId: second._id });
  await h.t.mutation(worker.recover, { attemptId: second._id });
  expect(await h.attempts()).toHaveLength(2);
  expect((await h.attempts()).find(row => row.attempt === 2)).toMatchObject({ status: "uncertain" });
});

test("a device revoked before its action starts is cancelled without releasing secrets or sending", async () => {
  const h = await liveFixture();
  const worker = anyApi.deliveryWorker;
  h.clock.mockReturnValue(h.dueAt + 1);
  const [row] = await h.occurrences();
  await h.t.mutation(worker.dispatch, { occurrenceId: row._id });
  const [attempt] = await h.attempts();
  await h.owner.mutation(api.revoke, { ...h.scope, ...device, ...write(1) });
  expect(await h.t.mutation(worker.claim, { attemptId: attempt._id })).toBeNull();
  expect((await h.attempts())[0]).toMatchObject({ status: "cancelled" });
  expect(await h.t.run(({ db }) => db.query("pushSubscriptionSecrets").collect())).toEqual([]);
  expect((await h.owner.query(anyApi.reminders.due, { ...h.scope, asOf: h.dueAt + 10 })).items)
    .toEqual([expect.objectContaining({ state: "fired", overdue: true })]);
});
