import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { blocksInRange, blockTask, compareIds, eventsInRange, isBusy, preferenceRow, visiblePreferences } from "./calendarStore";
import { addLocalDays, calendarRange, localWeekday, minuteMs, overlaps, zonedClock, type Interval } from "./calendarTime";

type DayPlan = Doc<"dayPlans">;
type PlanRevision = Doc<"planRevisions">;
type Summary = NonNullable<PlanRevision["previewSummary"]>;
type Task = Doc<"tasks">;
type Block = Doc<"timeBlocks">;

export function dayPlanRow(db: DatabaseReader, workspaceId: Id<"workspaces">, localDate: string) {
  return db.query("dayPlans").withIndex("by_workspace_local_date", q =>
    q.eq("workspaceId", workspaceId).eq("localDate", localDate)).unique();
}

export function hasMeetingConflict(blocks: Block[], events: Awaited<ReturnType<typeof eventsInRange>>, day: Interval) {
  const busy = events.filter(({ event }) => isBusy(event) && overlaps(event, day));
  return blocks.some(block => busy.some(({ event }) => overlaps(block, event) &&
    Math.max(block.startAt, event.startAt) < day.endAt && Math.min(block.endAt, event.endAt) > day.startAt));
}

export async function planningContext(db: DatabaseReader, workspaceId: Id<"workspaces">,
  userId: Id<"users">, localDate: string, tasks: Task[], plan: DayPlan | null) {
  const row = await preferenceRow(db, workspaceId, userId);
  const settings = visiblePreferences(row);
  const clock = zonedClock(settings.timezone);
  const day = calendarRange(localDate, 1, clock);
  const buffer = settings.bufferMinutes * minuteMs;
  const search = { startAt: day.startAt - buffer, endAt: day.endAt + buffer };
  const [blocks, events] = await Promise.all([
    blocksInRange(db, workspaceId, search), eventsInRange(db, workspaceId, userId, search),
  ]);
  const dependencies: PlanRevision["dependencies"] = [];
  if (row) dependencies.push({ target: { kind: "preferences", id: row._id }, revision: row.revision });
  if (plan) dependencies.push({ target: { kind: "day_plan", id: plan._id }, revision: plan.revision });
  for (const { _id, revision } of tasks) dependencies.push({ target: { kind: "task", id: _id }, revision });
  for (const { _id, revision } of blocks) dependencies.push({ target: { kind: "time_block", id: _id }, revision });
  const connections = new Set<Id<"integrationConnections">>();
  for (const { event, connection } of events) {
    dependencies.push({ target: { kind: "calendar_event", id: event._id }, revision: event.revision });
    if (!connections.has(connection._id)) {
      dependencies.push({ target: { kind: "connection", id: connection._id }, revision: connection.revision });
      connections.add(connection._id);
    }
  }
  dependencies.sort((a, b) => compareIds(a.target.kind, b.target.kind) || compareIds(a.target.id, b.target.id));
  const bytes = new TextEncoder().encode(JSON.stringify(["day-planner-v1", userId, localDate, day, settings,
    dependencies.map(({ target, revision }) => [target.kind, target.id, revision]),
  ]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const contextFingerprint = Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
  return { day, clock, localDate, tasks, blocks, events, plan, settings, buffer, dependencies, contextFingerprint };
}

function merged(intervals: Interval[]) {
  const result: Interval[] = [];
  for (const { startAt, endAt } of [...intervals].sort((a, b) => a.startAt - b.startAt)) {
    if (startAt >= endAt) continue;
    const last = result.at(-1);
    if (last && last.endAt >= startAt) last.endAt = Math.max(last.endAt, endAt);
    else result.push({ startAt, endAt });
  }
  return result;
}

function subtract(windows: Interval[], occupied: Interval[]) {
  const blocked = merged(occupied);
  const slots: Interval[] = [];
  for (const window of windows) {
    let startAt = window.startAt;
    for (const interval of blocked) {
      if (interval.endAt <= startAt) continue;
      if (interval.startAt >= window.endAt) break;
      if (interval.startAt > startAt) slots.push({ startAt, endAt: interval.startAt });
      startAt = Math.max(startAt, interval.endAt);
    }
    if (startAt < window.endAt) slots.push({ startAt, endAt: window.endAt });
  }
  return slots;
}

const duration = (intervals: Interval[]) => intervals.reduce((total, interval) => total + interval.endAt - interval.startAt, 0);
const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };

export function buildSchedule(context: Awaited<ReturnType<typeof planningContext>>, now: number) {
  const { day, clock, localDate, tasks, blocks, events, plan, settings, buffer } = context;
  const changes: PlanRevision["changes"] = [];
  const placements: Summary["placements"] = [];
  const unscheduled: Summary["unscheduled"] = [];
  const firstStart = (Math.floor(now / minuteMs) + 1) * minuteMs;
  const weekday = localWeekday(localDate);
  const toIntervals = (rules: typeof settings.workHours) => rules.filter(rule => rule.weekday === weekday)
    .map(({ startMinute, endMinute }) => ({ startAt: clock.at(localDate, startMinute), endAt: clock.at(localDate, endMinute) }));
  const work = merged(toIntervals(settings.workHours).map(window => ({
    startAt: Math.max(window.startAt, firstStart, day.startAt), endAt: Math.min(window.endAt, day.endAt),
  })));
  const padded = ({ startAt, endAt }: Interval) => ({ startAt: startAt - buffer, endAt: endAt + buffer });
  const reservations = [...toIntervals(settings.breaks), ...events.filter(({ event }) => isBusy(event)).map(({ event }) => padded(event))];
  const scheduledBlocks = blocks.map(block => ({ block, range: { startAt: block.startAt, endAt: block.endAt } }));
  const reserve = settings.discretionaryMinutes * minuteMs;
  const focus = new Set(plan?.focusTaskIds ?? []);

  function deadlineAt(task: Task) {
    const deadline = task.deadline;
    if (!deadline) return Infinity;
    if (deadline.kind === "instant") return deadline.at;
    return clock.at(addLocalDays(deadline.date, 1), 0);
  }

  const ordered = tasks.map(task => ({ task, deadline: deadlineAt(task) })).sort((a, b) =>
    a.deadline - b.deadline || priorityOrder[a.task.priority] - priorityOrder[b.task.priority] ||
    a.task.rank - b.task.rank || compareIds(a.task.publicId, b.task.publicId));

  for (const { task, deadline } of ordered) {
    const taskPublicId = task.publicId;
    const estimate = task.estimateMinutes;
    if (task.status === "done" || task.status === "archived" || task.status === "waiting") {
      unscheduled.push({ taskPublicId, reason: "inactive", remainingMinutes: estimate });
      continue;
    }
    if (!Number.isSafeInteger(estimate) || estimate === undefined || estimate < 1) {
      unscheduled.push({ taskPublicId, reason: "missing_estimate" });
      continue;
    }

    const owned = scheduledBlocks.filter(({ block }) => blockTask(block) === task._id);
    const movable = owned.filter(({ block }) => plan && block.planId === plan._id && block.origin !== "manual" &&
      !block.locked && block.startAt >= firstStart && block.startAt >= day.startAt && block.endAt <= day.endAt);
    const replace = movable.length === 1 ? movable[0] : undefined;
    const allottedAt = (excluded?: typeof replace) => duration(merged(owned.filter(ownedBlock => ownedBlock !== excluded)
      .map(({ range }) => ({ startAt: Math.max(day.startAt, range.startAt), endAt: Math.min(day.endAt, range.endAt, deadline) }))));
    const needed = estimate * minuteMs - allottedAt(replace);
    const remaining = Math.max(0, estimate * minuteMs - allottedAt());
    if (needed <= 0) {
      focus.add(task._id);
      continue;
    }

    const occupied = [...reservations, ...scheduledBlocks.filter(block => block !== replace).map(({ range }) => padded(range))];
    const slots = subtract(work, occupied);
    const open = duration(slots);
    // With a single unsplit placement, consider both ends of each slot. At an
    // edge the buffer needs less discretionary time than in the interior.
    const candidates = slots.flatMap(({ startAt, endAt }) => {
      const lastEnd = Math.min(endAt, deadline);
      return lastEnd - startAt < needed ? [] : [{ startAt, endAt: startAt + needed },
        { startAt: lastEnd - needed, endAt: lastEnd }];
    });
    const chosen = candidates.find(interval => {
      const cushion = padded(interval);
      const consumed = slots.reduce((total, slot) => total + Math.max(0,
        Math.min(cushion.endAt, slot.endAt) - Math.max(cushion.startAt, slot.startAt)), 0);
      return open - consumed >= reserve;
    });

    if (!chosen) {
      if (remaining === 0) focus.add(task._id);
      else unscheduled.push({ taskPublicId,
        reason: deadline <= Math.max(firstStart, day.startAt) ||
          (slots.some(slot => slot.endAt - slot.startAt >= needed) && candidates.length === 0) ? "deadline" : "capacity",
        remainingMinutes: Math.ceil(remaining / minuteMs),
      });
      continue;
    }

    focus.add(task._id);
    const placement = { ...chosen, localDate, locked: false };
    if (replace) {
      if (replace.range.startAt === chosen.startAt && replace.range.endAt === chosen.endAt) continue;
      changes.push({ kind: "move_block", blockId: replace.block._id, ...placement });
      placements.push({ ...chosen, taskPublicId, action: "move", blockPublicId: replace.block.publicId });
      replace.range = chosen;
    } else {
      changes.push({ kind: "add_block", taskId: task._id, ...placement });
      placements.push({ ...chosen, taskPublicId, action: "add" });
      reservations.push(padded(chosen));
    }
  }

  changes.push({ kind: "set_focus", taskIds: [...focus] });
  return { changes, summary: { placements, unscheduled } };
}
