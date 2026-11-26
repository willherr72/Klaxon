import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { compareIds, preferenceRow } from "./calendarStore";
import { calendarError, zonedClock } from "./calendarTime";
import { boundedPage, type Page } from "./pagination";
import { taskByPublicId } from "./reads";
import { checkPublicId } from "./taskDomain";

type Reminder = Doc<"reminders">;
type CurrentReminder = Reminder & { state: "pending" | "snoozed" | "fired" };
type Occurrence = Doc<"reminderOccurrences">;
type WorkspaceId = Id<"workspaces">;
type VirtualOccurrence = Omit<Occurrence, "_id" | "_creationTime">;

const activeStates = ["pending", "snoozed", "fired"] as const;
const dormantScanLimit = 100;

export function reminderByPublicId(db: DatabaseReader, workspaceId: WorkspaceId, publicId: string) {
  checkPublicId(publicId);
  return db.query("reminders").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
}

export async function resolveReminderTask(db: DatabaseReader, workspaceId: WorkspaceId, taskPublicId?: string | null) {
  if (taskPublicId == null) return undefined;
  checkPublicId(taskPublicId);
  const task = await taskByPublicId(db, workspaceId, taskPublicId);
  if (!task || task.status === "archived") calendarError("TASK_UNAVAILABLE");
  return task._id;
}

export async function reminderTimezone(db: DatabaseReader, workspaceId: WorkspaceId, ownerId: Id<"users">, timezone?: string) {
  const zone = timezone ?? (await preferenceRow(db, workspaceId, ownerId))?.timezone ?? "UTC";
  return zonedClock(zone).timezone;
}

export function hasCurrentOccurrence(reminder: Reminder): reminder is CurrentReminder {
  return reminder.state === "pending" || reminder.state === "snoozed" || reminder.state === "fired";
}

function occurrenceKey(reminder: Reminder) {
  return JSON.stringify([reminder.publicId, reminder.revision, reminder.dueAt]);
}

export function storedOccurrence(db: DatabaseReader, reminder: Reminder) {
  return db.query("reminderOccurrences").withIndex("by_workspace_occurrence_key", q =>
    q.eq("workspaceId", reminder.workspaceId).eq("occurrenceKey", occurrenceKey(reminder))).unique();
}

export async function claimTarget(db: DatabaseReader, workspaceId: WorkspaceId, reminderPublicId: string,
  expectedRevision: number, occurrencePublicId: string) {
  const reminder = await reminderByPublicId(db, workspaceId, reminderPublicId);
  if (!reminder) return { status: "stale" } as const;
  if (reminder.revision !== expectedRevision) {
    const previous = await db.query("reminderOccurrences").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", occurrencePublicId)).unique();
    if (previous?.reminderId === reminder._id && previous.reminderRevision === expectedRevision &&
        previous.rolledOverAt !== undefined && previous.firedAt !== undefined) {
      return { status: "rolled_over", firedAt: previous.firedAt, rolledOverAt: previous.rolledOverAt } as const;
    }
    return { status: "stale" } as const;
  }
  if (!hasCurrentOccurrence(reminder)) return { status: "stale" } as const;
  const occurrence = await storedOccurrence(db, reminder);
  if (!occurrence) return { status: "dormant" } as const;
  if (occurrence.publicId !== occurrencePublicId || occurrence.reminderId !== reminder._id ||
      occurrence.reminderRevision !== expectedRevision || occurrence.state !== reminder.state ||
      occurrence.dueAt !== reminder.dueAt || occurrence.snoozeUntil !== reminder.snoozeUntil ||
      (reminder.state !== "fired" && reminder.nextTriggerAt !== triggerAt(occurrence))) {
    return { status: "stale" } as const;
  }
  return { status: "current", reminder, occurrence } as const;
}

export async function occurrenceSnapshot(reminder: CurrentReminder): Promise<VirtualOccurrence> {
  const { workspaceId, publicId: reminderPublicId, title: reminderTitle, revision: reminderRevision,
    dueAt, timezone, snoozeUntil, state, updatedAt } = reminder;
  const key = occurrenceKey(reminder);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const publicId = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  return { workspaceId, reminderId: reminder._id, reminderPublicId, reminderTitle, reminderRevision,
    dueAt, timezone, snoozeUntil, state, publicId, occurrenceKey: key, deliveryState: "disabled",
    createdAt: updatedAt, updatedAt, revision: 1 };
}

export async function materializeOccurrence(db: DatabaseWriter, reminder: Reminder, firedAt?: number) {
  if (hasCurrentOccurrence(reminder) && !await storedOccurrence(db, reminder)) {
    await db.insert("reminderOccurrences", { ...await occurrenceSnapshot(reminder), firedAt });
  }
}

export async function closeOccurrence(db: DatabaseWriter, occurrence: Occurrence | VirtualOccurrence,
  state: "cancelled" | "dismissed" | "completed", now: number) {
  const changes = {
    state, updatedAt: now,
    // Preserve provider history after acknowledgment. Invalidation is visible
    // on the occurrence and supersedes any delivery that could still be queued.
    deliveryState: state === "cancelled" && occurrence.deliveryState === "scheduled"
      ? "cancelled" as const : occurrence.deliveryState,
    acknowledgedAt: state === "cancelled" ? occurrence.acknowledgedAt : now,
  };
  if ("_id" in occurrence) {
    await db.patch("reminderOccurrences", occurrence._id, { ...changes, revision: occurrence.revision + 1 });
  } else {
    await db.insert("reminderOccurrences", { ...occurrence, ...changes });
  }
}

