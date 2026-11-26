import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { deliveryConfiguration, openSubscription } from "./model/deliverySecrets";
import { activeGrant, armDelivery, armRollover, claimWaitMs, clearPrivateSubscription, deliveryWindowMs, maxAttempts,
  effectiveTrigger, eligibleRoutes, enqueueAttempt, enqueueRecovery, reconcileRef, secretRow,
  type PushPayload, workspaceDeviceLimit } from "./model/deliveryStore";
import { claimTarget, markOccurrenceFired, storedOccurrence } from "./model/reminderStore";

type Occurrence = Doc<"reminderOccurrences">;
type Attempt = Doc<"deliveryAttempts">;
const attemptKey = { attemptId: v.id("deliveryAttempts") };
const outcomeValidator = v.union(
  v.object({ kind: v.union(v.literal("accepted"), v.literal("gone"), v.literal("rejected")), providerStatus: v.number() }),
  v.object({ kind: v.literal("retry"), providerStatus: v.literal(429), retryAfterMs: v.number() }),
  v.object({ kind: v.literal("uncertain"), providerStatus: v.optional(v.number()),
    code: v.union(v.literal("transport_uncertain"), v.literal("provider_uncertain")) }),
  v.object({ kind: v.literal("failed"), code: v.union(v.literal("request_preparation"), v.literal("delivery_disabled")) }),
);

async function matchingReminder(db: DatabaseReader, occurrence: Occurrence) {
  const reminder = await db.get("reminders", occurrence.reminderId);
  if (reminder?.workspaceId !== occurrence.workspaceId) return null;
  const target = await claimTarget(db, occurrence.workspaceId, reminder.publicId, occurrence.reminderRevision, occurrence.publicId);
  return target.status === "current" && target.occurrence._id === occurrence._id ? target.reminder : null;
}

async function currentRoute(db: DatabaseReader, attempt: Attempt) {
  if (!attempt.subscriptionId) return null;
  const route = await db.get("pushSubscriptions", attempt.subscriptionId);
  if (!route || route.workspaceId !== attempt.workspaceId || route.userId !== attempt.userId ||
      route.deviceId !== attempt.deviceId || route.revision !== attempt.subscriptionRevision) return null;
  return route;
}

async function eligibleAttempt(db: DatabaseReader, attempt: Attempt, now: number) {
  const [occurrence, route, workspace] = await Promise.all([
    db.get("reminderOccurrences", attempt.occurrenceId), currentRoute(db, attempt),
    db.get("workspaces", attempt.workspaceId),
  ]);
  if (!workspace || !route || occurrence?.workspaceId !== attempt.workspaceId || occurrence.state !== "fired" ||
      occurrence.occurrenceKey !== attempt.occurrenceKey || occurrence.firedAt === undefined) return null;
  const trigger = effectiveTrigger(occurrence);
  if (now < trigger || now >= trigger + deliveryWindowMs || !await activeGrant(db, route, trigger)) return null;
  const reminder = await matchingReminder(db, occurrence);
  return reminder ? { occurrence, reminder, route, workspace, trigger } : null;
}

function settle(ctx: MutationCtx, attempt: Attempt, now: number,
  fields: Pick<Attempt, "status"> & Partial<Pick<Attempt, "error" | "providerStatus" | "acceptedAt">>) {
  const { status, error, providerStatus, acceptedAt } = fields;
  return ctx.db.patch("deliveryAttempts", attempt._id, { status, error, providerStatus, acceptedAt,
    finishedAt: now, leaseUntil: undefined, revision: attempt.revision + 1, updatedAt: now });
}

async function refreshOccurrenceDelivery(db: MutationCtx["db"], attempt: Attempt, now: number) {
  const occurrence = await db.get("reminderOccurrences", attempt.occurrenceId);
  if (occurrence?.state !== "fired" || occurrence.workspaceId !== attempt.workspaceId ||
      occurrence.deliveryState === "accepted_by_provider" || !await matchingReminder(db, occurrence)) return;
  const maximum = workspaceDeviceLimit * maxAttempts;
  const rows = await db.query("deliveryAttempts").withIndex("by_workspace_occurrence_subscription", q =>
    q.eq("workspaceId", occurrence.workspaceId).eq("occurrenceKey", occurrence.occurrenceKey)).take(maximum + 1);
  if (!rows.length || rows.length > maximum) return;
  let deliveryState: Occurrence["deliveryState"];
  if (rows.some(row => row.acceptedAt !== undefined)) deliveryState = "accepted_by_provider";
  else if (rows.some(row => row.status === "uncertain" || row.status === "acknowledged" || row.status === "attempted")) {
    deliveryState = "attempted";
  } else if (rows.some(row => row.status === "scheduled")) deliveryState = "scheduled";
  else deliveryState = rows.every(row => row.status === "cancelled") ? "cancelled" : "failed";
  if (deliveryState !== occurrence.deliveryState) {
    await db.patch("reminderOccurrences", occurrence._id, { deliveryState, revision: occurrence.revision + 1, updatedAt: now });
  }
}

