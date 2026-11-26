import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  diagnostic,
  instant,
  localDate,
  notificationChannel,
  provider,
  timezone,
  workspaceMutableFields,
} from "./values";

export const integrationTables = {
  externalLinks: defineTable({
    ...workspaceMutableFields,
    taskId: v.id("tasks"),
    provider: v.union(provider, v.literal("url")),
    connectionId: v.optional(v.id("integrationConnections")),
    externalObjectId: v.optional(v.string()),
    canonicalUrl: v.optional(v.string()),
    label: v.optional(v.string()),
    relationship: v.union(v.literal("reference"), v.literal("managed_mirror")),
    removedAt: v.optional(instant),
    cached: v.optional(v.object({
      title: v.optional(v.string()),
      status: v.optional(v.string()),
      priority: v.optional(v.string()),
      deadlineDate: v.optional(localDate),
    })),
    refreshedAt: v.optional(instant),
  })
    .index("by_workspace_task", ["workspaceId", "taskId"])
    .index("by_workspace_removed_task", ["workspaceId", "removedAt", "taskId"])
    // A managed mirror is unique within a connection and object. Manual links can share it.
    .index("by_workspace_connection_external_id", [
      "workspaceId", "connectionId", "externalObjectId", "relationship",
    ])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  calendarEvents: defineTable({
    ...workspaceMutableFields,
    connectionId: v.id("integrationConnections"),
    provider,
    externalEventId: v.string(),
    seriesId: v.optional(v.string()),
    startAt: instant,
    endAt: instant,
    timezone,
    localDate,
    endLocalDate: v.optional(localDate), // Exclusive for all-day events.
    allDay: v.boolean(),
    availability: v.union(
      v.literal("free"),
      v.literal("tentative"),
      v.literal("busy"),
      v.literal("out_of_office"),
      v.literal("working_elsewhere"),
      v.literal("unknown"),
    ),
    title: v.optional(v.string()), // Absent under busy-only policy.
    lastSeenAt: instant,
    deletedAt: v.optional(instant),
  })
    .index("by_workspace_connection_external_id", ["workspaceId", "connectionId", "externalEventId"])
    .index("by_workspace_local_date", ["workspaceId", "localDate", "startAt"])
    .index("by_workspace_start_at", ["workspaceId", "startAt"])
    .index("by_workspace_end_at", ["workspaceId", "endAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  integrationConnections: defineTable({
    ...workspaceMutableFields,
    userId: v.id("users"),
    provider,
    accountId: v.string(),
    scopeIds: v.array(v.string()),
    grantedScopes: v.optional(v.array(v.string())),
    secretRef: v.optional(v.string()),
    state: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("reauthorization_required"),
      v.literal("disconnected"),
    ),
    metadataPolicy: v.optional(v.union(v.literal("minimal"), v.literal("busy_only"))),
    label: v.optional(v.string()),
  })
    .index("by_workspace_provider_account", ["workspaceId", "provider", "accountId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  syncCheckpoints: defineTable({
    ...workspaceMutableFields,
    connectionId: v.id("integrationConnections"),
    stream: v.string(),
    cursor: v.optional(v.string()),
    lastSuccessAt: v.optional(instant),
    lastError: v.optional(diagnostic),
    lastErrorAt: v.optional(instant),
  })
    .index("by_workspace_connection_stream", ["workspaceId", "connectionId", "stream"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  pushSubscriptions: defineTable({
    ...workspaceMutableFields,
    userId: v.id("users"),
    deviceId: v.string(),
    channel: notificationChannel,
    subscriptionHash: v.optional(v.string()),
    // Reference to protected Web Push endpoint and encryption details, when used.
    secretRef: v.optional(v.string()),
    lastSeenAt: v.optional(instant),
    revokedAt: v.optional(instant),
  })
    .index("by_workspace_user_device", ["workspaceId", "userId", "deviceId", "channel"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  deliveryAttempts: defineTable({
    ...workspaceMutableFields,
    occurrenceId: v.id("reminderOccurrences"),
    occurrenceKey: v.string(),
    subscriptionId: v.optional(v.id("pushSubscriptions")),
    deviceId: v.string(),
    channel: notificationChannel,
    attempt: v.number(),
    status: v.union(
      v.literal("scheduled"),
      v.literal("attempted"),
      v.literal("accepted_by_provider"),
      v.literal("acknowledged"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    attemptedAt: v.optional(instant),
    acceptedAt: v.optional(instant),
    acknowledgedAt: v.optional(instant),
    error: v.optional(diagnostic),
  })
    .index("by_workspace_occurrence_device", ["workspaceId", "occurrenceKey", "deviceId", "attempt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),
};
