import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { overlapFields } from "./calendarOverlap";
import { calendarError, minuteMs } from "./calendarTime";
import { taskByPublicId } from "./reads";
import { buildSchedule, dayPlanRow, planningContext } from "./scheduling";

type Revision = Doc<"planRevisions">;
type Context = Awaited<ReturnType<typeof planningContext>>;
type Task = Doc<"tasks">;
const previewLifetime = 10 * minuteMs;

export function revisionByPublicId(db: DatabaseReader, workspaceId: Id<"workspaces">, publicId: string) {
  return db.query("planRevisions").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
}

export function validatePlanSelection(taskPublicIds: string[], expectedDayPlanRevision: number | null, allowEmpty = false) {
  if (expectedDayPlanRevision !== null &&
      (!Number.isSafeInteger(expectedDayPlanRevision) || expectedDayPlanRevision < 1)) {
    calendarError("INVALID_ARGUMENT", "Invalid expected revision");
  }
  if ((!allowEmpty && taskPublicIds.length === 0) || taskPublicIds.length > 40 ||
      taskPublicIds.some(id => !id.trim() || id.length > 200) || new Set(taskPublicIds).size !== taskPublicIds.length) {
    calendarError("INVALID_ARGUMENT", "Select 1–40 distinct tasks by public ID");
  }
}

function proposedSchedule(context: Context, now: number): ReturnType<typeof buildSchedule> {
  if (!context.tasks.length) return { changes: [], summary: { placements: [], unscheduled: [] } };
  return buildSchedule(context, now);
}

export async function savePreview(db: DatabaseWriter, { workspaceId, userId, now, localDate, taskPublicIds,
  expectedDayPlanRevision, actor, reason, authorizeSelection, agentSummary }: {
  workspaceId: Id<"workspaces">;
  userId: Id<"users">;
  now: number;
  localDate: string;
  taskPublicIds: string[];
  expectedDayPlanRevision: number | null;
  actor: Revision["actor"];
  reason?: string;
  authorizeSelection?: (tasks: Task[]) => Promise<void>;
  agentSummary?: (context: Context, schedule: ReturnType<typeof buildSchedule>) => Revision["agentSummary"];
}) {
  const [plan, selected] = await Promise.all([
    dayPlanRow(db, workspaceId, localDate), Promise.all(taskPublicIds.map(id => taskByPublicId(db, workspaceId, id))),
  ]);
  const revision = plan?.revision ?? null;
  if (expectedDayPlanRevision !== revision) throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision: revision });
  const tasks = selected.map(task => task ?? calendarError("TASK_UNAVAILABLE"));
  await authorizeSelection?.(tasks);
  const context = await planningContext(db, workspaceId, userId, localDate, tasks, plan, tasks.length > 0);
  if (context.day.endAt <= now || context.day.endAt <= context.day.startAt) {
    calendarError("INVALID_ARGUMENT", "Plans require a current or future local day");
  }
  const schedule = proposedSchedule(context, now);
  const { changes, summary } = schedule;
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
    dependencies: context.dependencies, changes, previewSummary: summary, undoEligible: false,
    reason, agentSummary: agentSummary?.(context, schedule) });
  return { target: { kind: "plan_revision" as const, id }, targetPublicId: publicId, revision: 1 };
}

// Storage serialization can change object field order. Compare the proposed
// changes by value before writing anything from a persisted preview.
function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

export async function applyPreview(db: DatabaseWriter, saved: Revision, userId: Id<"users">, now: number,
  source: "automation" | "agent", authorizeSelection?: (tasks: Task[]) => Promise<void>,
  applyAdditional?: () => Promise<void>) {
  const { workspaceId, publicId } = saved;
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
  const context = await planningContext(db, workspaceId, userId, saved.localDate, tasks, plan, tasks.length > 0);
  if (context.contextFingerprint !== saved.contextFingerprint || context.clock.timezone !== saved.timezone) changed();
  await authorizeSelection?.(tasks);
  const current = proposedSchedule(context, saved.createdAt);
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

  if (current.changes.length) await writeSchedule(db, saved, context, current, now, source);
  await applyAdditional?.();
  const appliedPlan = await dayPlanRow(db, workspaceId, saved.localDate);
  const revision = saved.revision + 1;
  await db.patch("planRevisions", saved._id, { planId: appliedPlan?._id, revision, updatedAt: now, state: "applied",
    appliedAt: now, appliedDayPlanRevision: appliedPlan?.revision });
  return { target: { kind: "plan_revision" as const, id: saved._id }, targetPublicId: publicId,
    revision, beforeRevision: saved.revision };
}

async function writeSchedule(db: DatabaseWriter, saved: Revision, context: Context, schedule: ReturnType<typeof proposedSchedule>,
  now: number, source: "automation" | "agent") {
  const { workspaceId } = saved;
  const { plan } = context;
  const planRevision = (plan?.revision ?? 0) + 1;
  const placedTasks = new Set(schedule.summary.placements.map(placement => placement.taskPublicId));
  const staleTaskPublicIds = plan?.staleTaskPublicIds?.filter(id => !placedTasks.has(id));
  const planFields = { timezone: saved.timezone, updatedAt: now, publishedAt: now, revision: planRevision,
    source, staleTaskPublicIds: staleTaskPublicIds?.length ? staleTaskPublicIds : undefined };
  let planId: Id<"dayPlans">;
  if (plan) {
    planId = plan._id;
    await db.patch("dayPlans", planId, planFields);
  } else {
    planId = await db.insert("dayPlans", { ...planFields, workspaceId, localDate: saved.localDate, focusTaskIds: [],
      publicId: crypto.randomUUID(), createdAt: now });
  }

  const blockMap = new Map(context.blocks.map(block => [block._id, block]));
  for (const step of schedule.changes) {
    switch (step.kind) {
      case "add_block": {
        const { startAt, endAt, localDate, taskId } = step;
        await db.insert("timeBlocks", { workspaceId, taskId, startAt, endAt, ...overlapFields(step), localDate, planId, timezone: saved.timezone,
          publicId: crypto.randomUUID(), createdAt: now, updatedAt: now, revision: 1, locked: false, origin: source });
        break;
      }
      case "move_block": {
        const { startAt, endAt, localDate, blockId } = step;
        const block = blockMap.get(blockId);
        if (!block) throw new Error("A scheduled move has no source block");
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
}
