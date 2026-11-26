import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter, MutationCtx } from "../_generated/server";
import { authorize } from "./access";
import { calendarError } from "./calendarTime";
import { deliveryConfiguration, type WebSubscription } from "./deliverySecrets";

export const deliveryWindowMs = 5 * 60_000;
export const claimWaitMs = 45_000;
export const maxAttempts = 3;
export const workspaceDeviceLimit = 32;
export const userDeviceLimit = 64;
type WorkspaceId = Id<"workspaces">;
type UserId = Id<"users">;
type Occurrence = Doc<"reminderOccurrences">;
type Route = Doc<"pushSubscriptions">;
type Attempt = Doc<"deliveryAttempts">;
type AttemptArgs = { attemptId: Id<"deliveryAttempts"> };

export type PushPayload = {
  version: 1;
  kind: "klaxon.reminder";
  workspacePublicId: string;
  reminderPublicId: string;
  occurrencePublicId: string;
  reminderRevision: number;
  subscriptionPublicId: string;
  attemptPublicId: string;
  dueAt: number;
  title: "Klaxon reminder";
};

export type TransportOutcome =
  | { kind: "accepted" | "gone" | "rejected"; providerStatus: number }
  | { kind: "retry"; providerStatus: 429; retryAfterMs: number }
  | { kind: "uncertain"; providerStatus?: number; code: "transport_uncertain" | "provider_uncertain" }
  | { kind: "failed"; code: "request_preparation" | "delivery_disabled" };

type Claimed = { subscription: WebSubscription; payload: PushPayload; expiresAt: number };

export const reconcileRef = makeFunctionReference<"mutation", {
  workspaceId: WorkspaceId; state: "pending" | "snoozed"; after: number; cursor: string | null;
}>("deliveryWorker:reconcile");
const dispatchRef = makeFunctionReference<"mutation", { occurrenceId: Id<"reminderOccurrences"> }>("deliveryWorker:dispatch");
const sendRef = makeFunctionReference<"action", AttemptArgs>("deliveryTransport:send");
const recoverRef = makeFunctionReference<"mutation", AttemptArgs>("deliveryWorker:recover");
export const claimRef = makeFunctionReference<"mutation", AttemptArgs, Claimed | null>("deliveryWorker:claim");
export const finishRef = makeFunctionReference<"mutation", AttemptArgs & { outcome: TransportOutcome }>("deliveryWorker:finish");
export const rolloverRef = makeFunctionReference<"mutation", {
  workspaceId: WorkspaceId; publicId: string; expectedRevision: number; occurrencePublicId: string;
}>("reminders:rollover");

export function grantRow(db: DatabaseReader, workspaceId: WorkspaceId, userId: UserId) {
  return db.query("pushDeliveryGrants").withIndex("by_workspace_user", q =>
    q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
}

export function deviceRow(db: DatabaseReader, workspaceId: WorkspaceId, userId: UserId, deviceId: string) {
  return db.query("pushSubscriptions").withIndex("by_workspace_user_device", q =>
    q.eq("workspaceId", workspaceId).eq("userId", userId).eq("deviceId", deviceId).eq("channel", "web_push")).unique();
}

export function secretRow(db: DatabaseReader, subscriptionId: Id<"pushSubscriptions">) {
  return db.query("pushSubscriptionSecrets").withIndex("by_subscription", q => q.eq("subscriptionId", subscriptionId)).unique();
}

export function checkDeviceId(deviceId: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(deviceId)) calendarError("INVALID_ARGUMENT", "Invalid device ID");
}

export function activeDevice(route: Route, at: number) {
  return route.channel === "web_push" && route.permission === "granted" && route.revokedAt === undefined &&
    route.approvedAt !== undefined && route.approvedAt <= at && route.subscriptionHash !== undefined;
}

export async function activeGrant(db: DatabaseReader, route: Route, at: number) {
  if (!activeDevice(route, at)) return false;
  const [grant, user, access] = await Promise.all([
    grantRow(db, route.workspaceId, route.userId),
    db.get("users", route.userId),
    authorize(db, route.workspaceId, route.userId, "read").catch((error: unknown) => {
      if (error instanceof ConvexError && error.data === "WORKSPACE_UNAVAILABLE") return null;
      throw error;
    }),
  ]);
  return !!(user && access && grant?.enabled && grant.enabledAt !== undefined && grant.enabledAt <= at);
}

