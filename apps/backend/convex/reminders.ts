import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { calendarError, validateInstant, zonedClock } from "./model/calendarTime";
import { requireExpectedRevision, runOperation, type OperationInput } from "./model/operations";
import { recurrenceRule } from "./model/planning";
import { nextReminderDue, normalizeRecurrence } from "./model/reminderRecurrence";
import { claimTarget, closeOccurrence, dueReminders, hasCurrentOccurrence, listReminders, materializeOccurrence,
  occurrenceSnapshot, reminderByPublicId, reminderHistory, reminderTimezone, resolveReminderTask,
  storedOccurrence, triggerAt, visibleReminder } from "./model/reminderStore";
import { checkedTags, checkPublicId, requiredText } from "./model/taskDomain";
import { priority } from "./model/values";

const scope = { workspaceId: v.id("workspaces") };
const identity = { ...scope, publicId: v.string() };
const operation = { operationId: v.string() };
const change = { ...identity, ...operation, expectedRevision: v.number() };
const occurrenceChange = { ...change, occurrencePublicId: v.string() };
const firingTarget = { ...identity, expectedRevision: v.number(), occurrencePublicId: v.string() };
const optionalText = v.optional(v.string());
const reminderInput = v.object({
  title: v.string(), dueAt: v.number(), timezone: optionalText, description: optionalText,
  priority: v.optional(priority), taskPublicId: optionalText, recurrence: v.optional(recurrenceRule),
  tags: v.optional(v.array(v.string())),
});
const reminderPatch = v.object({
  title: optionalText, dueAt: v.optional(v.number()), timezone: optionalText,
  description: v.optional(v.union(v.string(), v.null())), priority: v.optional(priority),
  taskPublicId: v.optional(v.union(v.string(), v.null())), recurrence: v.optional(v.union(recurrenceRule, v.null())),
  tags: v.optional(v.array(v.string())),
});

type Reminder = Doc<"reminders">;
type ChangeArgs = { workspaceId: Id<"workspaces">; publicId: string; operationId: string; expectedRevision: number };
type OccurrenceArgs = ChangeArgs & { occurrencePublicId: string };

function description(value?: string) {
  if (value !== undefined && value.length > 8_000) calendarError("INVALID_ARGUMENT", "Reminder description is too long");
  return value;
}

async function changeReminder(ctx: MutationCtx, args: ChangeArgs, action: string, input: OperationInput,
  apply: (row: Reminder, now: number, revision: number) => Promise<void>) {
  const { workspaceId, publicId, operationId, expectedRevision } = args;
  const userId = requireSessionUser(await getAuthUserId(ctx));
  const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
  return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action,
    operationId, targetPublicId: publicId, expectedRevision, input,
  }, async ({ now }) => {
    const row = await reminderByPublicId(ctx.db, workspaceId, publicId);
    if (!row) calendarError("REMINDER_UNAVAILABLE");
    requireExpectedRevision(expectedRevision, row.revision);
    if (row.revision === Number.MAX_SAFE_INTEGER) calendarError("INVALID_STATE");
    const revision = row.revision + 1;
    await apply(row, now, revision);
    return { target: { kind: "reminder", id: row._id }, targetPublicId: publicId, beforeRevision: row.revision, revision };
  });
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
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    validateInstant(asOf);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) calendarError("INVALID_ARGUMENT", "Request 1–100 due reminders");
    return dueReminders(ctx.db, workspaceId, asOf, limit);
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
  handler: async (ctx, { workspaceId, operationId, reminder }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "reminder.create",
      operationId, input: reminder,
    }, async ({ db, now }) => {
      const { dueAt } = reminder;
      validateInstant(dueAt);
      const title = requiredText(reminder.title, "title", 256);
      const recurrence = reminder.recurrence && normalizeRecurrence(reminder.recurrence);
      const [taskId, timezone] = await Promise.all([
        resolveReminderTask(db, workspaceId, reminder.taskPublicId),
        reminderTimezone(db, workspaceId, workspace.ownerId, reminder.timezone),
      ]);
      const publicId = crypto.randomUUID();
      const revision = 1;
      const fields = { workspaceId, publicId, revision, createdAt: now, updatedAt: now, taskId, title, timezone,
        description: description(reminder.description), priority: reminder.priority ?? "normal" as const,
        dueAt, nextTriggerAt: dueAt, state: "pending" as const, recurrence,
        recurrenceBasis: recurrence ? "local_timezone" as const : undefined,
        recurrenceAnchorAt: recurrence ? dueAt : undefined,
        source: { kind: "manual" as const }, tags: reminder.tags && checkedTags(reminder.tags) };
      const id = await db.insert("reminders", fields);
      const row = await db.get("reminders", id);
      if (!row) throw new Error("Created reminder missing");
      await materializeOccurrence(db, row);
      return { target: { kind: "reminder", id }, targetPublicId: publicId, revision };
    });
  },
});

