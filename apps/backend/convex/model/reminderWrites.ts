import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { calendarError, validateInstant, zonedClock } from "./calendarTime";
import { deliveryConfiguration } from "./deliverySecrets";
import { armDelivery, armRollover } from "./deliveryStore";
import { requireExpectedRevision, runOperation, type OperationInput, type OperationRequest } from "./operations";
import { recurrenceRule } from "./planning";
import { nextReminderDue, normalizeRecurrence } from "./reminderRecurrence";
import { closeOccurrence, hasCurrentOccurrence, materializeOccurrence, occurrenceSnapshot, reminderByPublicId,
  reminderTimezone, resolveReminderTask, storedOccurrence } from "./reminderStore";
import { checkedTags, checkPublicId, requiredText } from "./taskDomain";
import { priority } from "./values";

const optionalText = v.optional(v.string());
export const reminderInput = v.object({
  title: v.string(), dueAt: v.number(), timezone: optionalText, description: optionalText,
  priority: v.optional(priority), taskPublicId: optionalText, recurrence: v.optional(recurrenceRule),
  tags: v.optional(v.array(v.string())),
});
export const reminderPatch = v.object({
  title: optionalText, dueAt: v.optional(v.number()), timezone: optionalText,
  description: v.optional(v.union(v.string(), v.null())), priority: v.optional(priority),
  taskPublicId: v.optional(v.union(v.string(), v.null())), recurrence: v.optional(v.union(recurrenceRule, v.null())),
  tags: v.optional(v.array(v.string())),
});

type Reminder = Doc<"reminders">;
type ChangeArgs = { publicId: string; operationId: string; expectedRevision: number };
type OccurrenceArgs = ChangeArgs & { occurrencePublicId?: string };

function description(value?: string) {
  if (value !== undefined && value.length > 8_000) calendarError("INVALID_ARGUMENT", "Reminder description is too long");
  return value;
}

export async function materializeReminder(ctx: MutationCtx, reminder: Reminder, now: number, firedAt?: number) {
  const id = await materializeOccurrence(ctx.db, reminder, firedAt);
  if (!id || !deliveryConfiguration()) return;
  const occurrence = await ctx.db.get("reminderOccurrences", id);
  if (!occurrence || occurrence.jobId) return;
  if (reminder.state === "fired") await armRollover(ctx, reminder, occurrence, now);
  else await armDelivery(ctx, occurrence, now);
}

export async function closeReminderOccurrence(ctx: MutationCtx, occurrence: Parameters<typeof closeOccurrence>[1],
  state: Parameters<typeof closeOccurrence>[2], now: number) {
  if (occurrence.jobId) await ctx.scheduler.cancel(occurrence.jobId);
  await closeOccurrence(ctx.db, occurrence, state, now);
}

type Principal = Pick<OperationRequest, "workspace" | "actor" | "origin"> & {
  workspace: Pick<Doc<"workspaces">, "_id" | "ownerId" | "publicId">;
  agentReason?: string;
};

function operationInput(input: OperationInput, agentReason?: string): OperationInput {
  return agentReason === undefined ? input : { input, reason: agentReason };
}

export function changeReminder(ctx: MutationCtx, principal: Principal, args: ChangeArgs, action: string, input: OperationInput,
  apply: (row: Reminder, now: number, revision: number) => Promise<void>) {
  const { publicId, operationId, expectedRevision } = args;
  const { workspace, actor, origin, agentReason } = principal;
  return runOperation(ctx.db, { workspace, actor, origin, action,
    operationId, targetPublicId: publicId, expectedRevision, input: operationInput(input, agentReason),
  }, async ({ now }) => {
    const row = await reminderByPublicId(ctx.db, workspace._id, publicId);
    if (!row) calendarError("REMINDER_UNAVAILABLE");
    requireExpectedRevision(expectedRevision, row.revision);
    if (row.revision === Number.MAX_SAFE_INTEGER) calendarError("INVALID_STATE");
    const revision = row.revision + 1;
    await apply(row, now, revision);
    return { target: { kind: "reminder", id: row._id }, targetPublicId: publicId, beforeRevision: row.revision, revision, agentReason,
      ...(actor.kind === "agent" ? { reminderSnapshot: await snapshot(ctx, row._id) } : {}) };
  });
}

async function snapshot(ctx: MutationCtx, id: Id<"reminders">): Promise<NonNullable<Doc<"operationReceipts">["result"]["reminderSnapshot"]>> {
  const row = await ctx.db.get("reminders", id);
  if (!row) throw new Error("Applied reminder missing");
  const { publicId, revision, title, description, priority, dueAt, timezone, recurrence, state, tags, nextTriggerAt, snoozeUntil } = row;
  const task = row.taskId && await ctx.db.get("tasks", row.taskId);
  const occurrence = hasCurrentOccurrence(row)
    ? await storedOccurrence(ctx.db, row) ?? await occurrenceSnapshot(row)
    : undefined;
  return { publicId, revision, title, description, priority, dueAt, timezone, recurrence, state, tags, nextTriggerAt, snoozeUntil,
    occurrencePublicId: occurrence?.publicId, taskPublicId: task && task.workspaceId === row.workspaceId ? task.publicId : undefined };
}