async function retry(ctx: MutationCtx, attempt: Attempt, now: number, retryAfterMs: number) {
  if (!deliveryConfiguration() || !Number.isFinite(retryAfterMs)) return;
  const target = await eligibleAttempt(ctx.db, attempt, now);
  if (!target) return;
  const delay = Math.max(1_000, Math.min(deliveryWindowMs, Math.ceil(retryAfterMs)));
  await enqueueAttempt(ctx, target.occurrence, target.route, now, now + delay, attempt);
}

export const reconcile = internalMutation({
  args: { workspaceId: v.id("workspaces"), state: v.union(v.literal("pending"), v.literal("snoozed")),
    after: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { workspaceId, state, after, cursor }) => {
    const now = Date.now();
    if (!deliveryConfiguration() || !(await eligibleRoutes(ctx.db, workspaceId, now)).length) return;
    const rows = await ctx.db.query("reminders").withIndex("by_workspace_state_trigger", q =>
      q.eq("workspaceId", workspaceId).eq("state", state).gte("nextTriggerAt", after))
      .paginate({ numItems: 32, cursor, maximumRowsRead: 40 });
    for (const reminder of rows.page) {
      const occurrence = await storedOccurrence(ctx.db, reminder);
      if (occurrence) await armDelivery(ctx, occurrence, now, true);
    }
    if (!rows.isDone) await ctx.scheduler.runAfter(0, reconcileRef, { workspaceId, state, after, cursor: rows.continueCursor });
  },
});

export const dispatch = internalMutation({
  args: { occurrenceId: v.id("reminderOccurrences") },
  handler: async (ctx, { occurrenceId }) => {
    const occurrence = await ctx.db.get("reminderOccurrences", occurrenceId);
    if (!occurrence?.jobId || (occurrence.state !== "pending" && occurrence.state !== "snoozed")) return;
    const now = Date.now();
    const trigger = effectiveTrigger(occurrence);
    if (now < trigger) return;
    const reminder = await matchingReminder(ctx.db, occurrence);
    if (!reminder) return;
    const routes = deliveryConfiguration() && now < trigger + deliveryWindowMs
      ? await eligibleRoutes(ctx.db, occurrence.workspaceId, trigger) : [];
    if (!routes.length) {
      await ctx.db.patch("reminderOccurrences", occurrenceId, { jobId: undefined, deliveryState: "disabled" });
      return;
    }
    await markOccurrenceFired(ctx.db, reminder, occurrence, now);
    for (const route of routes) await enqueueAttempt(ctx, occurrence, route, now, now);
    await armRollover(ctx, reminder, { ...occurrence, firedAt: now }, now);
  },
});

