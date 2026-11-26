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