export function triggerAt(row: { snoozeUntil?: number; dueAt: number }) {
  return row.snoozeUntil ?? row.dueAt;
}

async function visibleOccurrence(db: DatabaseReader, row: VirtualOccurrence) {
  const { publicId, reminderRevision, dueAt, timezone, state, deliveryState, acknowledgedAt,
    firedAt, rolledOverAt, snoozeUntil, createdAt, updatedAt, revision } = row;
  const parent = row.reminderPublicId === undefined || row.reminderTitle === undefined
    ? await db.get("reminders", row.reminderId) : null;
  const fallback = parent?.workspaceId === row.workspaceId ? parent : null;
  return { publicId, reminderPublicId: row.reminderPublicId ?? fallback?.publicId,
    reminderTitle: row.reminderTitle ?? fallback?.title, reminderRevision, dueAt, triggerAt: triggerAt(row),
    timezone, state, deliveryState, acknowledgedAt, firedAt, rolledOverAt, snoozeUntil, createdAt, updatedAt, revision };
}

export async function visibleReminder(db: DatabaseReader, row: Reminder) {
  const { publicId, title, description, priority, dueAt, timezone, recurrence, recurrenceBasis, recurrenceAnchorAt,
    state, snoozeUntil, nextTriggerAt, revision, createdAt, updatedAt, tags } = row;
  const current = hasCurrentOccurrence(row);
  const [stored, task] = await Promise.all([
    current ? storedOccurrence(db, row) : null,
    row.taskId ? db.get("tasks", row.taskId) : null,
  ]);
  const occurrence = current ? await visibleOccurrence(db, stored ?? await occurrenceSnapshot(row)) : null;
  const source = row.source?.kind === "legacy" ? row.source : row.source && { kind: row.source.kind };
  return { publicId, title, description, priority, dueAt, timezone, recurrence, recurrenceBasis, recurrenceAnchorAt,
    state, snoozeUntil, nextTriggerAt, revision, createdAt, updatedAt, tags, source, dormant: current && stored === null,
    taskPublicId: task?.workspaceId === row.workspaceId ? task.publicId : undefined, occurrence };
}

export async function listReminders(db: DatabaseReader, workspaceId: WorkspaceId, taskPublicId: string | undefined, page: Page) {
  const options = boundedPage(page);
  let rows;
  if (taskPublicId === undefined) {
    rows = await db.query("reminders").withIndex("by_workspace_due_at", q =>
      q.eq("workspaceId", workspaceId)).paginate(options);
  } else {
    checkPublicId(taskPublicId);
    const task = await taskByPublicId(db, workspaceId, taskPublicId);
    if (!task) return { page: [], isDone: true, continueCursor: "" };
    rows = await db.query("reminders").withIndex("by_workspace_task", q =>
      q.eq("workspaceId", workspaceId).eq("taskId", task._id)).paginate(options);
  }
  return { ...rows, page: await Promise.all(rows.page.map(row => visibleReminder(db, row))) };
}

export async function dueReminders(db: DatabaseReader, workspaceId: WorkspaceId, asOf: number, limit: number) {
  const buckets = await Promise.all(activeStates.map(async state => {
    const [indexed, missingTrigger] = await Promise.all([
      db.query("reminders").withIndex("by_workspace_state_trigger", q =>
        q.eq("workspaceId", workspaceId).eq("state", state).gt("nextTriggerAt", undefined)
          .lte("nextTriggerAt", asOf)).take(limit + 1),
      // Legacy import deliberately leaves nextTriggerAt unset. Read a bounded
      // prefix so dormant reminders remain visible without activating them.
      db.query("reminders").withIndex("by_workspace_state_trigger", q =>
        q.eq("workspaceId", workspaceId).eq("state", state).eq("nextTriggerAt", undefined)).take(dormantScanLimit + 1),
    ]);
    return { rows: [...indexed, ...missingTrigger.slice(0, dormantScanLimit)],
      partial: indexed.length > limit || missingTrigger.length > dormantScanLimit };
  }));
  const due = buckets.flatMap(bucket => bucket.rows).filter(row => triggerAt(row) <= asOf)
    .sort((a, b) => triggerAt(a) - triggerAt(b) || compareIds(a.publicId, b.publicId));
  const items = await Promise.all(due.slice(0, limit).map(async row => ({
    ...await visibleReminder(db, row), overdue: triggerAt(row) < asOf,
  })));
  return { asOf, items, partial: due.length > limit || buckets.some(bucket => bucket.partial), deliveryEnabled: false };
}

export async function reminderHistory(db: DatabaseReader, workspaceId: WorkspaceId, page: Page) {
  const rows = await db.query("reminderOccurrences").withIndex("by_workspace_due_at", q =>
    q.eq("workspaceId", workspaceId)).order("desc").paginate(boundedPage(page));
  return { ...rows, page: await Promise.all(rows.page.map(row => visibleOccurrence(db, row))) };
}