function sameRule(a: Reminder["recurrence"], b: Reminder["recurrence"]) {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === "weekly" && b?.kind === "weekly") {
    return a.weekdays.length === b.weekdays.length && a.weekdays.every(day => b.weekdays.includes(day));
  }
  if (a?.kind === "interval" && b?.kind === "interval") return a.everySeconds === b.everySeconds;
  if (a?.kind === "monthly" && b?.kind === "monthly") return a.day === b.day;
  return true;
}

export const update = mutation({
  args: { ...change, patch: reminderPatch },
  handler: (ctx, { patch, ...args }) => changeReminder(ctx, args, "reminder.update", patch, async (row, now, revision) => {
    if (Object.keys(patch).length === 0) calendarError("INVALID_ARGUMENT", "Specify a reminder edit");
    const dueAt = patch.dueAt ?? row.dueAt;
    if (patch.dueAt !== undefined) validateInstant(dueAt);
    const timezone = patch.timezone === undefined ? row.timezone : zonedClock(patch.timezone).timezone;
    const recurrence = patch.recurrence === undefined ? row.recurrence
      : patch.recurrence === null ? undefined : normalizeRecurrence(patch.recurrence);
    const recurrenceBasis = recurrence ? row.recurrenceBasis ?? "local_timezone" : undefined;
    const scheduleChanged = dueAt !== row.dueAt || !sameRule(recurrence, row.recurrence) ||
      (timezone !== row.timezone && recurrenceBasis === "local_timezone" && recurrence?.kind !== "interval");
    const state = scheduleChanged && hasCurrentOccurrence(row) ? "pending" : row.state;
    const snoozeUntil = scheduleChanged ? undefined : row.snoozeUntil;
    const current = hasCurrentOccurrence(row) ? await storedOccurrence(ctx.db, row) : null;
    const nextTriggerAt = current && state !== "fired" ? snoozeUntil ?? dueAt
      : scheduleChanged ? undefined : row.nextTriggerAt;
    const edited = { ...row, dueAt, timezone, recurrence, recurrenceBasis, state, snoozeUntil, nextTriggerAt,
      recurrenceAnchorAt: recurrence ? (scheduleChanged ? dueAt : row.recurrenceAnchorAt ?? dueAt) : undefined,
      revision, updatedAt: now,
      title: patch.title === undefined ? row.title : requiredText(patch.title, "title", 256),
      description: patch.description === undefined ? row.description : description(patch.description ?? undefined),
      priority: patch.priority ?? row.priority,
      tags: patch.tags === undefined ? row.tags : checkedTags(patch.tags),
      taskId: patch.taskPublicId === undefined ? row.taskId : await resolveReminderTask(ctx.db, row.workspaceId, patch.taskPublicId),
    };
    const { _id, _creationTime, ...fields } = edited;
    if (current) await closeOccurrence(ctx.db, current, "cancelled", now);
    await ctx.db.patch("reminders", _id, fields);
    if (current) await materializeOccurrence(ctx.db, edited, state === "fired" ? current.firedAt : undefined);
  }),
});

export const remove = mutation({
  args: change,
  handler: (ctx, args) => changeReminder(ctx, args, "reminder.remove", null, async (row, now) => {
    const current = hasCurrentOccurrence(row) ? await storedOccurrence(ctx.db, row) : null;
    if (current) await closeOccurrence(ctx.db, current, "cancelled", now);
    await ctx.db.delete("reminders", row._id);
  }),
});

