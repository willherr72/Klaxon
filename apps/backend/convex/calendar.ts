import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type DatabaseReader } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { blocksInRange, blockTask, compareIds, eventsInRange, isBusy, preferenceRow, visibleEvent, visiblePreferences } from "./model/calendarStore";
import { overlapFields } from "./model/calendarOverlap";
import { calendarError, calendarRange, validateInterval, zonedClock, type Interval } from "./model/calendarTime";
import { requireExpectedRevision, runOperation } from "./model/operations";
import { taskByPublicId } from "./model/reads";
import { staleTaskFields } from "./model/scheduling";

const workspace = { workspaceId: v.id("workspaces") };
const timestamps = { startAt: v.number(), endAt: v.number() };
const blockKey = { publicId: v.string(), expectedRevision: v.number() };
const resizeOptions = { timezone: v.optional(v.string()), lock: v.optional(v.boolean()) };
const blockCommand = v.union(
  v.object({ kind: v.literal("block.create"), publicId: v.string(), ...timestamps, timezone: v.optional(v.string()),
    taskPublicId: v.optional(v.string()), title: v.optional(v.string()), locked: v.optional(v.boolean()) }),
  v.object({ kind: v.literal("block.update"), ...blockKey, title: v.union(v.string(), v.null()) }),
  v.object({ kind: v.literal("block.move"), ...blockKey, startAt: v.number(), ...resizeOptions }),
  v.object({ kind: v.literal("block.resize"), ...blockKey, ...timestamps, ...resizeOptions }),
  v.object({ kind: v.literal("block.lock"), ...blockKey }),
  v.object({ kind: v.literal("block.unlock"), ...blockKey }),
  v.object({ kind: v.literal("block.remove"), ...blockKey }),
);

export const list = query({
  args: { ...workspace, localDate: v.string(), view: v.union(v.literal("day"), v.literal("week")), timezone: v.optional(v.string()) },
  handler: async (ctx, { workspaceId, localDate, view, timezone }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    const clock = zonedClock(timezone ?? visiblePreferences(await preferenceRow(ctx.db, workspaceId, userId)).timezone);
    const range = calendarRange(localDate, view === "day" ? 1 : 7, clock);
    const [blocks, events] = await Promise.all([
      blocksInRange(ctx.db, workspaceId, range), eventsInRange(ctx.db, workspaceId, userId, range),
    ]);
    const taskIds = [...new Set(blocks.flatMap(block => blockTask(block) ?? []))];
    const taskById = new Map((await Promise.all(taskIds.map(id => ctx.db.get("tasks", id))))
      .flatMap(task => task?.workspaceId === workspaceId ? [[task._id, task] as const] : []));
    return { localDate, timezone: clock.timezone, ...range,
      blocks: blocks.map(block => {
        const { publicId, revision, startAt, endAt, localDate, timezone, title, origin, locked } = block;
        const taskId = blockTask(block);
        const task = taskId ? taskById.get(taskId) : undefined;
        return { publicId, revision, startAt, endAt, localDate, timezone, title, origin, locked,
          taskId: task?._id, taskPublicId: task?.publicId, taskTitle: task?.title, taskStatus: task?.status };
      }),
      events: events.map(visibleEvent),
    };
  },
});

async function placementConflicts(db: DatabaseReader, workspaceId: Id<"workspaces">, userId: Id<"users">,
  interval: Interval, publicId?: string) {
  const [blocks, events] = await Promise.all([
    blocksInRange(db, workspaceId, interval), eventsInRange(db, workspaceId, userId, interval),
  ]);
  return [
    ...blocks.filter(block => block.publicId !== publicId).map(({ publicId, startAt, endAt, locked, title }) =>
      ({ kind: "block" as const, publicId, startAt, endAt, locked, title })),
    ...events.filter(({ event }) => isBusy(event)).map(row => {
      const { publicId, startAt, endAt, title } = visibleEvent(row);
      return { kind: "event" as const, publicId, startAt, endAt, title };
    }),
  ].sort((a, b) => a.startAt - b.startAt || compareIds(a.publicId, b.publicId));
}

