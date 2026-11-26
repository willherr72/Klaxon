import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { enforceAutonomy } from "./autonomy";

type Task = Doc<"tasks">;
type Deadline = Task["deadline"];

function sameDeadline(before: Deadline, after: Deadline) {
  if (!before || !after) return before === after;
  if (before.kind === "date") return after.kind === "date" && before.date === after.date;
  return after.kind === "instant" && before.at === after.at && before.timezone === after.timezone;
}

export async function checkAgentTaskChange(db: DatabaseReader, before: Task | null, after: Task, now: number,
  forceOrganizationCheck = false) {
  const { workspaceId } = after;
  const targets = before && before.projectId !== after.projectId ? [before, after] : [after];
  // Shared domain validation has already produced the actual resulting task.
  // These checks run before the transaction commits, including for undo.
  const previousTags = before?.tags ?? [];
  const nextTags = after.tags ?? [];
  const organizesWork = forceOrganizationCheck ||
    (before?.status ?? "inbox") !== after.status || (before?.priority ?? "none") !== after.priority ||
    (before?.rank ?? 0) !== after.rank || before?.projectId !== after.projectId || before?.laneId !== after.laneId ||
    before?.plannedDate !== after.plannedDate || before?.followUpDate !== after.followUpDate ||
    before?.estimateMinutes !== after.estimateMinutes || !sameDeadline(before?.deadline, after.deadline) ||
    previousTags.length !== nextTags.length || previousTags.some((tag, index) => tag !== nextTags[index]);
  await enforceAutonomy(db, workspaceId, targets, now, organizesWork ? "apply" : "preview");
  if (before && before.plannedDate !== after.plannedDate) throw new ConvexError("TASK_PLAN_REQUIRED");
  if (before?.deadline && !sameDeadline(before.deadline, after.deadline)) throw new ConvexError("TASK_DEADLINE_PROTECTED");
}
