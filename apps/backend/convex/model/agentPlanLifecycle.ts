import { ConvexError, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { validateBriefingDay, validateCarryForward, writeBriefing, writeCarriedTask } from "./agentLifecycle";
import { calendarError, zonedClock } from "./calendarTime";
import type { carryForwardIntent } from "./planIntentValues";
import { dayPlanRow } from "./scheduling";
import { checkPublicId } from "./taskDomain";

type Intent = Infer<typeof carryForwardIntent>;
type DayPlan = Doc<"dayPlans">;
type Task = Doc<"tasks">;

export function validateCarryIntents(intents: Intent[], taskPublicIds: string[], localDate: string) {
  if (intents.length > 20 || new Set(intents.map(intent => intent.taskPublicId)).size !== intents.length) {
    calendarError("INVALID_ARGUMENT", "Choose at most 20 distinct tasks for carry-forward");
  }
  const scheduled = new Set(taskPublicIds);
  for (const intent of intents) {
    checkPublicId(intent.taskPublicId);
    if (!Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 1 ||
        [intent.expectedSourceDayPlanRevision, intent.expectedTargetDayPlanRevision]
          .some(revision => revision !== null && (!Number.isSafeInteger(revision) || revision < 1))) {
      calendarError("INVALID_ARGUMENT", "Expected revisions must be positive safe integers");
    }
    if (scheduled.has(intent.taskPublicId) && intent.toDate !== localDate) {
      calendarError("INVALID_ARGUMENT", "Schedule a carried task on its destination day");
    }
  }
}

function requireDayRevision(expected: number | null, plan: DayPlan | null | undefined, localDate: string) {
  const currentRevision = plan?.revision ?? null;
  if (expected !== currentRevision) throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision, localDate });
}

export async function prepareLifecycle(db: DatabaseReader, workspaceId: Id<"workspaces">, localDate: string,
  timezone: string, briefing: string | undefined, intents: Intent[], now: number) {
  const days = new Set(intents.flatMap(intent => [intent.fromDate, intent.toDate]));
  if (briefing !== undefined) days.add(localDate);
  const plans = new Map(await Promise.all([...days].map(async date => [date, await dayPlanRow(db, workspaceId, date)] as const)));
  const anchor = plans.get(localDate);
  if (briefing !== undefined) validateBriefingDay(anchor ?? null, localDate, timezone, now);
  const clock = zonedClock(timezone);
  const carries = [];
  for (const intent of intents) {
    const { fromDate, toDate, taskPublicId } = intent;
    requireDayRevision(intent.expectedSourceDayPlanRevision, plans.get(fromDate), fromDate);
    requireDayRevision(intent.expectedTargetDayPlanRevision, plans.get(toDate), toDate);
    const task = await validateCarryForward(db, workspaceId, { ...intent, publicId: taskPublicId }, clock, now);
    carries.push({ task, intent });
  }
  return { briefing, previousBriefing: briefing === undefined ? undefined : anchor?.briefing, carries };
}

type PreparedLifecycle = Awaited<ReturnType<typeof prepareLifecycle>>;

export async function writeLifecycle(db: DatabaseWriter, workspaceId: Id<"workspaces">, localDate: string, timezone: string,
  prepared: PreparedLifecycle, scheduled: ReadonlySet<string>, now: number) {
  const { briefing, carries } = prepared;
  const staleDates = new Set<string>();
  for (const { task, intent } of carries) {
    await writeCarriedTask(db, task, intent.toDate);
    staleDates.add(intent.fromDate);
    if (intent.toDate !== localDate || !scheduled.has(task.publicId)) staleDates.add(intent.toDate);
  }

  const touchedDates = new Set(staleDates);
  if (briefing !== undefined) touchedDates.add(localDate);
  for (const date of touchedDates) {
    const plan = await dayPlanRow(db, workspaceId, date);
    const text = date === localDate ? briefing : undefined;
    const stale = staleDates.has(date);
    if (!plan) {
      if (text === undefined) continue;
      const written = await writeBriefing(db, workspaceId, null, localDate, timezone, text, now);
      if (stale) await db.patch("dayPlans", written.target.id, { needsReplan: true });
      continue;
    }
    const markStale = stale && plan.publishedAt === undefined;
    if (text === undefined && !markStale) continue;
    const scheduleAlreadyRevised = date === localDate && scheduled.size > 0;
    await db.patch("dayPlans", plan._id, {
      revision: plan.revision + (scheduleAlreadyRevised ? 0 : 1),
      updatedAt: now,
      ...(text === undefined ? {} : { briefing: text, briefingUpdatedAt: now }),
      ...(markStale ? { needsReplan: true } : {}),
    });
  }
}

export function scopeTasks(scheduled: Task[], lifecycle: PreparedLifecycle | undefined) {
  const all = new Map(scheduled.map(task => [task._id, task]));
  for (const { task } of lifecycle?.carries ?? []) all.set(task._id, task);
  return [...all.values()];
}
