import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query, type DatabaseReader } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { normalizePreferences, preferenceRow, preferenceValues, visiblePreferences } from "./model/calendarStore";
import { overlapFields } from "./model/calendarOverlap";
import { calendarError, minuteMs } from "./model/calendarTime";
import { requireExpectedRevision, runOperation } from "./model/operations";
import { taskByPublicId } from "./model/reads";
import { buildSchedule, dayPlanRow, planningContext, visibleDayPlan } from "./model/scheduling";

const scope = { workspaceId: v.id("workspaces") };
const date = { localDate: v.string() };
const operation = { operationId: v.string() };
const maxTasks = 40;
const previewLifetime = 10 * minuteMs;

export const getPreferences = query({
  args: scope,
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    return visiblePreferences(await preferenceRow(ctx.db, workspaceId, userId));
  },
});

function validRevision(revision: number, min: number) {
  if (!Number.isSafeInteger(revision) || revision < min) calendarError("INVALID_ARGUMENT", "Invalid expected revision");
}

export const updatePreferences = mutation({
  args: { ...scope, ...operation, expectedRevision: v.number(), preferences: preferenceValues },
  handler: async (ctx, { workspaceId, operationId, expectedRevision, preferences }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    validRevision(expectedRevision, 0);
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "planning.updatePreferences",
      operationId, expectedRevision: expectedRevision || undefined, input: { preferences, expectedRevision },
    }, async ({ db, now }) => {
      const row = await preferenceRow(db, workspaceId, userId);
      requireExpectedRevision(expectedRevision, row?.revision ?? 0);
      const { timezone, workHours, breaks, bufferMinutes, discretionaryMinutes, lockManuallyMovedBlocks } = normalizePreferences(preferences);
      const publicId = row?.publicId ?? crypto.randomUUID();
      const revision = expectedRevision + 1;
      const values = { timezone, workHours, breaks, bufferMinutes, updatedAt: now, revision,
        autonomyPolicy: { planApplication: row?.autonomyPolicy.planApplication ?? ("review" as const),
          lockManuallyMovedBlocks, discretionaryMinutes } };
      let id: Id<"preferences">;
      if (row) {
        id = row._id;
        await db.patch("preferences", id, values);
      } else {
        id = await db.insert("preferences", { ...values, workspaceId, userId, publicId, createdAt: now,
          notificationSettings: { enabled: false, native: false, webPush: false }, importFilters: [] });
      }
      return { target: { kind: "preferences", id }, targetPublicId: publicId, revision, beforeRevision: row?.revision };
    });
  },
});

export const getDayPlan = query({
  args: { ...scope, ...date },
  handler: async (ctx, { workspaceId, localDate }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    return visibleDayPlan(ctx.db, workspaceId, userId, localDate);
  },
});

function revisionByPublicId(db: DatabaseReader, workspaceId: Id<"workspaces">, publicId: string) {
  return db.query("planRevisions").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
}

export const preview = mutation({
  args: { ...scope, ...operation, ...date, taskPublicIds: v.array(v.string()),
    expectedDayPlanRevision: v.union(v.number(), v.null()) },
  handler: async (ctx, { workspaceId, operationId, localDate, taskPublicIds, expectedDayPlanRevision }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    if (expectedDayPlanRevision !== null) validRevision(expectedDayPlanRevision, 1);
    if (taskPublicIds.length === 0 || taskPublicIds.length > maxTasks ||
        taskPublicIds.some(id => !id.trim() || id.length > 200) || new Set(taskPublicIds).size !== taskPublicIds.length) {
      calendarError("INVALID_ARGUMENT", "Select 1–40 distinct tasks by public ID");
    }
    const actor = { kind: "user" as const, userId };
    const result = await runOperation(ctx.db, { workspace, actor, origin: "app", action: "planning.preview", operationId,
      input: { localDate, taskPublicIds, expectedDayPlanRevision },
    }, async ({ db, now }) => {
      const [plan, selected] = await Promise.all([
        dayPlanRow(db, workspaceId, localDate), Promise.all(taskPublicIds.map(id => taskByPublicId(db, workspaceId, id))),
      ]);
      const revision = plan?.revision ?? null;
      if (expectedDayPlanRevision !== revision) throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision: revision });
      const tasks = selected.map(task => task ?? calendarError("TASK_UNAVAILABLE"));
      const context = await planningContext(db, workspaceId, userId, localDate, tasks, plan);
      if (context.day.endAt <= now || context.day.endAt <= context.day.startAt) {
        calendarError("INVALID_ARGUMENT", "Plans require a current or future local day");
      }
      const { changes, summary } = buildSchedule(context, now);
      const sourceStart = new Map(context.blocks.map(block => [block._id, block.startAt]));
      let expiresAt = Math.min(now + previewLifetime, context.day.endAt);
      for (const change of changes) {
        if (change.kind === "add_block") expiresAt = Math.min(expiresAt, change.startAt);
        if (change.kind === "move_block") {
          const originalStart = sourceStart.get(change.blockId);
          if (originalStart === undefined) throw new Error("A scheduled move has no source block");
          expiresAt = Math.min(expiresAt, change.startAt, originalStart);
        }
      }
      const publicId = crypto.randomUUID();
      const id = await db.insert("planRevisions", { workspaceId, publicId, createdAt: now, updatedAt: now, revision: 1,
        planId: plan?._id, localDate, timezone: context.clock.timezone, actor, state: "preview", baseDayPlanRevision: revision,
        expiresAt, contextFingerprint: context.contextFingerprint,
        dependencies: context.dependencies, changes, previewSummary: summary, undoEligible: false });
      return { target: { kind: "plan_revision", id }, targetPublicId: publicId, revision: 1 };
    });
    const saved = await revisionByPublicId(ctx.db, workspaceId, result.targetPublicId);
    if (!saved?.previewSummary || saved.expiresAt === undefined) throw new Error("Preview receipt has no saved preview");
    return { publicId: saved.publicId, revision: result.revision, localDate: saved.localDate, timezone: saved.timezone,
      expiresAt: saved.expiresAt, baseDayPlanRevision: saved.baseDayPlanRevision, ...saved.previewSummary };
  },
});

