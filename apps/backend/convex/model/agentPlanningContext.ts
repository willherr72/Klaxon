import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { blocksInRange, blockTask, compareIds, eventsInRange, preferenceRow, visibleEvent, visiblePreferences } from "./calendarStore";
import { addLocalDays, calendarError, calendarRange, zonedClock } from "./calendarTime";
import { dayPlanRow, hasMeetingConflict, hasStoredReplan } from "./scheduling";

export const planningContextArgs = v.object({ date: v.string(), timezone: v.string() });
const active = ["inbox", "ready", "in_progress", "waiting"] as const;
const priority = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 } as const;
const taskLimit = 20;
const taskSliceLimit = 4;
const stepLimit = 8;
const scheduleLimit = 40;
const followUpLimit = 20;

type Grant = { workspaceId: Id<"workspaces">; userId: Id<"users">; workspace: Pick<Doc<"workspaces">, "publicId"> };

function section<T>(rows: T[], limit: number, incomplete = false) {
  return { items: rows.slice(0, limit), partial: incomplete || rows.length > limit };
}

async function calendarRows<T>(read: Promise<T[]>) {
  try {
    return { rows: await read, incomplete: false };
  } catch (error) {
    if (error instanceof ConvexError && (error.data as { code?: string } | null)?.code === "CALENDAR_RANGE_LIMIT") {
      return { rows: [] as T[], incomplete: true };
    }
    throw error;
  }
}

async function taskCandidates(db: DatabaseReader, workspaceId: Id<"workspaces">, date: string, until: string,
  endAt: number, dueFollowUps: Promise<Doc<"tasks">[]>) {
  const size = taskSliceLimit + 1;
  const byStatus = await Promise.all(active.map(async status => {
    const [dates, instants, planned, unplanned] = await Promise.all([
      db.query("tasks").withIndex("by_workspace_status_deadline_date", q => q.eq("workspaceId", workspaceId)
        .eq("status", status).gte("deadline.date", "").lt("deadline.date", until)).take(size),
      db.query("tasks").withIndex("by_workspace_status_deadline_at", q => q.eq("workspaceId", workspaceId)
        .eq("status", status).gte("deadline.at", -8.64e15).lt("deadline.at", endAt)).take(size),
      db.query("tasks").withIndex("by_workspace_status_planned_rank", q => q.eq("workspaceId", workspaceId)
        .eq("status", status).eq("plannedDate", date)).take(size),
      status === "waiting" ? [] : db.query("tasks").withIndex("by_workspace_status_planned_rank", q =>
        q.eq("workspaceId", workspaceId).eq("status", status).eq("plannedDate", undefined)).take(size),
    ]);
    return { deadlines: [dates, instants], planned, unplanned };
  }));
  const groups = [byStatus.flatMap(result => result.deadlines), byStatus.map(result => result.planned),
    [await dueFollowUps], byStatus.map(result => result.unplanned)];
  const seen = new Set<string>();
  const items = [];
  for (const group of groups) {
    const ordered = group.flatMap(rows => rows.slice(0, taskSliceLimit)).sort((a, b) =>
      priority[a.priority] - priority[b.priority] || a.rank - b.rank || compareIds(a.publicId, b.publicId));
    for (const task of ordered) {
      if (seen.has(task.publicId)) continue;
      seen.add(task.publicId);
      items.push(task);
    }
  }
  return section(items, taskLimit, groups.flat().some(rows => rows.length > taskSliceLimit));
}

async function taskSummary(db: DatabaseReader, task: Doc<"tasks">) {
  const { workspaceId, publicId, title, status, revision, updatedAt, priority, plannedDate, deadline,
    estimateMinutes, followUpDate, rank } = task;
  const steps = await db.query("taskSteps").withIndex("by_workspace_task_rank", q => q.eq("workspaceId", workspaceId)
    .eq("taskId", task._id)).take(stepLimit + 1);
  return { publicId, title, status, revision, updatedAt, priority, plannedDate, deadline, estimateMinutes, followUpDate, rank,
    steps: section(steps.map(({ publicId, title, completed, revision }) => ({ publicId, title, completed, revision })), stepLimit) };
}

async function portableTaskId(db: DatabaseReader, workspaceId: Id<"workspaces">, id: Id<"tasks"> | undefined) {
  const row = id === undefined ? null : await db.get("tasks", id);
  return row?.workspaceId === workspaceId ? row.publicId : undefined;
}

