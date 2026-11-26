import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  deadline,
  instant,
  localDate,
  mutableFields,
  priority,
  provider,
  source,
  taskStatus,
  timezone,
  weekday,
  workspaceMutableFields,
} from "./values";

const workWindow = v.object({
  weekday,
  startMinute: v.number(),
  endMinute: v.number(),
});

export const workTables = {
  // App-owned user ID supplied by the Convex Auth component's create callback.
  users: defineTable({}),

  workspaces: defineTable({
    ...mutableFields,
    ownerId: v.id("users"),
    name: v.string(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_public_id", ["publicId"]),

  memberships: defineTable({
    ...workspaceMutableFields,
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("planner"), v.literal("reader")),
  })
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_user_workspace", ["userId", "workspaceId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  preferences: defineTable({
    ...workspaceMutableFields,
    userId: v.id("users"),
    timezone,
    workHours: v.array(workWindow),
    breaks: v.optional(v.array(workWindow)),
    bufferMinutes: v.optional(v.number()),
    autonomyPolicy: v.object({
      planApplication: v.union(v.literal("review"), v.literal("automatic")),
      lockManuallyMovedBlocks: v.boolean(),
      discretionaryMinutes: v.optional(v.number()),
    }),
    notificationSettings: v.object({
      enabled: v.boolean(),
      webPush: v.boolean(),
      native: v.boolean(),
    }),
    importFilters: v.array(v.object({
      provider,
      connectionId: v.optional(v.id("integrationConnections")),
      assignedOnly: v.optional(v.boolean()),
      scopeIds: v.optional(v.array(v.string())),
      excludedObjectIds: v.optional(v.array(v.string())),
    })),
  })
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  projects: defineTable({
    ...workspaceMutableFields,
    name: v.string(),
    area: v.optional(v.string()),
    rank: v.number(),
    archivedAt: v.optional(instant),
    board: v.optional(v.object({ laneIds: v.array(v.id("lanes")) })),
  })
    .index("by_workspace_rank", ["workspaceId", "rank"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  lanes: defineTable({
    ...workspaceMutableFields,
    name: v.string(),
    area: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
    rank: v.number(),
    isDefault: v.boolean(),
    archivedAt: v.optional(instant),
  })
    .index("by_workspace_rank", ["workspaceId", "rank", "createdAt", "publicId"])
    .index("by_workspace_project_rank", ["workspaceId", "projectId", "rank"])
    .index("by_workspace_default", ["workspaceId", "isDefault"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  tasks: defineTable({
    ...workspaceMutableFields,
    title: v.string(),
    description: v.optional(v.string()),
    status: taskStatus,
    priority,
    rank: v.number(),
    // Optional observed order when imported tasks share the same lane and rank.
    rankTieBreak: v.optional(v.number()),
    projectId: v.optional(v.id("projects")),
    laneId: v.optional(v.id("lanes")),
    plannedDate: v.optional(localDate),
    deadline: v.optional(deadline),
    estimateMinutes: v.optional(v.number()),
    source: v.optional(source),
    tags: v.optional(v.array(v.string())),
    waitingReason: v.optional(v.string()),
    waitingPerson: v.optional(v.string()),
    followUpDate: v.optional(localDate),
    completedAt: v.optional(instant),
    archivedAt: v.optional(instant),
  })
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_workspace_planned_date", ["workspaceId", "plannedDate"])
    .index("by_workspace_deadline_date", ["workspaceId", "deadline.date"])
    .index("by_workspace_deadline_at", ["workspaceId", "deadline.at"])
    .index("by_workspace_project_rank", ["workspaceId", "projectId", "rank"])
    .index("by_workspace_lane_rank", ["workspaceId", "laneId", "rank", "rankTieBreak", "publicId"])
    .index("by_workspace_status_follow_up_date", ["workspaceId", "status", "followUpDate"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["workspaceId", "status", "projectId"],
    }),

  taskSteps: defineTable({
    ...workspaceMutableFields,
    taskId: v.id("tasks"),
    title: v.string(),
    completed: v.boolean(),
    completedAt: v.optional(instant),
    rank: v.number(),
  })
    .index("by_workspace_task_rank", ["workspaceId", "taskId", "rank", "publicId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  captures: defineTable({
    ...workspaceMutableFields,
    body: v.string(),
    tags: v.array(v.string()),
    source: v.optional(source),
    localDate: v.optional(localDate),
    promotedTaskId: v.optional(v.id("tasks")),
    archivedAt: v.optional(instant),
  })
    .index("by_workspace_local_date", ["workspaceId", "localDate"])
    .index("by_workspace_created_at", ["workspaceId", "createdAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["workspaceId"] }),

  dayNotes: defineTable({
    ...workspaceMutableFields,
    localDate,
    body: v.string(),
    tags: v.optional(v.array(v.string())),
    source: v.optional(source),
  })
    .index("by_workspace_local_date", ["workspaceId", "localDate"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),
};
