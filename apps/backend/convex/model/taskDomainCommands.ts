import { v, type GenericValidator, type Infer } from "convex/values";
import { deadline, localDate, priority, taskStatus } from "./values";

function clearable<T extends GenericValidator>(validator: T) {
  return v.optional(v.union(validator, v.null()));
}

const publicId = v.string();
const expectedRevision = v.number();
const description = v.string();
const estimateMinutes = v.number();
const projectId = v.id("projects");
const laneId = v.id("lanes");
const tags = v.array(v.string());
const board = v.object({ laneIds: v.array(laneId) });
const taskPlacement = {
  status: v.optional(taskStatus),
  priority: v.optional(priority),
  rank: v.optional(v.number()),
};
const stepFields = {
  rank: v.optional(v.number()),
  completed: v.optional(v.boolean()),
};

export const taskDomainCommand = v.union(
  v.object({
    kind: v.literal("task.create"), publicId, title: v.string(), ...taskPlacement,
    description: v.optional(description),
    projectId: v.optional(projectId),
    laneId: v.optional(laneId),
    plannedDate: v.optional(localDate),
    deadline: v.optional(deadline),
    estimateMinutes: v.optional(estimateMinutes),
    tags: v.optional(tags),
    waitingReason: v.optional(v.string()),
    waitingPerson: v.optional(v.string()),
    followUpDate: v.optional(localDate),
  }),
  v.object({
    kind: v.literal("task.update"), publicId, expectedRevision,
    patch: v.object({
      title: v.optional(v.string()), ...taskPlacement,
      description: clearable(description),
      projectId: clearable(projectId),
      laneId: clearable(laneId),
      plannedDate: clearable(localDate),
      deadline: clearable(deadline),
      estimateMinutes: clearable(estimateMinutes),
      tags: clearable(tags),
      waitingReason: clearable(v.string()),
      waitingPerson: clearable(v.string()),
      followUpDate: clearable(localDate),
    }),
  }),
  v.object({ kind: v.literal("task.archive"), publicId, expectedRevision }),
  v.object({ kind: v.literal("task.reopen"), publicId, expectedRevision }),
  v.object({ kind: v.literal("task.restore"), publicId, expectedRevision }),
  v.object({
    kind: v.literal("project.create"), publicId, name: v.string(),
    area: v.optional(v.string()), rank: v.optional(v.number()), board: v.optional(board),
  }),
  v.object({
    kind: v.literal("project.update"), publicId, expectedRevision,
    patch: v.object({
      name: v.optional(v.string()), area: clearable(v.string()),
      rank: v.optional(v.number()), board: clearable(board),
    }),
  }),
  v.object({ kind: v.literal("project.archive"), publicId, expectedRevision }),
  v.object({ kind: v.literal("project.restore"), publicId, expectedRevision }),
  v.object({
    kind: v.literal("step.create"), publicId, taskId: v.id("tasks"), title: v.string(), ...stepFields,
  }),
  v.object({
    kind: v.literal("step.update"), publicId, expectedRevision,
    patch: v.object({ title: v.optional(v.string()), ...stepFields }),
  }),
  v.object({ kind: v.literal("step.delete"), publicId, expectedRevision }),
);

export type TaskDomainCommand = Infer<typeof taskDomainCommand>;
