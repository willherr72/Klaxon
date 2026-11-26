import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  instant,
  localDate,
  priority,
  source,
  timezone,
  weekday,
  workspaceMutableFields,
} from "./values";

const planSource = v.union(v.literal("manual"), v.literal("agent"), v.literal("automation"));

const blockFields = {
  ...workspaceMutableFields,
  startAt: instant,
  endAt: instant,
  localDate,
  timezone,
  locked: v.boolean(),
  origin: planSource,
  planId: v.optional(v.id("dayPlans")),
};

const reminderState = v.union(
  v.literal("pending"),
  v.literal("fired"),
  v.literal("snoozed"),
  v.literal("dismissed"),
  v.literal("completed"),
);

export const recurrenceRule = v.union(
  v.object({ kind: v.literal("daily") }),
  v.object({ kind: v.literal("weekly"), weekdays: v.array(weekday) }),
  // Retain 29–31 when present in legacy data. Recurrence policy is a domain decision.
  v.object({ kind: v.literal("monthly"), day: v.number() }),
  v.object({ kind: v.literal("interval"), everySeconds: v.number() }),
);

export const planningTables = {
  timeBlocks: defineTable(v.union(
    v.object({ ...blockFields, taskId: v.id("tasks"), title: v.optional(v.string()) }),
    v.object({ ...blockFields, title: v.string() }),
  ))
    .index("by_workspace_local_date", ["workspaceId", "localDate", "startAt"])
    .index("by_workspace_start_at", ["workspaceId", "startAt"])
    .index("by_workspace_end_at", ["workspaceId", "endAt"])
    .index("by_workspace_task", ["workspaceId", "taskId", "startAt"])
    .index("by_workspace_plan", ["workspaceId", "planId", "startAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  dayPlans: defineTable({
    ...workspaceMutableFields,
    localDate,
    timezone,
    briefing: v.optional(v.string()),
    source: planSource,
    focusTaskIds: v.array(v.id("tasks")),
    publishedAt: v.optional(instant),
    needsReplan: v.optional(v.boolean()),
  })
    .index("by_workspace_local_date", ["workspaceId", "localDate"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  reminders: defineTable({
    ...workspaceMutableFields,
    taskId: v.optional(v.id("tasks")),
    title: v.string(),
    description: v.optional(v.string()),
    priority,
    dueAt: instant,
    timezone,
    state: reminderState,
    recurrence: v.optional(recurrenceRule),
    recurrenceAnchorAt: v.optional(instant),
    recurrenceBasis: v.optional(v.union(v.literal("local_timezone"), v.literal("legacy_utc"))),
    snoozeUntil: v.optional(instant),
    // Pending and snoozed rows carry snoozeUntil ?? dueAt. Other states omit it.
    nextTriggerAt: v.optional(instant),
    source: v.optional(source),
    tags: v.optional(v.array(v.string())),
  })
    .index("by_workspace_state_trigger", ["workspaceId", "state", "nextTriggerAt"])
    .index("by_workspace_due_at", ["workspaceId", "dueAt"])
    .index("by_workspace_task", ["workspaceId", "taskId", "dueAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  reminderOccurrences: defineTable({
    ...workspaceMutableFields,
    reminderId: v.id("reminders"),
    reminderPublicId: v.optional(v.string()),
    reminderTitle: v.optional(v.string()),
    reminderRevision: v.number(),
    occurrenceKey: v.string(),
    dueAt: instant,
    timezone,
    snoozeUntil: v.optional(instant),
    state: v.union(reminderState, v.literal("cancelled")),
    deliveryState: v.union(
      v.literal("disabled"),
      v.literal("scheduled"),
      v.literal("attempted"),
      v.literal("accepted_by_provider"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    acknowledgedAt: v.optional(instant),
    jobId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_workspace_occurrence_key", ["workspaceId", "occurrenceKey"])
    .index("by_workspace_reminder_due_at", ["workspaceId", "reminderId", "dueAt"])
    .index("by_workspace_due_at", ["workspaceId", "dueAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),
};