export async function getAgentPlanningContext(db: DatabaseReader, { workspace, workspaceId, userId }: Grant,
  { date, timezone }: Infer<typeof planningContextArgs>) {
  const clock = zonedClock(timezone);
  const day = calendarRange(date, 1, clock);
  if (day.startAt >= day.endAt) calendarError("INVALID_ARGUMENT", "This local date has no elapsed time");
  const asOf = Date.now();
  const dueFollowUps = db.query("tasks").withIndex("by_workspace_status_follow_up_date", q => q.eq("workspaceId", workspaceId)
    .eq("status", "waiting").gte("followUpDate", "").lte("followUpDate", date)).take(followUpLimit + 1);
  const [preferences, plan, candidates, blocks, events, reminders, followUps] = await Promise.all([
    preferenceRow(db, workspaceId, userId), dayPlanRow(db, workspaceId, date),
    taskCandidates(db, workspaceId, date, addLocalDays(date, 1), day.endAt, dueFollowUps),
    calendarRows(blocksInRange(db, workspaceId, day)), calendarRows(eventsInRange(db, workspaceId, userId, day)),
    Promise.all((["pending", "snoozed"] as const).map(state => db.query("reminders")
      .withIndex("by_workspace_state_trigger", q => q.eq("workspaceId", workspaceId).eq("state", state)
        .gte("nextTriggerAt", day.startAt).lt("nextTriggerAt", day.endAt)).take(scheduleLimit + 1))),
    dueFollowUps,
  ]);
  const blockSection = section(blocks.rows, scheduleLimit, blocks.incomplete);
  const meetingSection = section(events.rows, scheduleLimit, events.incomplete);
  const reminderSection = section(reminders.flat().sort((a, b) => (a.nextTriggerAt! - b.nextTriggerAt!) ||
    compareIds(a.publicId, b.publicId)), scheduleLimit);
  const focus = section(plan?.focusTaskIds ?? [], taskLimit);
  let needsReplan: boolean | null = plan ? hasStoredReplan(plan) : false;
  if (plan && !needsReplan) {
    const planDay = calendarRange(date, 1, zonedClock(plan.timezone));
    const [planBlocks, planEvents] = planDay.startAt === day.startAt && planDay.endAt === day.endAt
      ? [blocks, events] as const
      : await Promise.all([calendarRows(blocksInRange(db, workspaceId, planDay)),
        calendarRows(eventsInRange(db, workspaceId, userId, planDay))]);
    needsReplan = planBlocks.incomplete || planEvents.incomplete
      ? null : hasMeetingConflict(planBlocks.rows, planEvents.rows, planDay);
  }

  const [tasks, portableBlocks, portableReminders, focusTasks] = await Promise.all([
    Promise.all(candidates.items.map(task => taskSummary(db, task))),
    Promise.all(blockSection.items.map(async block => {
      const { publicId, revision, title, startAt, endAt, locked, origin } = block;
      return { publicId, revision, title, startAt, endAt, locked, origin,
        planOwned: plan !== null && block.planId === plan._id,
        taskPublicId: await portableTaskId(db, workspaceId, blockTask(block)) };
    })),
    Promise.all(reminderSection.items.map(async reminder => {
      const { publicId, revision, title, state, dueAt, nextTriggerAt, timezone, taskId } = reminder;
      return { publicId, revision, title, state, dueAt, nextTriggerAt, timezone,
        taskPublicId: await portableTaskId(db, workspaceId, taskId) };
    })),
    Promise.all(focus.items.map(taskId => portableTaskId(db, workspaceId, taskId))),
  ]);

  return {
    workspacePublicId: workspace.publicId, date, timezone: clock.timezone, ...day, asOf,
    tasks: { ...candidates, items: tasks }, blocks: { ...blockSection, items: portableBlocks },
    meetings: { ...meetingSection, items: meetingSection.items.map(visibleEvent) },
    reminders: { ...reminderSection, items: portableReminders }, preferences: visiblePreferences(preferences),
    followUps: section(followUps.map(({ publicId, title, followUpDate, revision }) =>
      ({ publicId, title, followUpDate, revision })), followUpLimit),
    dayPlan: plan ? { publicId: plan.publicId, revision: plan.revision, timezone: plan.timezone,
      publishedAt: plan.publishedAt, focusTaskPublicIds: focusTasks.filter(id => id !== undefined), focusPartial: focus.partial,
      briefing: plan.briefingUpdatedAt === undefined ? undefined : plan.briefing,
      briefingUpdatedAt: plan.briefingUpdatedAt, needsReplan } : null,
  };
}
