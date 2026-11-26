import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { calendarError, overlaps, zonedClock, type Interval } from "./calendarTime";
import { exteriorPivots, pivotKey } from "./calendarOverlap";
import { weekday } from "./values";

const scanLimit = 1024;

export function compareIds(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function overlapRows<Row extends Interval & { publicId: string }>(range: Interval,
  interior: (left: string, right: string, limit: number) => Promise<Row[]>,
  byEnd: (pivot: string | undefined, limit: number) => Promise<Row[]>,
  byStart: (pivot: string | undefined, limit: number) => Promise<Row[]>) {
  if (!(range.startAt < range.endAt)) return [];

  // Interior pivots guarantee overlap. An interval whose pivot is outside the
  // window can only cross its nearest boundary at an ancestor split of that
  // boundary. The endpoint index at each such split yields only overlaps.
  const rows = await interior(pivotKey(range.startAt), pivotKey(range.endAt), scanLimit + 1);
  const limit = () => {
    if (rows.length > scanLimit) calendarError("CALENDAR_RANGE_LIMIT", "Too many records to confirm availability for this window");
    return scanLimit + 1 - rows.length;
  };
  for (const pivot of exteriorPivots(range.startAt, "left")) {
    rows.push(...await byEnd(pivot, limit()));
  }
  for (const pivot of exteriorPivots(range.endAt, "right")) {
    rows.push(...await byStart(pivot, limit()));
  }

  // Retain correct reads during the backfill. These scans only see unmigrated
  // rows and disappear once the backfill has drained them.
  let legacy = await byEnd(undefined, scanLimit + 1);
  if (legacy.length > scanLimit) legacy = await byStart(undefined, scanLimit + 1);
  if (legacy.length > scanLimit) {
    calendarError("CALENDAR_RANGE_LIMIT", "Calendar overlap index backfill is required for this window");
  }
  rows.push(...legacy.filter(row => row.startAt < row.endAt && overlaps(row, range)));
  limit();
  return rows.sort((a, b) => a.startAt - b.startAt || compareIds(a.publicId, b.publicId));
}

export function blocksInRange(db: DatabaseReader, workspaceId: Id<"workspaces">, range: Interval) {
  return overlapRows(range,
    (left, right, limit) => db.query("timeBlocks").withIndex("by_workspace_pivot_start", q =>
      q.eq("workspaceId", workspaceId).gt("overlapPivot", left).lte("overlapPivot", right)).take(limit),
    (pivot, limit) => db.query("timeBlocks").withIndex("by_workspace_pivot_end", q =>
      q.eq("workspaceId", workspaceId).eq("overlapPivot", pivot).gt("endAt", range.startAt)).take(limit),
    (pivot, limit) => db.query("timeBlocks").withIndex("by_workspace_pivot_start", q =>
      q.eq("workspaceId", workspaceId).eq("overlapPivot", pivot).lt("startAt", range.endAt)).take(limit),
  );
}

export async function eventsInRange(db: DatabaseReader, workspaceId: Id<"workspaces">,
  userId: Id<"users">, range: Interval) {
  const events = await overlapRows(range,
    (left, right, limit) => db.query("calendarEvents").withIndex("by_workspace_pivot_start", q =>
      q.eq("workspaceId", workspaceId).gt("overlapPivot", left).lte("overlapPivot", right)).take(limit),
    (pivot, limit) => db.query("calendarEvents").withIndex("by_workspace_pivot_end", q =>
      q.eq("workspaceId", workspaceId).eq("overlapPivot", pivot).gt("endAt", range.startAt)).take(limit),
    (pivot, limit) => db.query("calendarEvents").withIndex("by_workspace_pivot_start", q =>
      q.eq("workspaceId", workspaceId).eq("overlapPivot", pivot).lt("startAt", range.endAt)).take(limit),
  );
  const connectionIds = [...new Set(events.filter(event => event.deletedAt === undefined).map(event => event.connectionId))];
  const connections = new Map((await Promise.all(connectionIds.map(id => db.get("integrationConnections", id))))
    .flatMap(connection => connection && connection.workspaceId === workspaceId && connection.userId === userId &&
      connection.state !== "disconnected" ? [[connection._id, connection] as const] : []));
  return events.flatMap(event => {
    const connection = connections.get(event.connectionId);
    if (event.deletedAt !== undefined || connection?.provider !== event.provider) return [];
    return [{ event, connection }];
  });
}

export function visibleEvent({ event, connection }: Awaited<ReturnType<typeof eventsInRange>>[number]) {
  const { publicId, revision, startAt, endAt, localDate, endLocalDate, timezone, provider, allDay, availability, lastSeenAt } = event;
  return { publicId, revision, startAt, endAt, localDate, endLocalDate, timezone, provider, allDay, availability, lastSeenAt,
    connectionState: connection.state, title: connection.metadataPolicy === "busy_only" ? undefined : event.title };
}

export function isBusy(event: Doc<"calendarEvents">) {
  return event.availability !== "free" && event.availability !== "working_elsewhere";
}

export function blockTask(block: Doc<"timeBlocks">) {
  return "taskId" in block ? block.taskId : undefined;
}

export const preferenceValues = v.object({
  timezone: v.string(),
  workHours: v.array(v.object({ weekday, startMinute: v.number(), endMinute: v.number() })),
  breaks: v.array(v.object({ weekday, startMinute: v.number(), endMinute: v.number() })),
  bufferMinutes: v.number(),
  discretionaryMinutes: v.number(),
  lockManuallyMovedBlocks: v.boolean(),
});

export type PreferenceValues = Infer<typeof preferenceValues>;
type WorkWindow = PreferenceValues["workHours"][number];

export function normalizedWindows(windows: WorkWindow[]) {
  if (windows.length > 56) calendarError("INVALID_ARGUMENT", "At most 56 weekly windows are supported per list");
  const ordered = [...windows].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
  for (const [index, window] of ordered.entries()) {
    const { weekday, startMinute, endMinute } = window;
    if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 ||
        startMinute >= endMinute || endMinute > 1440) {
      calendarError("INVALID_ARGUMENT", "Weekly windows require increasing same-day minutes between 0 and 1440");
    }
    const prior = ordered[index - 1];
    if (prior?.weekday === weekday && prior.endMinute > startMinute) {
      calendarError("INVALID_ARGUMENT", "Weekly windows in the same list cannot overlap");
    }
  }
  return ordered;
}

