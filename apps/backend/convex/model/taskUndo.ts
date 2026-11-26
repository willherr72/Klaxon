import type { DatabaseWriter } from "../_generated/server";
import { ConvexError } from "convex/values";
import { applyTaskDomainCommand } from "./taskDomain";
import { requireExpectedRevision } from "./operations";
import type { Doc } from "../_generated/dataModel";
import type { TaskDomainCommand } from "./taskDomainCommands";
import type { OperationChange } from "./operations";

// Store the inverse separately so reading activity never reveals prior private task text.
export function taskInverse(before: Doc<"tasks">, command: TaskDomainCommand, revision: number): OperationChange["inverse"] {
  const target = {publicId:before.publicId,expectedRevision:revision};
  let inverse: TaskDomainCommand;
  switch (command.kind) {
    case "task.archive": inverse = {kind:"task.restore",...target}; break;
    case "task.restore": inverse = {kind:"task.archive",...target}; break;
    case "task.reopen": inverse = {kind:"task.update",patch:{status:"done"},...target}; break;
    case "task.update": {
      const fields = Object.keys(command.patch) as (keyof typeof command.patch)[];
      const patch = Object.fromEntries(fields.map(key => [key, before[key] ?? null]));
      inverse = {kind:"task.update",patch,...target};
      break;
    }
    default: return;
  }
  const {completedAt,archivedAt,archivedFromStatus,rankTieBreak} = before;
  return {command:inverse,completedAt,archivedAt,archivedFromStatus,rankTieBreak};
}

type TaskGuard = (before: Doc<"tasks">, after: Doc<"tasks">, organizesWork?: boolean) => Promise<void>;
type OrderChanges = NonNullable<Doc<"activityEvents">["orderChanges"]>;

async function restoreNeighborRanks(db: DatabaseWriter, event: Doc<"activityEvents">, checkTask?: TaskGuard) {
  const restored: OrderChanges = [];
  for (const edit of event.orderChanges ?? []) {
    const values = { rank:edit.beforeRank, revision:edit.afterRevision+1, updatedAt:Date.now() };
    if (event.target.kind === "task_step") {
      const row = await db.query("taskSteps").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId",event.workspaceId).eq("publicId",edit.publicId)).unique();
      if (!row) throw new ConvexError({code:"NOT_FOUND"});
      requireExpectedRevision(edit.afterRevision,row.revision);
      const parent = await db.get(row.taskId);
      if (!parent || parent.workspaceId !== event.workspaceId) throw new ConvexError({code:"NOT_FOUND"});
      await checkTask?.(parent,parent,true);
      await db.patch(row._id,values);
    } else {
      const row = await db.query("tasks").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId",event.workspaceId).eq("publicId",edit.publicId)).unique();
      if (!row) throw new ConvexError({code:"NOT_FOUND"});
      requireExpectedRevision(edit.afterRevision,row.revision);
      const patch = {...values,rankTieBreak:edit.beforeTieBreak};
      await checkTask?.(row,{...row,...patch},true);
      await db.patch(row._id,patch);
    }
    restored.push({publicId:edit.publicId,beforeRank:edit.afterRank,afterRank:edit.beforeRank,
      beforeTieBreak:edit.afterTieBreak,afterTieBreak:edit.beforeTieBreak,afterRevision:values.revision});
  }
  return restored.length ? restored : undefined;
}

export async function undoTaskEvent(db: DatabaseWriter, event: Doc<"activityEvents">, expectedRevision: number, checkTask?: TaskGuard) {
  const { workspaceId, _id: eventId } = event;
  if (!event.undoEligible || event.afterRevision === undefined) throw new ConvexError({code:"UNDO_UNAVAILABLE"});
  requireExpectedRevision(expectedRevision,event.afterRevision);
  const inverse = await db.query("taskUndoChanges").withIndex("by_workspace_event",q =>
    q.eq("workspaceId",workspaceId).eq("eventId",eventId)).unique();
  if (!inverse || inverse.command.publicId !== event.targetPublicId) throw new ConvexError({code:"UNDO_UNAVAILABLE"});
  if (event.target.kind === "task_step" && inverse.command.kind === "step.update") {
    const step = await db.get(event.target.id);
    if (!step || step.workspaceId !== workspaceId || step.publicId !== inverse.command.publicId) throw new ConvexError({code:"NOT_FOUND"});
    requireExpectedRevision(expectedRevision,step.revision);
    const parent = await db.get(step.taskId);
    if (!parent || parent.workspaceId !== workspaceId) throw new ConvexError({code:"NOT_FOUND"});
    await checkTask?.(parent,parent,true);
    const change = await applyTaskDomainCommand(db,workspaceId,inverse.command);
    const orderChanges = await restoreNeighborRanks(db,event,checkTask);
    await db.delete(inverse._id);
    return {...change,orderChanges};
  }
  if (event.target.kind !== "task") throw new ConvexError({code:"UNDO_UNAVAILABLE"});
  const task = await db.get(event.target.id);
  if (!task || task.workspaceId !== workspaceId || task.publicId !== event.targetPublicId) throw new ConvexError({code:"NOT_FOUND"});
  requireExpectedRevision(expectedRevision,task.revision);
  const change = await applyTaskDomainCommand(db,workspaceId,inverse.command);
  const {completedAt,archivedAt,archivedFromStatus,rankTieBreak} = inverse;
  await db.patch(task._id,{completedAt,archivedAt,archivedFromStatus,rankTieBreak});
  if (checkTask) await checkTask(task,(await db.get(task._id))!,event.action === "task.move");
  const orderChanges = await restoreNeighborRanks(db,event,checkTask);
  await db.delete(inverse._id);
  return {...change,orderChanges};
}
