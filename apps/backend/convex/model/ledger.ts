import { defineTable } from "convex/server";
import { v } from "convex/values";
import { taskDomainCommand } from "./taskDomainCommands";
import {
  actor,
  deadline,
  diagnostic,
  instant,
  localDate,
  timezone,
  unarchivedTaskStatus,
  workspaceMutableFields,
  workspaceRecordFields,
} from "./values";

const target = v.union(
  v.object({ kind: v.literal("workspace"), id: v.id("workspaces") }),
  v.object({ kind: v.literal("membership"), id: v.id("memberships") }),
  v.object({ kind: v.literal("preferences"), id: v.id("preferences") }),
  v.object({ kind: v.literal("project"), id: v.id("projects") }),
  v.object({ kind: v.literal("lane"), id: v.id("lanes") }),
  v.object({ kind: v.literal("task"), id: v.id("tasks") }),
  v.object({ kind: v.literal("task_step"), id: v.id("taskSteps") }),
  v.object({ kind: v.literal("external_link"), id: v.id("externalLinks") }),
  v.object({ kind: v.literal("time_block"), id: v.id("timeBlocks") }),
  v.object({ kind: v.literal("day_plan"), id: v.id("dayPlans") }),
  v.object({ kind: v.literal("plan_revision"), id: v.id("planRevisions") }),
  v.object({ kind: v.literal("reminder"), id: v.id("reminders") }),
  v.object({ kind: v.literal("occurrence"), id: v.id("reminderOccurrences") }),
  v.object({ kind: v.literal("capture"), id: v.id("captures") }),
  v.object({ kind: v.literal("day_note"), id: v.id("dayNotes") }),
  v.object({ kind: v.literal("calendar_event"), id: v.id("calendarEvents") }),
  v.object({ kind: v.literal("connection"), id: v.id("integrationConnections") }),
  v.object({ kind: v.literal("agent_credential"), id: v.id("agentCredentials") }),
  v.object({ kind: v.literal("push_subscription"), id: v.id("pushSubscriptions") }),
  v.object({ kind: v.literal("import_run"), id: v.id("importRuns") }),
);

const patchValue = v.union(v.string(), v.number(), v.boolean(), v.null(), v.array(v.string()), deadline);

const placement = {
  localDate,
  startAt: instant,
  endAt: instant,
  locked: v.boolean(),
};

const planChange = v.union(
  v.object({ kind: v.literal("add_block"), taskId: v.id("tasks"), ...placement }),
  v.object({ kind: v.literal("add_standalone_block"), title: v.string(), ...placement }),
  v.object({ kind: v.literal("move_block"), blockId: v.id("timeBlocks"), ...placement }),
  v.object({ kind: v.literal("remove_block"), blockId: v.id("timeBlocks") }),
  v.object({ kind: v.literal("set_focus"), taskIds: v.array(v.id("tasks")) }),
  v.object({ kind: v.literal("set_briefing"), briefing: v.optional(v.string()) }),
);

const importIssue = v.object({
  code: v.string(),
  message: v.optional(v.string()),
  field: v.optional(v.string()),
  // Keep the source value for unsupported state/recurrence and similar scalar diagnostics.
  sourceValue: v.optional(v.string()),
});