// Storage serialization can change object field order. Compare the proposed
// changes by value before writing anything from a persisted preview.
function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

export const apply = mutation({
  args: { ...scope, ...operation, publicId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, { workspaceId, operationId, publicId, expectedRevision }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "planning.apply",
      operationId, targetPublicId: publicId, expectedRevision, input: null,
    }, async ({ db, now }) => {
      const saved = await revisionByPublicId(db, workspaceId, publicId);
      if (!saved?.previewSummary || saved.actor.kind !== "user" || saved.actor.userId !== userId) calendarError("PLAN_UNAVAILABLE");
      requireExpectedRevision(expectedRevision, saved.revision);
      if (saved.state !== "preview") calendarError("PLAN_NOT_PENDING");
      if (saved.expiresAt === undefined || saved.expiresAt <= now) calendarError("PLAN_EXPIRED");

      const taskIds = saved.dependencies.flatMap(({ target }) => target.kind === "task" ? [target.id] : []);
      const [plan, selected] = await Promise.all([
        dayPlanRow(db, workspaceId, saved.localDate), Promise.all(taskIds.map(id => db.get("tasks", id))),
      ]);
      const currentRevision = plan?.revision ?? null;
      function changed(): never {
        throw new ConvexError({ code: "PLAN_CONTEXT_CHANGED", currentRevision });
      }
      if (saved.baseDayPlanRevision !== currentRevision) changed();
      const tasks = selected.map(task => task?.workspaceId === workspaceId ? task : changed());
      const context = await planningContext(db, workspaceId, userId, saved.localDate, tasks, plan);
      if (context.contextFingerprint !== saved.contextFingerprint || context.clock.timezone !== saved.timezone) changed();
      const current = buildSchedule(context, saved.createdAt);
      if (canonicalJson(saved.changes) !== canonicalJson(current.changes)) changed();
      const blockMap = new Map(context.blocks.map(block => [block._id, block]));
      for (const step of current.changes) {
        if (step.kind !== "move_block" && step.kind !== "add_block") continue;
        if (step.startAt < now) calendarError("PLAN_EXPIRED", "A proposed block has already started");
        if (step.kind === "move_block") {
          const block = blockMap.get(step.blockId);
          if (!block || block.locked || block.planId !== plan?._id) changed();
          if (block.startAt < now) calendarError("PLAN_EXPIRED", "A block slated for a move has already started");
        }
      }

      const planRevision = (currentRevision ?? 0) + 1;
      const planFields = { timezone: saved.timezone, updatedAt: now, publishedAt: now, revision: planRevision,
        source: "automation" as const, needsReplan: false };
      let planId: Id<"dayPlans">;
      if (plan) {
        planId = plan._id;
        await db.patch("dayPlans", planId, planFields);
      } else {
        planId = await db.insert("dayPlans", { ...planFields, workspaceId, localDate: saved.localDate, focusTaskIds: [],
          publicId: crypto.randomUUID(), createdAt: now });
      }

      for (const step of current.changes) {
        switch (step.kind) {
          case "add_block": {
            const { startAt, endAt, localDate, taskId } = step;
            await db.insert("timeBlocks", { workspaceId, taskId, startAt, endAt, ...overlapFields(step), localDate, planId, timezone: saved.timezone,
              publicId: crypto.randomUUID(), createdAt: now, updatedAt: now, revision: 1, locked: false, origin: "automation" });
            break;
          }
          case "move_block": {
            const { startAt, endAt, localDate, blockId } = step;
            const block = blockMap.get(blockId);
            if (!block) changed();
            await db.patch("timeBlocks", blockId, { startAt, endAt, ...overlapFields(step), localDate, timezone: saved.timezone,
              revision: block.revision + 1, updatedAt: now });
            break;
          }
          case "set_focus":
            await db.patch("dayPlans", planId, { focusTaskIds: step.taskIds });
            break;
          default:
            throw new Error("Unexpected deterministic plan change");
        }
      }

      const revision = saved.revision + 1;
      await db.patch("planRevisions", saved._id, { planId, revision, updatedAt: now, state: "applied", appliedAt: now,
        appliedDayPlanRevision: planRevision });
      return { target: { kind: "plan_revision", id: saved._id }, targetPublicId: publicId,
        revision, beforeRevision: saved.revision };
    });
  },
});
