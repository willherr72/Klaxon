import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { AgentEndpoint } from "./agentEndpoints";
import { agentReason, portableAgentReceipt, requirePlanningOwner, type AgentGrant, type AgentOrigin } from "./agentOperations";
import { enforceAutonomy, ownerAutonomy } from "./autonomy";
import { calendarError, calendarRange, zonedClock } from "./calendarTime";
import { requireExpectedRevision, runOperation } from "./operations";
import { taskByPublicId } from "./reads";
import { dayPlanRow } from "./scheduling";
import { applyTaskDomainCommand, checkPublicId, requiredText } from "./taskDomain";
import { taskInverse } from "./taskUndo";

const operation = { reason: v.string(), operationId: v.string() };
export const publishBriefingArgs = v.object({
  ...operation, localDate: v.string(), briefing: v.string(), expectedDayPlanRevision: v.union(v.number(), v.null()),
});
export const carryForwardArgs = v.object({
  ...operation, publicId: v.string(), fromDate: v.string(), toDate: v.string(), expectedRevision: v.number(),
});

export const agentLifecycleEndpoints = [
  { name: "publish_briefing", path: "planning/briefing", handler: "agentLifecycle:publishBriefing", kind: "mutation",
    schema: publishBriefingArgs, scope: "planning:apply",
    description: "Publish a bounded briefing for one current or future day at the expected day-plan revision. Use null for a new day plan." },
  { name: "carry_forward_task", path: "planning/carry-forward", handler: "agentLifecycle:carryForward", kind: "mutation",
    schema: carryForwardArgs, scope: "planning:apply",
    description: "Carry one unfinished task from its current planned date to a later date. Existing blocks and deadlines stay in place." },
] as const satisfies readonly AgentEndpoint[];

export function checkedBriefing(text: string) {
  const briefing = text.replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/u.test(briefing)) calendarError("INVALID_ARGUMENT", "Invalid briefing text");
  return requiredText(briefing, "briefing", 2000);
}

export async function publishAgentBriefing(db: DatabaseWriter, grant: AgentGrant,
  { localDate, expectedDayPlanRevision, briefing: text, operationId, reason }: Infer<typeof publishBriefingArgs>,
  origin: AgentOrigin) {
  requirePlanningOwner(grant);
  const { workspace, workspaceId, actor } = grant;
  const briefing = checkedBriefing(text);
  const checkedReason = agentReason(reason);
  if (expectedDayPlanRevision !== null && (!Number.isSafeInteger(expectedDayPlanRevision) || expectedDayPlanRevision < 1)) {
    calendarError("INVALID_ARGUMENT", "Invalid expected day plan revision");
  }
  const receipt = await runOperation(db, { workspace, actor, origin, operationId, action: "planning.publishBriefing",
    input: { localDate, expectedDayPlanRevision, briefing, reason: checkedReason },
  }, async ({ db, now }) => {
    const plan = await dayPlanRow(db, workspaceId, localDate);
    const currentRevision = plan?.revision ?? null;
    if (expectedDayPlanRevision !== currentRevision) throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision });
    await enforceAutonomy(db, workspaceId, [], now, "apply");
    const { timezone } = await ownerAutonomy(db, workspaceId);
    validateBriefingDay(plan, localDate, timezone, now);
    const change = await writeBriefing(db, workspaceId, plan, localDate, timezone, briefing, now);
    return { ...change, agentReason: checkedReason };
  });
  return portableAgentReceipt(db, receipt);
}

export async function carryForwardAgentTask(db: DatabaseWriter, grant: AgentGrant,
  { publicId, expectedRevision, fromDate, toDate, operationId, reason }: Infer<typeof carryForwardArgs>, origin: AgentOrigin) {
  requirePlanningOwner(grant);
  checkPublicId(publicId);
  const { workspace, workspaceId, actor } = grant;
  const checkedReason = agentReason(reason);
  const receipt = await runOperation(db, { workspace, actor, origin, operationId, action: "planning.carryForward",
    targetPublicId: publicId, expectedRevision, input: { fromDate, toDate, reason: checkedReason },
  }, async ({ db, now }) => {
    const { timezone } = await ownerAutonomy(db, workspaceId);
    const task = await validateCarryForward(db, workspaceId, { publicId, expectedRevision, fromDate, toDate },
      zonedClock(timezone), now);
    await enforceAutonomy(db, workspaceId, [task], now, "apply");
    const change = await writeCarriedTask(db, task, toDate);
    const plans = await Promise.all([dayPlanRow(db, workspaceId, fromDate), dayPlanRow(db, workspaceId, toDate)]);
    for (const plan of plans) {
      // The task command already invalidates published plans.
      if (plan && plan.publishedAt === undefined) {
        await db.patch("dayPlans", plan._id, { needsReplan: true, updatedAt: now, revision: plan.revision + 1 });
      }
    }
    return { ...change, agentReason: checkedReason };
  });
  return portableAgentReceipt(db, receipt);
}