export const ledgerTables = {
  agentCredentials: defineTable({
    ...workspaceMutableFields,
    userId: v.id("users"),
    label: v.string(),
    tokenHash: v.string(),
    scopes: v.array(v.string()),
    expiresAt: instant,
    revokedAt: v.optional(instant),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  operationReceipts: defineTable({
    ...workspaceRecordFields,
    actor,
    // Derive a kind-prefixed principal key on the server for actor-scoped replay.
    actorKey: v.string(),
    operationId: v.string(),
    fingerprintVersion: v.number(),
    inputFingerprint: v.string(),
    result: v.object({
      target: v.optional(target),
      targetPublicId: v.optional(v.string()),
      revision: v.optional(v.number()),
      activityEventId: v.optional(v.id("activityEvents")),
    }),
    expiresAt: v.optional(instant),
  })
    .index("by_workspace_actor_operation", ["workspaceId", "actorKey", "operationId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  taskUndoChanges: defineTable({
    workspaceId: v.id("workspaces"),
    eventId: v.id("activityEvents"),
    command: taskDomainCommand,
    completedAt: v.optional(instant),
    archivedAt: v.optional(instant),
    archivedFromStatus: v.optional(unarchivedTaskStatus),
    rankTieBreak: v.optional(v.number()),
  }).index("by_workspace_event", ["workspaceId","eventId"]),

  activityEvents: defineTable({
    ...workspaceRecordFields,
    actor,
    origin: v.union(
      v.literal("app"),
      v.literal("api"),
      v.literal("mcp"),
      v.literal("integration"),
      v.literal("automation"),
      v.literal("import"),
    ),
    action: v.string(),
    target,
    targetPublicId: v.string(),
    outcome: v.union(v.literal("applied"), v.literal("rejected")),
    operationId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    beforeRevision: v.optional(v.number()),
    afterRevision: v.optional(v.number()),
    patch: v.optional(v.array(v.object({
      field: v.string(),
      before: v.optional(patchValue),
      after: v.optional(patchValue),
    }))),
    reason: v.optional(v.string()),
    undoEligible: v.boolean(),
  })
    .index("by_workspace_created_at", ["workspaceId", "createdAt"])
    .index("by_workspace_target", ["workspaceId", "target.kind", "targetPublicId", "createdAt"])
    .index("by_workspace_correlation", ["workspaceId", "correlationId"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  planRevisions: defineTable({
    ...workspaceMutableFields,
    planId: v.optional(v.id("dayPlans")),
    localDate,
    timezone,
    actor,
    state: v.union(
      v.literal("preview"),
      v.literal("applied"),
      v.literal("discarded"),
      v.literal("expired"),
    ),
    baseDayPlanRevision: v.union(v.number(), v.null()), // null previews a day without a saved plan.
    appliedDayPlanRevision: v.optional(v.number()),
    expiresAt: v.optional(instant),
    appliedAt: v.optional(instant),
    // Detect changes to the dependency set as well as updates to known rows.
    contextFingerprint: v.string(),
    dependencies: v.array(v.object({ target, revision: v.number() })),
    changes: v.array(planChange),
    previewSummary: v.optional(v.object({
      placements: v.array(v.object({
        taskPublicId: v.string(), startAt: instant, endAt: instant,
        action: v.union(v.literal("add"), v.literal("move")), blockPublicId: v.optional(v.string()),
      })),
      unscheduled: v.array(v.object({
        taskPublicId: v.string(), remainingMinutes: v.optional(v.number()),
        reason: v.union(v.literal("capacity"), v.literal("deadline"), v.literal("missing_estimate"), v.literal("inactive")),
      })),
    })),
    reason: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    undoEligible: v.boolean(),
  })
    .index("by_workspace_plan", ["workspaceId", "planId", "createdAt"])
    .index("by_workspace_local_date", ["workspaceId", "localDate", "createdAt"])
    .index("by_workspace_state_expiry", ["workspaceId", "state", "expiresAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  importRuns: defineTable({
    ...workspaceMutableFields,
    archiveHash: v.string(),
    sourceOrigin: v.string(), // Pseudonymous device or portable archive origin.
    format: v.union(v.literal("legacy_sqlite"), v.literal("portable_json")),
    exportFormatVersion: v.number(),
    sourceSchemaVersion: v.number(),
    destinationTimezone: v.optional(timezone),
    state: v.union(
      v.literal("staged"),
      v.literal("running"),
      v.literal("needs_reconciliation"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    counts: v.array(v.object({
      sourceTable: v.string(),
      extracted: v.number(),
      imported: v.number(),
      skipped: v.number(),
      rejected: v.number(),
      divergent: v.number(),
    })),
    checkpoint: v.optional(v.object({ phase: v.string(), nextBatch: v.number() })),
    errors: v.array(diagnostic),
    verification: v.optional(v.object({
      verifiedAt: instant,
      verifiedBy: v.id("users"),
      checks: v.array(v.object({ code: v.string(), passed: v.boolean() })),
      reportHash: v.optional(v.string()),
    })),
  })
    .index("by_workspace_archive_origin", ["workspaceId", "archiveHash", "sourceOrigin"])
    .index("by_workspace_created_at", ["workspaceId", "createdAt"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),

  importMappings: defineTable({
    ...workspaceMutableFields,
    // Use the original table name, e.g. "reminders" for both legacy task and reminder rows.
    sourceTable: v.string(),
    legacyId: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("imported"),
      v.literal("divergent"),
      v.literal("quarantined"),
      v.literal("deleted"),
    ),
    destination: v.optional(target),
    destinationPublicId: v.optional(v.string()),
    selectedRunId: v.optional(v.id("importRuns")),
    reconciledAt: v.optional(instant),
    candidates: v.array(v.object({
      runId: v.id("importRuns"),
      payloadHash: v.string(),
      // Optional private copy of a validated projection for deferred reconciliation.
      payloadStorageId: v.optional(v.id("_storage")),
      sourceUpdatedAt: v.optional(instant),
      sourceDeletedAt: v.optional(instant),
      sourceOrder: v.optional(v.number()),
      issues: v.optional(v.array(importIssue)),
    })),
  })
    .index("by_workspace_source_legacy_id", ["workspaceId", "sourceTable", "legacyId"])
    .index("by_workspace_state", ["workspaceId", "state"])
    .index("by_workspace_public_id", ["workspaceId", "publicId"]),
};
