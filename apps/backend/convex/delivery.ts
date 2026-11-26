import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { calendarError } from "./model/calendarTime";
import { deliveryConfiguration, deliveryDigest, openSubscription, sealSubscription, verifiedSubscription } from "./model/deliverySecrets";
import { activeDevice, activeRoutes, checkDeviceId, clearPrivateSubscription, deviceRow, enqueueReconciliation,
  grantRow, secretRow, userDeviceLimit, workspaceDeviceLimit } from "./model/deliveryStore";
import { requireExpectedRevision, runOperation, type OperationInput } from "./model/operations";
import { boundedPage } from "./model/pagination";

const scope = { workspaceId: v.id("workspaces") };
const device = { ...scope, deviceId: v.string() };
const change = { operationId: v.string(), expectedRevision: v.number() };
const permission = v.union(v.literal("default"), v.literal("denied"), v.literal("granted"));
const subscription = v.object({ endpoint: v.string(), keys: v.object({ p256dh: v.string(), auth: v.string() }) });

type WriteArgs = { workspaceId: Id<"workspaces">; operationId: string; expectedRevision: number };
type WriteDeviceArgs = WriteArgs & { deviceId: string };
type Device = Doc<"pushSubscriptions">;
type DeviceChange = Pick<Device, "permission" | "approvedAt" | "lastSeenAt" | "revokedAt" | "subscriptionHash" | "secretRef">;

function nextRevision(expected: number, current = 0) {
  requireExpectedRevision(expected, current);
  if (current === Number.MAX_SAFE_INTEGER) calendarError("INVALID_STATE");
  return current + 1;
}

async function writeDevice(ctx: MutationCtx, { workspaceId, deviceId }: WriteDeviceArgs, userId: Id<"users">,
  existing: Device | null, fields: DeviceChange, now: number, revision: number) {
  if (existing) {
    await ctx.db.patch("pushSubscriptions", existing._id, { ...fields, revision, updatedAt: now });
    return { _id: existing._id, workspaceId, userId, publicId: existing.publicId, revision };
  }
  const prior = await ctx.db.query("pushSubscriptions").withIndex("by_workspace_user_device", q =>
    q.eq("workspaceId", workspaceId).eq("userId", userId)).take(userDeviceLimit);
  if (prior.length >= userDeviceLimit) calendarError("DEVICE_LIMIT");
  const publicId = crypto.randomUUID();
  const id = await ctx.db.insert("pushSubscriptions", {
    ...fields, workspaceId, userId, deviceId, channel: "web_push", publicId, revision, createdAt: now, updatedAt: now,
  });
  return { _id: id, workspaceId, userId, publicId, revision };
}

async function deviceOperation(ctx: MutationCtx, args: WriteDeviceArgs, action: string, input: OperationInput,
  apply: (existing: Device | null, userId: Id<"users">, now: number, revision: number) =>
    Promise<Pick<Device, "_id" | "publicId" | "revision">>) {
  const { workspaceId, deviceId, expectedRevision, operationId } = args;
  const userId = requireSessionUser(await getAuthUserId(ctx));
  const { workspace } = await authorize(ctx.db, workspaceId, userId, "read");
  checkDeviceId(deviceId);
  return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action, operationId,
    expectedRevision: expectedRevision === 0 ? undefined : expectedRevision, input: { deviceId, expectedRevision, input },
  }, async ({ now }) => {
    const before = await deviceRow(ctx.db, workspaceId, userId, deviceId);
    const after = await apply(before, userId, now, nextRevision(expectedRevision, before?.revision));
    return { target: { kind: "push_subscription", id: after._id }, targetPublicId: after.publicId,
      revision: after.revision, beforeRevision: before?.revision };
  });
}

export const status = query({
  args: device,
  handler: async (ctx, { workspaceId, deviceId }) => {
    const { db } = ctx;
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(db, workspaceId, userId, "read");
    checkDeviceId(deviceId);
    const config = deliveryConfiguration();
    const [grant, row] = await Promise.all([grantRow(db, workspaceId, userId), deviceRow(db, workspaceId, userId, deviceId)]);
    const enabled = grant?.enabled === true;
    const device = row && { publicId: row.publicId, revision: row.revision, permission: row.permission ?? "default" as const,
      active: !!(config && enabled && activeDevice(row, Date.now()) && await secretRow(db, row._id)) };
    return { available: config !== null, enabled, grantRevision: grant?.revision ?? 0, publicKey: config?.vapid.publicKey, device };
  },
});

export const setEnabled = mutation({
  args: { ...scope, ...change, enabled: v.boolean() },
  handler: async (ctx, { workspaceId, enabled, operationId, expectedRevision }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "read");
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "delivery.setEnabled",
      expectedRevision: expectedRevision === 0 ? undefined : expectedRevision, operationId,
      input: { enabled, expectedRevision },
    }, async ({ db, now }) => {
      if (enabled && !deliveryConfiguration()) calendarError("DELIVERY_UNAVAILABLE");
      const previous = await grantRow(db, workspaceId, userId);
      const beforeRevision = previous?.revision;
      let revision = nextRevision(expectedRevision, beforeRevision);
      if (previous?.enabled === enabled && beforeRevision !== undefined && (!enabled || previous.enabledAt !== undefined)) {
        revision = beforeRevision;
      } else {
        const fields = { enabled, enabledAt: enabled ? now : undefined, updatedAt: now, revision };
        if (previous) await db.patch("pushDeliveryGrants", previous._id, fields);
        else await db.insert("pushDeliveryGrants", { ...fields, workspaceId, userId });
      }
      if (enabled) await enqueueReconciliation(ctx, workspaceId, now);
      return { target: { kind: "workspace", id: workspaceId }, targetPublicId: workspace.publicId, revision, beforeRevision };
    });
  },
});

