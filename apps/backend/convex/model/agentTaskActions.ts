import { v } from "convex/values";
import type { AgentEndpoint } from "./agentEndpoints";
import { pageArgs } from "./agentPagination";

export const stepList = v.object({ taskPublicId: v.string(), ...pageArgs });
export const searchArgs = v.object({ text: v.string(), field: v.optional(v.union(v.literal("title"), v.literal("description"))), ...pageArgs });
const write = { publicId: v.string(), operationId: v.string(), reason: v.string() };
const edit = { ...write, expectedRevision: v.number() };
const addStep = v.object({ ...write, taskPublicId: v.string(), title: v.string() });
const changeStep = v.object({ ...edit, taskPublicId: v.string(), title: v.string() });
const finishStep = v.object({ ...edit, taskPublicId: v.string() });
const placement = { beforePublicId: v.optional(v.string()) };
const moveStep = v.object({ ...finishStep.fields, ...placement });
const moveTask = v.object({ ...edit, lanePublicId: v.union(v.string(), v.null()), ...placement });
const lifecycle = v.object(edit);

export const taskAction = v.union(
  v.object({ kind: v.literal("step.create"), ...addStep.fields }),
  v.object({ kind: v.literal("step.update"), ...changeStep.fields }),
  v.object({ kind: v.literal("step.complete"), ...finishStep.fields }),
  v.object({ kind: v.literal("step.move"), ...moveStep.fields }),
  v.object({ kind: v.literal("task.move"), ...moveTask.fields }),
  v.object({ kind: v.literal("task.complete"), ...edit }),
  v.object({ kind: v.literal("task.reopen"), ...edit }),
);

export const taskActionEndpoints = [
  { name: "list_steps", path: "steps/list", handler: "agentTaskActions:listSteps", kind: "query", scope: "tasks:read",
    schema: stepList, description: "List a task's ordered steps by stable ID and revision." },
  { name: "search_tasks", path: "tasks/search", handler: "agentTaskActions:search", kind: "query", scope: "tasks:read",
    schema: searchArgs, description: "Search workspace tasks by title or description, with cursor pagination." },
  { name: "list_waiting", path: "tasks/waiting", handler: "agentTaskActions:listWaiting", kind: "query", scope: "tasks:read",
    schema: v.object(pageArgs), description: "List waiting tasks and their follow-up dates." },
  { name: "add_step", path: "steps/create", handler: "agentTaskActions:write", command: "step.create", kind: "mutation",
    scope: "tasks:write", schema: addStep, description: "Append one step to a task. Retry with the same operation and step IDs." },
  { name: "update_step", path: "steps/update", handler: "agentTaskActions:write", command: "step.update", kind: "mutation",
    scope: "tasks:write", schema: changeStep, description: "Rename a task step at its expected revision." },
  { name: "complete_step", path: "steps/complete", handler: "agentTaskActions:write", command: "step.complete", kind: "mutation",
    scope: "tasks:write", schema: finishStep, description: "Mark one verified step complete." },
  { name: "move_step", path: "steps/move", handler: "agentTaskActions:write", command: "step.move", kind: "mutation",
    scope: "tasks:write", schema: moveStep, description: "Move a step before another step of the same task, or omit beforePublicId to append." },
  { name: "move_task", path: "tasks/move", handler: "agentTaskActions:write", command: "task.move", kind: "mutation",
    scope: "tasks:write", schema: moveTask, description: "Move a task within its project to the given lane, before a neighbor or at the end." },
  { name: "complete_task", path: "tasks/complete", handler: "agentTaskActions:write", command: "task.complete", kind: "mutation",
    scope: "tasks:write", schema: lifecycle, description: "Complete a task with a task-specific reason and its current revision." },
  { name: "reopen_task", path: "tasks/reopen", handler: "agentTaskActions:write", command: "task.reopen", kind: "mutation",
    scope: "tasks:write", schema: lifecycle, description: "Return a completed task to ready at its expected revision." },
] as const satisfies readonly AgentEndpoint[];