export const claim = internalMutation({
  args: attemptKey,
  handler: async (ctx, { attemptId }) => {
    const now = Date.now();
    const attempt = await ctx.db.get("deliveryAttempts", attemptId);
    if (!attempt || attempt.channel !== "web_push" || attempt.status !== "scheduled" || attempt.leaseUntil === undefined ||
        now < attempt.leaseUntil - claimWaitMs || now >= attempt.leaseUntil) return null;
    const config = deliveryConfiguration();
    const target = config ? await eligibleAttempt(ctx.db, attempt, now) : null;
    if (!config || !target) {
      await settle(ctx, attempt, now, { status: "cancelled", error: { code: config ? "stale_or_revoked" : "delivery_disabled" } });
      await refreshOccurrenceDelivery(ctx.db, attempt, now);
      return null;
    }
    const { route, occurrence, reminder, workspace, trigger } = target;
    const envelope = await secretRow(ctx.db, route._id);
    const subscription = envelope ? await openSubscription(config.storage, route, envelope) : null;
    if (!subscription) {
      await settle(ctx, attempt, now, { status: "failed", error: { code: "subscription_unreadable" } });
      // The affected device must explicitly register again with a valid envelope.
      await clearPrivateSubscription(ctx.db, route._id);
      await ctx.db.patch("pushSubscriptions", route._id, { revokedAt: now, approvedAt: undefined, subscriptionHash: undefined,
        secretRef: undefined, revision: route.revision + 1, updatedAt: now });
      await refreshOccurrenceDelivery(ctx.db, attempt, now);
      return null;
    }
    const leaseUntil = now + claimWaitMs;
    await ctx.db.patch("deliveryAttempts", attemptId, { status: "attempted", attemptedAt: now,
      leaseUntil, revision: attempt.revision + 1, updatedAt: now });
    await enqueueRecovery(ctx, attemptId, leaseUntil);
    if (occurrence.deliveryState === "scheduled") {
      await ctx.db.patch("reminderOccurrences", occurrence._id, { deliveryState: "attempted",
        revision: occurrence.revision + 1, updatedAt: now });
    }
    const payload: PushPayload = { version: 1, kind: "klaxon.reminder", workspacePublicId: workspace.publicId,
      reminderPublicId: reminder.publicId, occurrencePublicId: occurrence.publicId, reminderRevision: reminder.revision,
      subscriptionPublicId: route.publicId, attemptPublicId: attempt.publicId, dueAt: trigger, title: "Klaxon reminder" };
    return { subscription, payload, expiresAt: trigger + deliveryWindowMs };
  },
});

export const finish = internalMutation({
  args: { ...attemptKey, outcome: outcomeValidator },
  handler: async (ctx, { attemptId, outcome }) => {
    const attempt = await ctx.db.get("deliveryAttempts", attemptId);
    if (!attempt || attempt.channel !== "web_push" || attempt.attemptedAt === undefined ||
        !["attempted", "acknowledged", "uncertain"].includes(attempt.status) ||
        (attempt.finishedAt !== undefined && !(attempt.status === "uncertain" && outcome.kind === "accepted"))) return;
    const now = Date.now();
    const providerStatus = "providerStatus" in outcome ? outcome.providerStatus : undefined;
    const acknowledged = attempt.acknowledgedAt !== undefined;
    if (outcome.kind === "accepted") {
      await settle(ctx, attempt, now, { status: acknowledged ? "acknowledged" : "accepted_by_provider", providerStatus, acceptedAt: now });
      await refreshOccurrenceDelivery(ctx.db, attempt, now);
      return;
    }
    const code = "code" in outcome ? outcome.code : outcome.kind === "gone" ? "subscription_gone"
      : outcome.kind === "retry" ? "rate_limited" : "provider_rejected";
    await settle(ctx, attempt, now, { status: acknowledged ? "acknowledged" : outcome.kind === "uncertain" ? "uncertain" : "failed",
      providerStatus, error: { code } });
    if (outcome.kind === "gone") {
      const route = await currentRoute(ctx.db, attempt);
      if (route) {
        await clearPrivateSubscription(ctx.db, route._id);
        await ctx.db.patch("pushSubscriptions", route._id, { revokedAt: now, approvedAt: undefined, subscriptionHash: undefined,
          secretRef: undefined, revision: route.revision + 1, updatedAt: now });
      }
    } else if (outcome.kind === "retry" && !acknowledged) {
      await retry(ctx, attempt, now, outcome.retryAfterMs);
    }
    await refreshOccurrenceDelivery(ctx.db, attempt, now);
  },
});

export const recover = internalMutation({
  args: attemptKey,
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get("deliveryAttempts", attemptId);
    const now = Date.now();
    if (!attempt || attempt.channel !== "web_push" || attempt.leaseUntil === undefined || now < attempt.leaseUntil) return;
    if (attempt.status === "attempted") {
      await settle(ctx, attempt, now, { status: "uncertain", error: { code: "claim_outcome_unknown" } });
    } else if (attempt.status === "scheduled") {
      await settle(ctx, attempt, now, { status: "failed", error: { code: "action_not_started" } });
      await retry(ctx, attempt, now, 1_000);
    } else if (attempt.status === "acknowledged" && attempt.finishedAt === undefined) {
      await settle(ctx, attempt, now, { status: "acknowledged" });
    } else {
      return;
    }
    await refreshOccurrenceDelivery(ctx.db, attempt, now);
  },
});
