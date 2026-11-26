import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { calendarError, validateInstant } from "./model/calendarTime";
import { deliveryConfiguration } from "./model/deliverySecrets";
import { grantRow } from "./model/deliveryStore";
import { nextReminderDue } from "./model/reminderRecurrence";
import { claimTarget, dueReminders, hasCurrentOccurrence, listReminders, markOccurrenceFired, reminderByPublicId,
  reminderHistory, storedOccurrence, triggerAt, visibleReminder } from "./model/reminderStore";
import { acknowledgeReminder, changeReminder, closeReminderOccurrence, createReminder, materializeReminder,
  reminderInput, reminderPatch, updateReminder } from "./model/reminderWrites";

const scope = { workspaceId: v.id("workspaces") };
const identity = { ...scope, publicId: v.string() };
const operation = { operationId: v.string() };
const change = { ...identity, ...operation, expectedRevision: v.number() };
const occurrenceChange = { ...change, occurrencePublicId: v.string() };
const firingTarget = { ...identity, expectedRevision: v.number(), occurrencePublicId: v.string() };
const optionalText = v.optional(v.string());

async function reminderPrincipal(ctx: MutationCtx, workspaceId: Id<"workspaces">) {
  const userId = requireSessionUser(await getAuthUserId(ctx));
  const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
  return { workspace, actor: { kind: "user" as const, userId }, origin: "app" as const };
}

export const get = query({
  args: identity,
  handler: async (ctx, { workspaceId, publicId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    const row = await reminderByPublicId(ctx.db, workspaceId, publicId);
    return row ? visibleReminder(ctx.db, row) : null;
  },
});

export const list = query({
  args: { ...scope, taskPublicId: optionalText, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, taskPublicId, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return listReminders(ctx.db, workspaceId, taskPublicId, paginationOpts);
  },
});

export const due = query({
  args: { ...scope, asOf: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, { workspaceId, asOf = Date.now(), limit = 50 }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    validateInstant(asOf);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) calendarError("INVALID_ARGUMENT", "Request 1–100 due reminders");
    const deliveryEnabled = !!deliveryConfiguration() && (await grantRow(ctx.db, workspaceId, userId))?.enabled === true;
    return { ...await dueReminders(ctx.db, workspaceId, asOf, limit), deliveryEnabled };
  },
});

export const history = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return reminderHistory(ctx.db, workspaceId, paginationOpts);
  },
});

export const create = mutation({
  args: { ...scope, ...operation, reminder: reminderInput },
  handler: async (ctx, { workspaceId, operationId, reminder }) =>
    createReminder(ctx, await reminderPrincipal(ctx, workspaceId), operationId, reminder),
});

export const update = mutation({
  args: { ...change, patch: reminderPatch },
  handler: async (ctx, { workspaceId, patch, ...args }) =>
    updateReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, patch),
});

export const remove = mutation({
  args: change,
  handler: async (ctx, { workspaceId, ...args }) => changeReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, "reminder.remove", null, async (row, now) => {
    const current = hasCurrentOccurrence(row) ? await storedOccurrence(ctx.db, row) : null;
    if (current) await closeReminderOccurrence(ctx, current, "cancelled", now);
    await ctx.db.delete("reminders", row._id);
  }),
});

export const activate = mutation({
  args: change,
  handler: async (ctx, { workspaceId, ...args }) => changeReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, "reminder.activate", null, async (row, now, revision) => {
    if ((row.state !== "pending" && row.state !== "snoozed") || await storedOccurrence(ctx.db, row)) {
      calendarError("INVALID_STATE", "Only a dormant pending or snoozed reminder can be activated");
    }
    const fields = { revision, updatedAt: now, nextTriggerAt: row.snoozeUntil ?? row.dueAt };
    await ctx.db.patch("reminders", row._id, fields);
    await materializeReminder(ctx, { ...row, ...fields }, now);
  }),
});

export const snooze = mutation({
  args: { ...occurrenceChange, snoozeUntil: v.number() },
  handler: async (ctx, { workspaceId, snoozeUntil, ...args }) =>
    acknowledgeReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, { kind: "snooze", snoozeUntil }),
});

export const dismiss = mutation({
  args: occurrenceChange,
  handler: async (ctx, { workspaceId, ...args }) =>
    acknowledgeReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, { kind: "dismiss" }),
});

export const complete = mutation({
  args: occurrenceChange,
  handler: async (ctx, { workspaceId, ...args }) =>
    acknowledgeReminder(ctx, await reminderPrincipal(ctx, workspaceId), args, { kind: "complete" }),
});

// Firing records that the server considers the current occurrence due. Keeping
// its schedule revision lets the user or a later delivery step address it.
export const fireDue = internalMutation({
  args: firingTarget,
  handler: async ({ db }, { workspaceId, publicId, expectedRevision, occurrencePublicId }) => {
    const target = await claimTarget(db, workspaceId, publicId, expectedRevision, occurrencePublicId);
    if (target.status === "rolled_over") {
      return { status: "already_fired", firedAt: target.firedAt } as const;
    }
    if (target.status !== "current") return { status: target.status };
    const { reminder, occurrence } = target;
    if (occurrence.firedAt !== undefined) return { status: "already_fired", firedAt: occurrence.firedAt } as const;
    if (reminder.state === "fired") return { status: "stale" } as const;
    const now = Date.now();
    const trigger = triggerAt(occurrence);
    if (trigger > now) return { status: "not_due", triggerAt: trigger } as const;

    await markOccurrenceFired(db, reminder, occurrence, now);
    return { status: "fired", firedAt: now } as const;
  },
});

// The caller chooses when the fired occurrence can leave the due list.
// A repeat invocation recognizes the old occurrence's persisted rollover.
export const rollover = internalMutation({
  args: firingTarget,
  handler: async (ctx, { workspaceId, publicId, expectedRevision, occurrencePublicId }) => {
    const { db } = ctx;
    const target = await claimTarget(db, workspaceId, publicId, expectedRevision, occurrencePublicId);
    if (target.status === "rolled_over") {
      return { status: "already_advanced", rolledOverAt: target.rolledOverAt } as const;
    }
    if (target.status !== "current") return { status: target.status };
    const { reminder, occurrence } = target;
    if (occurrence.firedAt === undefined) return { status: "not_fired" } as const;
    if (reminder.revision === Number.MAX_SAFE_INTEGER) calendarError("INVALID_STATE");
    const now = Date.now();
    const dueAt = nextReminderDue(reminder, Math.max(now, occurrence.firedAt));
    if (dueAt === undefined) return { status: "finished" } as const;
    const fields = { revision: reminder.revision + 1, updatedAt: now, state: "pending" as const, dueAt,
      snoozeUntil: undefined, nextTriggerAt: dueAt, recurrenceAnchorAt: reminder.recurrenceAnchorAt ?? reminder.dueAt };

    await db.patch("reminderOccurrences", occurrence._id, { rolledOverAt: now, jobId: undefined,
      revision: occurrence.revision + 1, updatedAt: now });
    await db.patch("reminders", reminder._id, fields);
    await materializeReminder(ctx, { ...reminder, ...fields }, now);
    return { status: "advanced", revision: fields.revision, dueAt } as const;
  },
});