export function validateBriefingDay(plan: Doc<"dayPlans"> | null, localDate: string, timezone: string, now: number) {
  if (plan?.briefing !== undefined && plan.briefingUpdatedAt === undefined) calendarError("BRIEFING_PROTECTED");
  const day = calendarRange(localDate, 1, zonedClock(plan?.timezone ?? timezone));
  if (day.endAt <= now || day.startAt >= day.endAt) calendarError("INVALID_ARGUMENT", "Briefings require a current or future local date");
}

export async function writeBriefing(db: DatabaseWriter, workspaceId: Id<"workspaces">, plan: Doc<"dayPlans"> | null,
  localDate: string, timezone: string, briefing: string, now: number) {
  const revision = (plan?.revision ?? 0) + 1;
  const values = { briefing, briefingUpdatedAt: now, revision, updatedAt: now };
  const publicId = plan?.publicId ?? crypto.randomUUID();
  if (plan) {
    await db.patch("dayPlans", plan._id, values);
    return { target: { kind: "day_plan" as const, id: plan._id }, targetPublicId: publicId,
      revision, beforeRevision: plan.revision };
  }
  const id = await db.insert("dayPlans", { ...values, workspaceId, publicId, localDate, timezone, source: "agent",
    focusTaskIds: [], createdAt: now });
  return { target: { kind: "day_plan" as const, id }, targetPublicId: publicId, revision };
}

export async function validateCarryForward(db: DatabaseReader, workspaceId: Id<"workspaces">,
  { publicId, expectedRevision, fromDate, toDate }: {
    publicId: string; expectedRevision: number; fromDate: string; toDate: string;
  }, clock: ReturnType<typeof zonedClock>, now: number) {
  const task = await taskByPublicId(db, workspaceId, publicId);
  if (!task) calendarError("TASK_UNAVAILABLE");
  requireExpectedRevision(expectedRevision, task.revision);
  if (task.status === "done" || task.status === "archived") calendarError("INVALID_STATE", "Carry forward unfinished work");
  if (task.plannedDate !== fromDate) calendarError("CARRY_FORWARD_STALE", "The task's planned date changed");
  const sourceDay = calendarRange(fromDate, 1, clock);
  const targetDay = calendarRange(toDate, 1, clock);
  if (sourceDay.startAt >= sourceDay.endAt || targetDay.startAt >= targetDay.endAt ||
      fromDate > clock.date(now) || toDate <= fromDate || targetDay.endAt <= now) {
    calendarError("INVALID_ARGUMENT", "Carry forward work planned for today or earlier to a later current or future day");
  }
  const { deadline } = task;
  if (deadline && (deadline.kind === "date" ? deadline.date < toDate : deadline.at <= Math.max(now, targetDay.startAt))) {
    calendarError("CARRY_FORWARD_DEADLINE", "Choose a day with time before the task deadline");
  }
  const locked = await db.query("timeBlocks").withIndex("by_workspace_task_lock_end", q =>
    q.eq("workspaceId", workspaceId).eq("taskId", task._id).eq("locked", true).gt("endAt", sourceDay.startAt)).first();
  if (locked) calendarError("BLOCK_LOCKED", "The task has a locked calendar block on or after its source day");
  return task;
}

export async function writeCarriedTask(db: DatabaseWriter, task: Doc<"tasks">, toDate: string) {
  const command = { kind: "task.update" as const, publicId: task.publicId, expectedRevision: task.revision,
    patch: { plannedDate: toDate } };
  const change = await applyTaskDomainCommand(db, task.workspaceId, command);
  return { ...change, beforeRevision: task.revision, inverse: taskInverse(task, command, change.revision) };
}