export function createReminder(ctx: MutationCtx, principal: Principal, operationId: string,
  reminder: Infer<typeof reminderInput>, requestedPublicId?: string) {
  const { workspace, actor, origin, agentReason } = principal;
  const workspaceId = workspace._id;
  return runOperation(ctx.db, { workspace, actor, origin, action: "reminder.create",
    operationId, targetPublicId: requestedPublicId, input: operationInput(reminder, agentReason),
  }, async ({ db, now }) => {
    const { dueAt } = reminder;
    validateInstant(dueAt);
    const title = requiredText(reminder.title, "title", 256);
    const recurrence = reminder.recurrence && normalizeRecurrence(reminder.recurrence);
    const [taskId, timezone] = await Promise.all([
      resolveReminderTask(db, workspaceId, reminder.taskPublicId),
      reminderTimezone(db, workspaceId, workspace.ownerId, reminder.timezone),
    ]);
    const publicId = requestedPublicId ?? crypto.randomUUID();
    if (requestedPublicId !== undefined) {
      if (await reminderByPublicId(db, workspaceId, publicId)) calendarError("ALREADY_EXISTS");
      const used = await db.query("activityEvents").withIndex("by_workspace_target", q =>
        q.eq("workspaceId", workspaceId).eq("target.kind", "reminder").eq("targetPublicId", publicId)).first();
      if (used) calendarError("ALREADY_EXISTS");
    }
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
    await materializeReminder(ctx, row, now);
    return { target: { kind: "reminder", id }, targetPublicId: publicId, revision, agentReason,
      ...(actor.kind === "agent" ? { reminderSnapshot: await snapshot(ctx, id) } : {}) };
  });
}

function sameRule(a: Reminder["recurrence"], b: Reminder["recurrence"]) {
  if (a?.kind !== b?.kind) return false;
  if (a?.kind === "weekly" && b?.kind === "weekly") {
    return a.weekdays.length === b.weekdays.length && a.weekdays.every(day => b.weekdays.includes(day));
  }
  if (a?.kind === "interval" && b?.kind === "interval") return a.everySeconds === b.everySeconds;
  if (a?.kind === "monthly" && b?.kind === "monthly") return a.day === b.day;
  return true;
}

export function updateReminder(ctx: MutationCtx, principal: Principal, args: ChangeArgs, patch: Infer<typeof reminderPatch>) {
  return changeReminder(ctx, principal, args, "reminder.update", patch, async (row, now, revision) => {
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
    if (current) await closeReminderOccurrence(ctx, current, "cancelled", now);
    await ctx.db.patch("reminders", _id, fields);
    if (current) await materializeReminder(ctx, edited, now, state === "fired" ? current.firedAt : undefined);
  });
}

type Acknowledgment = { kind: "dismiss" } | { kind: "complete" } | { kind: "snooze"; snoozeUntil: number };

export function acknowledgeReminder(ctx: MutationCtx, principal: Principal, args: OccurrenceArgs, action: Acknowledgment) {
  const { occurrencePublicId } = args;
  return changeReminder(ctx, principal, args, `reminder.${action.kind}`, { occurrencePublicId, ...action }, async (row, now, revision) => {
    if (occurrencePublicId !== undefined) checkPublicId(occurrencePublicId);
    if (!hasCurrentOccurrence(row)) calendarError("OCCURRENCE_UNAVAILABLE");
    const stored = await storedOccurrence(ctx.db, row);
    const occurrence = stored ?? await occurrenceSnapshot(row);
    if (occurrencePublicId !== undefined && occurrence.publicId !== occurrencePublicId) calendarError("OCCURRENCE_UNAVAILABLE");

    if (action.kind === "snooze") {
      const { snoozeUntil } = action;
      validateInstant(snoozeUntil);
      if (snoozeUntil <= Math.max(now, row.snoozeUntil ?? row.dueAt)) {
        calendarError("INVALID_ARGUMENT", "Snooze must move the occurrence to a later future time");
      }
      const fields = { revision, updatedAt: now, state: "snoozed" as const, snoozeUntil,
        nextTriggerAt: stored ? snoozeUntil : undefined };
      await closeReminderOccurrence(ctx, occurrence, "cancelled", now);
      await ctx.db.patch("reminders", row._id, fields);
      if (stored) await materializeReminder(ctx, { ...row, ...fields }, now);
      return;
    }

    const nextDueAt = action.kind === "dismiss" ? nextReminderDue(row, now) : undefined;
    const state = nextDueAt !== undefined ? "pending" : action.kind === "dismiss" ? "dismissed" : "completed";
    const fields = { revision, updatedAt: now, state, snoozeUntil: undefined,
      dueAt: nextDueAt ?? row.dueAt, nextTriggerAt: stored ? nextDueAt : undefined,
      recurrenceAnchorAt: row.recurrence ? row.recurrenceAnchorAt ?? row.dueAt : undefined } as const;
    await closeReminderOccurrence(ctx, occurrence, action.kind === "dismiss" ? "dismissed" : "completed", now);
    await ctx.db.patch("reminders", row._id, fields);
    if (stored && nextDueAt !== undefined) await materializeReminder(ctx, { ...row, ...fields }, now);
  });
}