export const checkPlacement = query({
  args: { ...workspace, ...timestamps, publicId: v.optional(v.string()) },
  handler: async (ctx, { workspaceId, startAt, endAt, publicId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    return { conflicts: await placementConflicts(ctx.db, workspaceId, userId, validateInterval(startAt, endAt), publicId) };
  },
});

function titleValue(raw: string | null | undefined) {
  if (raw == null) return undefined;
  const value = raw.trim();
  if (!value || value.length > 300) calendarError("INVALID_ARGUMENT", "Block titles require 1–300 characters");
  return value;
}

function isHistorical(task: Doc<"tasks"> | null) {
  return task?.status === "done" || task?.status === "archived";
}

export const apply = mutation({
  args: { ...workspace, operationId: v.string(), command: blockCommand },
  handler: async (ctx, { workspaceId, operationId, command }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    const { publicId, kind } = command;
    const expectedRevision = command.kind === "block.create" ? undefined : command.expectedRevision;
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: kind,
      operationId, targetPublicId: publicId, expectedRevision, input: command,
    }, async ({ db, now }) => {
      if (!publicId.trim() || publicId.length > 200) calendarError("INVALID_ARGUMENT", "Invalid block public ID");
      const block = await db.query("timeBlocks").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();

      async function requireFree(range: Interval, ignore?: string) {
        const conflicts = await placementConflicts(db, workspaceId, userId, range, ignore);
        if (conflicts.length) throw new ConvexError({ code: "CALENDAR_CONFLICT", conflicts: conflicts.slice(0, 20) });
      }

      if (command.kind === "block.create") {
        const prior = await db.query("activityEvents").withIndex("by_workspace_target", q =>
          q.eq("workspaceId", workspaceId).eq("target.kind", "time_block").eq("targetPublicId", publicId)).first();
        if (block || prior) calendarError("ALREADY_EXISTS", "This block ID has already been used");
        const task = command.taskPublicId === undefined ? null : await taskByPublicId(db, workspaceId, command.taskPublicId);
        if (command.taskPublicId !== undefined && !task) calendarError("TASK_UNAVAILABLE");
        if (isHistorical(task)) calendarError("TASK_CLOSED");
        const title = titleValue(command.title);
        if (!task && !title) calendarError("INVALID_ARGUMENT", "A standalone block needs a title");
        const range = validateInterval(command.startAt, command.endAt);
        const clock = zonedClock(command.timezone ?? visiblePreferences(await preferenceRow(db, workspaceId, userId)).timezone);
        await requireFree(range);
        const fields = { workspaceId, publicId, revision: 1, createdAt: now, updatedAt: now, ...range, ...overlapFields(range),
          localDate: clock.date(range.startAt), timezone: clock.timezone, locked: command.locked ?? false, origin: "manual" as const };
        const id = await db.insert("timeBlocks", task ? { ...fields, taskId: task._id, title } : { ...fields, title: title! });
        return { target: { kind: "time_block", id }, targetPublicId: publicId, revision: 1 };
      }

      if (!block) calendarError("BLOCK_UNAVAILABLE");
      requireExpectedRevision(command.expectedRevision, block.revision);
      if (block.locked && command.kind !== "block.unlock" && command.kind !== "block.lock") calendarError("BLOCK_LOCKED");
      const taskId = blockTask(block);
      const task = taskId ? await db.get("tasks", taskId) : null;
      if (taskId && isHistorical(task)) calendarError("TASK_CLOSED");
      const revision = block.revision + 1;
      const changes = { revision, updatedAt: now };
      switch (command.kind) {
        case "block.update": {
          const title = titleValue(command.title);
          if (!taskId && !title) calendarError("INVALID_ARGUMENT", "A standalone block needs a title");
          await db.patch("timeBlocks", block._id, { ...changes, title });
          break;
        }
        case "block.move":
        case "block.resize": {
          const endAt = command.kind === "block.move" ? command.startAt + (block.endAt - block.startAt) : command.endAt;
          const range = validateInterval(command.startAt, endAt);
          const clock = zonedClock(command.timezone ?? block.timezone);
          const settings = visiblePreferences(await preferenceRow(db, workspaceId, userId));
          const localDate = clock.date(range.startAt);
          await requireFree(range, publicId);
          await db.patch("timeBlocks", block._id, { ...changes, ...range, ...overlapFields(range), localDate, timezone: clock.timezone,
            planId: localDate === block.localDate && clock.timezone === block.timezone ? block.planId : undefined,
            locked: command.lock ?? settings.lockManuallyMovedBlocks });
          break;
        }
        case "block.lock":
        case "block.unlock":
          await db.patch("timeBlocks", block._id, { ...changes, locked: command.kind === "block.lock" });
          break;
        case "block.remove":
          await db.delete("timeBlocks", block._id);
          break;
      }
      if (block.planId) {
        const plan = await db.get("dayPlans", block.planId);
        if (plan?.workspaceId === workspaceId) {
          await db.patch("dayPlans", plan._id, { revision: plan.revision + 1, updatedAt: now,
            ...staleTaskFields(plan, task?.workspaceId === workspaceId ? task.publicId : undefined) });
        }
      }
      return { target: { kind: "time_block", id: block._id }, targetPublicId: publicId, revision, beforeRevision: block.revision };
    });
  },
});

// Run repeatedly after adding the indexes until updated is zero. Each batch
// only reads rows still missing the pivot, and patches the current endpoints
// in the same transaction so it can run alongside normal writes.
export const backfillOverlapIndex = internalMutation({
  args: {},
  handler: async ({ db }) => {
    let updated = 0;
    for (const table of ["timeBlocks", "calendarEvents"] as const) {
      const rows = await db.query(table).withIndex("by_overlap_pivot", q => q.eq("overlapPivot", undefined)).take(128);
      for (const row of rows) await db.patch(table, row._id, overlapFields(row));
      updated += rows.length;
    }
    return { updated };
  },
});