export function normalizePreferences(values: PreferenceValues) {
  const { bufferMinutes, discretionaryMinutes } = values;
  if (!Number.isInteger(bufferMinutes) || bufferMinutes < 0 || bufferMinutes > 1440 ||
      !Number.isInteger(discretionaryMinutes) || discretionaryMinutes < 0 || discretionaryMinutes > 1440) {
    calendarError("INVALID_ARGUMENT", "Buffer and discretionary capacity must be whole minutes between 0 and 1440");
  }
  return { ...values, timezone: zonedClock(values.timezone).timezone,
    workHours: normalizedWindows(values.workHours), breaks: normalizedWindows(values.breaks) };
}

export function preferenceRow(db: DatabaseReader, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  return db.query("preferences").withIndex("by_workspace_user", q =>
    q.eq("workspaceId", workspaceId).eq("userId", userId)).unique();
}

const weekdays = [0, 1, 2, 3, 4] as const;
const defaults: PreferenceValues = {
  timezone: "UTC", workHours: weekdays.map(weekday => ({ weekday, startMinute: 540, endMinute: 1020 })),
  breaks: [], bufferMinutes: 10, discretionaryMinutes: 60, lockManuallyMovedBlocks: true,
};

export function visiblePreferences(row: Doc<"preferences"> | null) {
  return { publicId: row?.publicId ?? null, revision: row?.revision ?? 0,
    timezone: row?.timezone ?? defaults.timezone, workHours: row?.workHours ?? defaults.workHours,
    breaks: row?.breaks ?? defaults.breaks, bufferMinutes: row?.bufferMinutes ?? defaults.bufferMinutes,
    discretionaryMinutes: row?.autonomyPolicy.discretionaryMinutes ?? defaults.discretionaryMinutes,
    lockManuallyMovedBlocks: row?.autonomyPolicy.lockManuallyMovedBlocks ?? defaults.lockManuallyMovedBlocks };
}