export const register = mutation({
  args: { ...device, ...change, permission: v.literal("granted"), subscription },
  handler: async (ctx, { subscription, permission, ...args }) => {
    const verified = await verifiedSubscription(subscription);
    if (!verified) calendarError("INVALID_SUBSCRIPTION");
    const [subscriptionHash, fingerprint] = await Promise.all([
      deliveryDigest(verified.endpoint), deliveryDigest(JSON.stringify(verified)),
    ]);
    return deviceOperation(ctx, args, "delivery.register", { fingerprint, permission }, async (before, userId, now, revision) => {
      const config = deliveryConfiguration();
      if (!config) calendarError("DELIVERY_UNAVAILABLE");
      const { workspaceId } = args;
      if (!(await grantRow(ctx.db, workspaceId, userId))?.enabled) calendarError("DELIVERY_NOT_ENABLED");
      const duplicate = await ctx.db.query("pushSubscriptions").withIndex("by_workspace_subscription_hash", q =>
        q.eq("workspaceId", workspaceId).eq("subscriptionHash", subscriptionHash)).unique();
      if (duplicate && duplicate._id !== before?._id) calendarError("SUBSCRIPTION_IN_USE");
      if (!(before && activeDevice(before, now)) && (await activeRoutes(ctx.db, workspaceId)).length >= workspaceDeviceLimit) {
        calendarError("DEVICE_LIMIT");
      }
      const existingSecret = before ? await secretRow(ctx.db, before._id) : null;
      if (before && activeDevice(before, now) && existingSecret && before.subscriptionHash === subscriptionHash) {
        const prior = await openSubscription(config.storage, before, existingSecret);
        if (prior?.keys.p256dh === verified.keys.p256dh && prior.keys.auth === verified.keys.auth) {
          await enqueueReconciliation(ctx, workspaceId, now);
          return before;
        }
      }
      const route = await writeDevice(ctx, args, userId, before, {
        permission, subscriptionHash, approvedAt: now, lastSeenAt: now, revokedAt: undefined, secretRef: undefined,
      }, now, revision);
      const envelope = await sealSubscription(config.storage, route, verified);
      if (existingSecret) await ctx.db.patch("pushSubscriptionSecrets", existingSecret._id, envelope);
      else await ctx.db.insert("pushSubscriptionSecrets", { subscriptionId: route._id, ...envelope });
      await enqueueReconciliation(ctx, workspaceId, now);
      return route;
    });
  },
});

export const setPermission = mutation({
  args: { ...device, ...change, permission },
  handler: (ctx, { permission, ...args }) => deviceOperation(ctx, args, "delivery.setPermission", permission,
    async (before, userId, now, revision) => {
      if (before?.permission === permission && (permission === "granted" || before.revokedAt !== undefined)) return before;
      if (before) await clearPrivateSubscription(ctx.db, before._id);
      return writeDevice(ctx, args, userId, before, { permission, revokedAt: now, approvedAt: undefined,
        subscriptionHash: undefined, secretRef: undefined, lastSeenAt: now }, now, revision);
    }),
});

export const revoke = mutation({
  args: { ...device, ...change },
  handler: (ctx, args) => deviceOperation(ctx, args, "delivery.revoke", null, async (before, userId, now, revision) => {
    if (before) await clearPrivateSubscription(ctx.db, before._id);
    return writeDevice(ctx, args, userId, before, { permission: before?.permission ?? "default", revokedAt: now,
      approvedAt: undefined, subscriptionHash: undefined, secretRef: undefined }, now, revision);
  }),
});

export const history = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    const rows = await ctx.db.query("deliveryAttempts").withIndex("by_workspace_user_created_at", q =>
      q.eq("workspaceId", workspaceId).eq("userId", userId)).order("desc").paginate(boundedPage(paginationOpts));
    const page = await Promise.all(rows.page.map(async row => {
      const { publicId, deviceId, channel, attempt, status, providerStatus, attemptedAt, acceptedAt,
        acknowledgedAt, createdAt, finishedAt } = row;
      const occurrence = await ctx.db.get("reminderOccurrences", row.occurrenceId);
      return { publicId, deviceId, channel, attempt, status, providerStatus, attemptedAt, acceptedAt, acknowledgedAt,
        createdAt, finishedAt, errorCode: row.error?.code,
        occurrencePublicId: occurrence?.workspaceId === workspaceId ? occurrence.publicId : undefined };
    }));
    return { ...rows, page };
  },
});

export const acknowledge = mutation({
  args: { ...device, attemptPublicId: v.string() },
  handler: async (ctx, { workspaceId, deviceId, attemptPublicId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    checkDeviceId(deviceId);
    const row = await ctx.db.query("deliveryAttempts").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", attemptPublicId)).unique();
    if (!row || row.userId !== userId || row.deviceId !== deviceId) calendarError("ATTEMPT_UNAVAILABLE");
    if (row.acknowledgedAt !== undefined) return { acknowledgedAt: row.acknowledgedAt };
    if (row.attemptedAt === undefined || !["attempted", "accepted_by_provider", "uncertain"].includes(row.status)) {
      calendarError("ATTEMPT_UNAVAILABLE");
    }
    const now = Date.now();
    await ctx.db.patch("deliveryAttempts", row._id, { status: "acknowledged", acknowledgedAt: now,
      revision: row.revision + 1, updatedAt: now });
    return { acknowledgedAt: now };
  },
});
