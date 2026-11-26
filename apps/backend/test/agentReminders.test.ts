import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { deliveryConfiguration } from "../convex/model/deliverySecrets";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

afterEach(() => vi.unstubAllEnvs());

const modules = {
  "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
  "../convex/agentReminders.ts": () => import("../convex/agentReminders"),
};

async function setup() {
  const t = convexTest({ schema, modules });
  const tokenHash = "a".repeat(64);
  const workspacePublicId = "reminders";
  const { workspaceId, credentialId } = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, workspacePublicId);
    const { ownerId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId: ownerId, role: "owner", publicId: "owner", ...recordVersion });
    await db.insert("tasks", taskRecord(workspaceId, "sample"));
    const other = await insertWorkspace(db, "other");
    await db.insert("tasks", taskRecord(other, "foreign-task"));
    const credentialId = await db.insert("agentCredentials", { workspaceId, userId: ownerId,
      publicId: "agent", label: "Scheduler", tokenHash, scopes: ["reminders:write"],
      expiresAt: Date.now() + 600_000, ...recordVersion });
    return { workspaceId, credentialId };
  });
  const dueAt = Date.now() + 3_600_000;
  const base = { tokenHash, workspacePublicId, reason: "Follow up on the selected task", publicId: "follow-up" };
  const createArgs = { ...base, reminder: { title: "  Check status  ", dueAt, taskPublicId: "sample" },
    operationId: crypto.randomUUID() };
  const create = (overrides = {}) => t.mutation(anyApi.agentReminders.create, { ...createArgs, ...overrides });
  const updateArgs = { ...base, operationId: crypto.randomUUID(), expectedRevision: 1, patch: { title: "Confirm status" } };
  const update = (overrides = {}) => t.mutation(anyApi.agentReminders.update, { ...updateArgs, ...overrides });
  return { t, workspaceId, credentialId, dueAt, base, create, update };
}

test("writes normalized stored reminder values and preserves exact replay after edits and deletion", async () => {
  const { t, workspaceId, credentialId, base, dueAt, create, update } = await setup();
  const added = await create();
  expect(added).toMatchObject({ publicId: "follow-up", revision: 1, reminder: { title: "Check status",
    timezone: "UTC", taskPublicId: "sample", priority: "normal", state: "pending", occurrencePublicId: expect.any(String) } });
  const edited = await update();
  expect(edited).toMatchObject({ revision: 2, reminder: { title: "Confirm status" } });
  expect(edited.reminder.occurrencePublicId).not.toBe(added.reminder.occurrencePublicId);
  expect(await create()).toEqual(added);
  await expect(update({ patch: { title: "Different title" } })).rejects.toThrow("OPERATION_ID_CONFLICT");
  await expect(update({ operationId: crypto.randomUUID() })).rejects.toThrow("REVISION_CONFLICT");
  const snoozeArgs = { ...base, operationId: crypto.randomUUID(), expectedRevision: 2,
    occurrencePublicId: edited.reminder.occurrencePublicId, snoozeUntil: dueAt + 900_000 };
  await expect(t.mutation(anyApi.agentReminders.snooze, { ...snoozeArgs, occurrencePublicId: added.reminder.occurrencePublicId }))
    .rejects.toThrow("OCCURRENCE_UNAVAILABLE");
  const snoozed = await t.mutation(anyApi.agentReminders.snooze, snoozeArgs);
  expect(snoozed).toMatchObject({ revision: 3, reminder: { state: "snoozed", dueAt, nextTriggerAt: snoozeArgs.snoozeUntil } });
  await t.run(async ({ db }) => {
    const row = await db.query("reminders").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", added.publicId)).unique();
    expect(row).toMatchObject({ revision: 3, nextTriggerAt: snoozeArgs.snoozeUntil });
    expect(await db.query("activityEvents").collect()).toMatchObject([
      { actor: { kind: "agent", credentialId }, reason: base.reason, action: "reminder.create" },
      { actor: { kind: "agent", credentialId }, reason: base.reason, action: "reminder.update" },
      { actor: { kind: "agent", credentialId }, reason: base.reason, action: "reminder.snooze" },
    ]);
    expect(await db.system.query("_scheduled_functions").collect()).toEqual([]);
    await db.delete("reminders", row!._id);
  });
  expect(await create()).toEqual(added);
  expect(await update()).toEqual(edited);
  expect(await t.mutation(anyApi.agentReminders.snooze, snoozeArgs)).toEqual(snoozed);
  await expect(create({ operationId: crypto.randomUUID() })).rejects.toThrow("ALREADY_EXISTS");
  await t.run(({ db }) => db.patch("agentCredentials", credentialId, { scopes: ["tasks:write"] }));
  await expect(create()).rejects.toThrow("FORBIDDEN");
});

test("isolates workspace and task IDs and rolls failed writes back", async () => {
  const { t, dueAt, create } = await setup();
  await expect(create({ workspacePublicId: "other" })).rejects.toThrow("AGENT_UNAUTHORIZED");
  await expect(create({ reminder: { title: "Check", dueAt, taskPublicId: "foreign-task" } })).rejects.toThrow("TASK_UNAVAILABLE");
  await create();
  await expect(create({ operationId: crypto.randomUUID() })).rejects.toThrow("ALREADY_EXISTS");
  const { reminders, receipts } = await t.run(async ({ db }) => ({
    reminders: await db.query("reminders").collect(), receipts: await db.query("operationReceipts").collect(),
  }));
  expect(reminders).toHaveLength(1);
  expect(receipts).toHaveLength(1);
});

test("server transport configuration alone does not enqueue notification delivery", async () => {
  vi.stubEnv("KLAXON_WEB_PUSH_ENABLED", "true");
  vi.stubEnv("KLAXON_WEB_PUSH_STORAGE_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_SUBJECT", "mailto:push@example.invalid");
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_PUBLIC_KEY",
    "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  vi.stubEnv("KLAXON_WEB_PUSH_VAPID_PRIVATE_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE");
  expect(deliveryConfiguration()).not.toBeNull();
  const { t, create, update, base, dueAt } = await setup();
  await create();
  await update();
  await t.mutation(anyApi.agentReminders.snooze, { ...base, operationId: crypto.randomUUID(),
    expectedRevision: 2, snoozeUntil: dueAt + 600_000 });
  const { jobs, occurrences } = await t.run(async ({ db }) => ({
    jobs: await db.system.query("_scheduled_functions").collect(),
    occurrences: await db.query("reminderOccurrences").collect(),
  }));
  expect(jobs).toEqual([]);
  expect(occurrences).toMatchObject([{ state: "cancelled", deliveryState: "disabled" },
    { state: "cancelled", deliveryState: "disabled" }, { state: "snoozed", deliveryState: "disabled" }]);
});
