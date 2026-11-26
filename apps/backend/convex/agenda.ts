import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { addLocalDays, calendarRange, validateInstant, zonedClock } from "./model/calendarTime";

const active = ["inbox", "ready", "in_progress", "waiting"] as const;
const groupLimit = 8;
const weight = { none: 0, low: 1, normal: 2, high: 3, urgent: 4 };
type Task = Doc<"tasks">;

function summary(task: Task) {
  const { publicId, title, status, priority, revision, projectId, plannedDate, deadline, estimateMinutes,
    followUpDate, waitingPerson, waitingReason, rank } = task;
  return { publicId, title, status, priority, revision, projectId, plannedDate, deadline, estimateMinutes,
    followUpDate, waitingPerson, waitingReason, rank };
}

function section(slices: Task[][]) {
  const rows = slices.flat().sort((a, b) => weight[b.priority] - weight[a.priority] ||
    a.rank - b.rank || a.publicId.localeCompare(b.publicId));
  return { items: rows.slice(0, groupLimit).map(summary), partial: rows.length > groupLimit };
}

type UpcomingItem = {
  kind: "planned" | "deadline" | "reminder"; publicId: string; title: string; date: string; at?: number;
};

export const upcoming = query({
  args: { workspaceId: v.id("workspaces"), from: v.string(), timezone: v.string() },
  handler: async (ctx, { workspaceId, from, timezone }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    const clock = zonedClock(timezone);
    const until = addLocalDays(from, 7);
    const { startAt, endAt } = calendarRange(from, 7, clock);
    const limit = 12;
    const [tasks, reminders] = await Promise.all([
      Promise.all(active.map(async status => {
        const [planned, dates, instants] = await Promise.all([
          ctx.db.query("tasks").withIndex("by_workspace_status_planned_rank", q => q.eq("workspaceId", workspaceId)
            .eq("status", status).gte("plannedDate", from).lt("plannedDate", until)).take(limit + 1),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_date", q => q.eq("workspaceId", workspaceId)
            .eq("status", status).gte("deadline.date", from).lt("deadline.date", until)).take(limit + 1),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_at", q => q.eq("workspaceId", workspaceId)
            .eq("status", status).gte("deadline.at", startAt).lt("deadline.at", endAt)).take(limit + 1),
        ]);
        const items: UpcomingItem[] = [];
        for (const { publicId, title, plannedDate } of planned) {
          if (plannedDate) items.push({ kind: "planned", publicId, title, date: plannedDate });
        }
        for (const { publicId, title, deadline } of [...dates, ...instants]) {
          if (deadline?.kind === "date") items.push({ kind: "deadline", publicId, title, date: deadline.date });
          if (deadline?.kind === "instant") items.push({ kind: "deadline", publicId, title, date: clock.date(deadline.at), at: deadline.at });
        }
        return items;
      })),
      Promise.all((["pending", "snoozed"] as const).map(state =>
        ctx.db.query("reminders").withIndex("by_workspace_state_trigger", q => q.eq("workspaceId", workspaceId)
          .eq("state", state).gte("nextTriggerAt", startAt).lt("nextTriggerAt", endAt)).take(limit + 1))),
    ]);
    const items: UpcomingItem[] = tasks.flat();
    for (const { publicId, title, nextTriggerAt } of reminders.flat()) {
      if (nextTriggerAt !== undefined) items.push({ kind: "reminder", publicId, title, date: clock.date(nextTriggerAt), at: nextTriggerAt });
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || (a.at ?? -Infinity) - (b.at ?? -Infinity) ||
      a.title.localeCompare(b.title) || a.publicId.localeCompare(b.publicId));
    return { from, until, timezone: clock.timezone, items: items.slice(0, limit), partial: items.length > limit };
  },
});

export const today = query({
  args: { workspaceId: v.id("workspaces"), localDate: v.string(), timezone: v.string(), asOf: v.number() },
  handler: async (ctx, { workspaceId, localDate, timezone, asOf }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    const clock = zonedClock(timezone);
    const { startAt, endAt } = calendarRange(localDate, 1, clock);
    validateInstant(asOf);
    if (asOf < startAt || asOf >= endAt) throw new ConvexError({ code: "INVALID_ARGUMENT", field: "asOf" });
    // Read one extra row per slice so the UI can distinguish an empty queue from a partial overview.
    const size = groupLimit + 1;
    const [sections, followUps, dayPlan] = await Promise.all([
      Promise.all(active.map(async status => {
        const [planned, unplanned, lateDates, lateInstants, dueDates, dueInstants] = await Promise.all([
          ctx.db.query("tasks").withIndex("by_workspace_status_planned_rank", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).eq("plannedDate", localDate)).take(size),
          ctx.db.query("tasks").withIndex("by_workspace_status_planned_rank", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).eq("plannedDate", undefined)).take(size),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_date", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).gte("deadline.date", "").lt("deadline.date", localDate)).take(size),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_at", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).gte("deadline.at", -8.64e15).lt("deadline.at", asOf)).take(size),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_date", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).eq("deadline.date", localDate)).take(size),
          ctx.db.query("tasks").withIndex("by_workspace_status_deadline_at", q =>
            q.eq("workspaceId", workspaceId).eq("status", status).gte("deadline.at", asOf).lt("deadline.at", endAt)).take(size),
        ]);
        return { planned, unplanned, overdue: [...lateDates, ...lateInstants], dueToday: [...dueDates, ...dueInstants] };
      })),
      ctx.db.query("tasks").withIndex("by_workspace_status_follow_up_date", q =>
        q.eq("workspaceId", workspaceId).eq("status", "waiting").gte("followUpDate", "").lte("followUpDate", localDate)).take(size),
      ctx.db.query("dayPlans").withIndex("by_workspace_local_date", q =>
        q.eq("workspaceId", workspaceId).eq("localDate", localDate)).unique(),
    ]);
    const focus = await Promise.all((dayPlan?.focusTaskIds ?? []).slice(0, groupLimit).map(id => ctx.db.get("tasks", id)));
    return {
      localDate, timezone: clock.timezone, briefing: dayPlan?.briefing, needsReplan: dayPlan?.needsReplan ?? false,
      focus: { items: focus.filter((task): task is Task => Boolean(task && task.workspaceId === workspaceId &&
        task.status !== "archived" && task.status !== "done")).map(summary), partial: (dayPlan?.focusTaskIds.length ?? 0) > groupLimit },
      planned: section(sections.map(s => s.planned)), unplanned: section(sections.map(s => s.unplanned)),
      overdue: section(sections.map(s => s.overdue)), dueToday: section(sections.map(s => s.dueToday)),
      followUps: section([followUps]),
    };
  },
});