export const activate = mutation({
  args: change,
  handler: (ctx, args) => changeReminder(ctx, args, "reminder.activate", null, async (row, now, revision) => {
    if ((row.state !== "pending" && row.state !== "snoozed") || await storedOccurrence(ctx.db, row)) {
      calendarError("INVALID_STATE", "Only a dormant pending or snoozed reminder can be activated");
    }
    const fields = { revision, updatedAt: now, nextTriggerAt: row.snoozeUntil ?? row.dueAt };
    await ctx.db.patch("reminders", row._id, fields);
    await materializeOccurrence(ctx.db, { ...row, ...fields });
  }),
});

type Acknowledgment = { kind: "dismiss" } | { kind: "complete" } | { kind: "snooze"; snoozeUntil: number };

function acknowledge(ctx: MutationCtx, args: OccurrenceArgs, action: Acknowledgment) {
  const { occurrencePublicId } = args;
  return changeReminder(ctx, args, `reminder.${action.kind}`, { occurrencePublicId, ...action }, async (row, now, revision) => {
    checkPublicId(occurrencePublicId);
    if (!hasCurrentOccurrence(row)) calendarError("OCCURRENCE_UNAVAILABLE");
    const stored = await storedOccurrence(ctx.db, row);
    const occurrence = stored ?? await occurrenceSnapshot(row);
    if (occurrence.publicId !== occurrencePublicId) calendarError("OCCURRENCE_UNAVAILABLE");

    if (action.kind === "snooze") {
      const { snoozeUntil } = action;
      validateInstant(snoozeUntil);
      if (snoozeUntil <= Math.max(now, row.snoozeUntil ?? row.dueAt)) {
        calendarError("INVALID_ARGUMENT", "Snooze must move the occurrence to a later future time");
      }
      const fields = { revision, updatedAt: now, state: "snoozed" as const, snoozeUntil,
        nextTriggerAt: stored ? snoozeUntil : undefined };
      await closeOccurrence(ctx.db, occurrence, "cancelled", now);
      await ctx.db.patch("reminders", row._id, fields);
      if (stored) await materializeOccurrence(ctx.db, { ...row, ...fields });
      return;
    }

    const nextDueAt = action.kind === "dismiss" ? nextReminderDue(row, now) : undefined;
    const state = nextDueAt !== undefined ? "pending" : action.kind === "dismiss" ? "dismissed" : "completed";
    const fields = { revision, updatedAt: now, state, snoozeUntil: undefined,
      dueAt: nextDueAt ?? row.dueAt, nextTriggerAt: stored ? nextDueAt : undefined,
      recurrenceAnchorAt: row.recurrence ? row.recurrenceAnchorAt ?? row.dueAt : undefined } as const;
    await closeOccurrence(ctx.db, occurrence, action.kind === "dismiss" ? "dismissed" : "completed", now);
    await ctx.db.patch("reminders", row._id, fields);
    if (stored && nextDueAt !== undefined) await materializeOccurrence(ctx.db, { ...row, ...fields });
  });
}

export const snooze = mutation({
  args: { ...occurrenceChange, snoozeUntil: v.number() },
  handler: (ctx, { snoozeUntil, ...args }) => acknowledge(ctx, args, { kind: "snooze", snoozeUntil }),
});

export const dismiss = mutation({
  args: occurrenceChange,
  handler: (ctx, args) => acknowledge(ctx, args, { kind: "dismiss" }),
});

export const complete = mutation({
  args: occurrenceChange,
  handler: (ctx, args) => acknowledge(ctx, args, { kind: "complete" }),
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

    await db.patch("reminderOccurrences", occurrence._id, { state: "fired", firedAt: now,
      revision: occurrence.revision + 1, updatedAt: now });
    await db.patch("reminders", reminder._id, { state: "fired", updatedAt: now, nextTriggerAt: undefined });
    return { status: "fired", firedAt: now } as const;
  },
});

// The caller chooses when the fired occurrence can leave the due list.
// A repeat invocation recognizes the old occurrence's persisted rollover.
export const rollover = internalMutation({
  args: firingTarget,
  handler: async ({ db }, { workspaceId, publicId, expectedRevision, occurrencePublicId }) => {
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

    await db.patch("reminderOccurrences", occurrence._id, { rolledOverAt: now,
      revision: occurrence.revision + 1, updatedAt: now });
    await db.patch("reminders", reminder._id, fields);
    await materializeOccurrence(db, { ...reminder, ...fields });
    return { status: "advanced", revision: fields.revision, dueAt } as const;
  },
});