export function activeRoutes(db: DatabaseReader, workspaceId: WorkspaceId) {
  return db.query("pushSubscriptions").withIndex("by_workspace_channel", q =>
    q.eq("workspaceId", workspaceId).eq("channel", "web_push").eq("revokedAt", undefined)).take(workspaceDeviceLimit + 1);
}

export async function eligibleRoutes(db: DatabaseReader, workspaceId: WorkspaceId, at: number) {
  const routes = await activeRoutes(db, workspaceId);
  const valid = await Promise.all(routes.map(route => activeGrant(db, route, at)));
  return routes.filter((_, index) => valid[index]);
}

export async function clearPrivateSubscription(db: DatabaseWriter, subscriptionId: Id<"pushSubscriptions">) {
  const secret = await secretRow(db, subscriptionId);
  if (secret) await db.delete("pushSubscriptionSecrets", secret._id);
}

export function effectiveTrigger(row: { snoozeUntil?: number; dueAt: number }) {
  return row.snoozeUntil ?? row.dueAt;
}

export async function enqueueReconciliation(ctx: MutationCtx, workspaceId: WorkspaceId, now: number) {
  if (!deliveryConfiguration() || !(await eligibleRoutes(ctx.db, workspaceId, now)).length) return;
  for (const state of ["pending", "snoozed"] as const) {
    await ctx.scheduler.runAfter(0, reconcileRef, { workspaceId, state, after: now, cursor: null });
  }
}

export async function armDelivery(ctx: MutationCtx, occurrence: Occurrence, now: number, alreadyEligible = false) {
  if (occurrence.jobId || (occurrence.state !== "pending" && occurrence.state !== "snoozed")) return;
  const trigger = effectiveTrigger(occurrence);
  if (trigger + deliveryWindowMs <= now || !deliveryConfiguration()) return;
  if (!alreadyEligible && !(await eligibleRoutes(ctx.db, occurrence.workspaceId, trigger)).length) return;
  const jobId = await ctx.scheduler.runAt(Math.max(trigger, now), dispatchRef, { occurrenceId: occurrence._id });
  await ctx.db.patch("reminderOccurrences", occurrence._id, { jobId, deliveryState: "scheduled",
    revision: occurrence.revision + 1, updatedAt: now });
}

export async function armRollover(ctx: MutationCtx, reminder: Doc<"reminders">, occurrence: Occurrence, now: number) {
  if (!reminder.recurrence || !deliveryConfiguration() || occurrence.firedAt === undefined) return;
  const jobId = await ctx.scheduler.runAt(Math.max(now, effectiveTrigger(occurrence) + deliveryWindowMs), rolloverRef, {
    workspaceId: occurrence.workspaceId, publicId: reminder.publicId, expectedRevision: reminder.revision,
    occurrencePublicId: occurrence.publicId,
  });
  await ctx.db.patch("reminderOccurrences", occurrence._id, { jobId });
}

export function latestAttempt(db: DatabaseReader, occurrence: Occurrence, subscriptionId: Id<"pushSubscriptions">) {
  return db.query("deliveryAttempts").withIndex("by_workspace_occurrence_subscription", q =>
    q.eq("workspaceId", occurrence.workspaceId).eq("occurrenceKey", occurrence.occurrenceKey)
      .eq("subscriptionId", subscriptionId)).order("desc").first();
}

export async function enqueueAttempt(ctx: MutationCtx, occurrence: Occurrence, route: Route,
  now: number, startAt: number, previous?: Attempt) {
  const prior = await latestAttempt(ctx.db, occurrence, route._id);
  if (prior?._id !== previous?._id) return;
  const attempt = (prior?.attempt ?? 0) + 1;
  if (attempt > maxAttempts || startAt >= effectiveTrigger(occurrence) + deliveryWindowMs) return;
  const leaseUntil = startAt + claimWaitMs;
  const attemptId = await ctx.db.insert("deliveryAttempts", {
    workspaceId: occurrence.workspaceId, occurrenceId: occurrence._id, occurrenceKey: occurrence.occurrenceKey,
    subscriptionId: route._id, subscriptionRevision: route.revision, userId: route.userId, deviceId: route.deviceId,
    channel: "web_push", attempt, status: "scheduled", leaseUntil,
    publicId: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now,
  });
  await ctx.scheduler.runAt(startAt, sendRef, { attemptId });
  await ctx.scheduler.runAt(leaseUntil, recoverRef, { attemptId });
}

export function enqueueRecovery(ctx: MutationCtx, attemptId: Id<"deliveryAttempts">, leaseUntil: number) {
  return ctx.scheduler.runAt(leaseUntil, recoverRef, { attemptId });
}
