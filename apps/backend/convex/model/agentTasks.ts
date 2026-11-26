import { ConvexError, v, type GenericValidator, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { pageArgs, readAgentPage } from "./agentPagination";
import { checkAgentTaskChange } from "./agentTaskPolicy";
import { runOperation, type OperationResult } from "./operations";
import { listTasks, taskByPublicId } from "./reads";
import { applyTaskDomainCommand, checkPublicId, requiredText, type TaskDomainCommand } from "./taskDomain";
import { taskInverse } from "./taskUndo";
import { deadline, localDate, priority, taskStatus, unarchivedTaskStatus } from "./values";

const title = v.string();
const fields = {
  description: v.string(), plannedDate: localDate, deadline, estimateMinutes: v.number(),
  tags: v.array(v.string()), waitingReason: v.string(), waitingPerson: v.string(), followUpDate: localDate,
  projectPublicId: v.string(), lanePublicId: v.string(),
};
function clearable<T extends GenericValidator>(validator: T) {
  return v.optional(v.union(validator, v.null()));
}

export const listAgentTaskArgs = v.object({
  filter: v.union(
    v.object({ kind: v.literal("status"), status: taskStatus }),
    v.object({ kind: v.literal("planned"), from: v.string(), until: v.string() }),
    v.object({ kind: v.literal("deadlineDate"), from: v.string(), until: v.string() }),
    v.object({ kind: v.literal("deadlineInstant"), from: v.number(), until: v.number() }),
    v.object({ kind: v.literal("project"), projectPublicId: v.string() }),
  ),
  ...pageArgs,
});
export const getAgentTaskArgs = v.object({ publicId: v.string() });
const mutationFields = { ...getAgentTaskArgs.fields, operationId: v.string(), reason: v.string() };
export const createAgentTaskArgs = v.object({
  ...mutationFields,
  task: v.object({
    title, status: v.optional(unarchivedTaskStatus), priority: v.optional(priority),
    description: v.optional(fields.description), plannedDate: v.optional(fields.plannedDate),
    deadline: v.optional(fields.deadline), estimateMinutes: v.optional(fields.estimateMinutes),
    tags: v.optional(fields.tags), waitingReason: v.optional(fields.waitingReason),
    waitingPerson: v.optional(fields.waitingPerson), followUpDate: v.optional(fields.followUpDate),
    projectPublicId: v.optional(fields.projectPublicId), lanePublicId: v.optional(fields.lanePublicId),
  }),
});
export const updateAgentTaskArgs = v.object({
  ...mutationFields, expectedRevision: v.number(),
  patch: v.object({
    title: v.optional(title), status: v.optional(unarchivedTaskStatus), priority: v.optional(priority),
    description: clearable(fields.description), plannedDate: clearable(fields.plannedDate),
    deadline: clearable(fields.deadline), estimateMinutes: clearable(fields.estimateMinutes),
    tags: clearable(fields.tags), waitingReason: clearable(fields.waitingReason),
    waitingPerson: clearable(fields.waitingPerson), followUpDate: clearable(fields.followUpDate),
    projectPublicId: clearable(fields.projectPublicId), lanePublicId: clearable(fields.lanePublicId),
  }),
});

type Reader = QueryCtx["db"];
type Writer = MutationCtx["db"];
type WorkspaceId = Id<"workspaces">;
type Grant = {
  workspace: Pick<Doc<"workspaces">, "_id" | "publicId">;
  actor: Extract<Doc<"activityEvents">["actor"], { kind: "agent" }>;
};

function invalid(field: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", field });
}

function notFound(): never {
  throw new ConvexError({ code: "NOT_FOUND" });
}

async function projectId(db: Reader, workspaceId: WorkspaceId, publicId: string) {
  checkPublicId(publicId);
  const row = await db.query("projects").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
  return row?._id ?? notFound();
}

async function laneId(db: Reader, workspaceId: WorkspaceId, publicId: string) {
  checkPublicId(publicId);
  const row = await db.query("lanes").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
  return row?._id ?? notFound();
}

export async function portableTask(db: Reader, task: Doc<"tasks">) {
  const [project, lane] = await Promise.all([
    task.projectId ? db.get("projects", task.projectId) : null,
    task.laneId ? db.get("lanes", task.laneId) : null,
  ]);
  const { publicId, title, description, status, priority, rank, plannedDate, deadline, estimateMinutes,
    tags, waitingReason, waitingPerson, followUpDate, completedAt, archivedAt, createdAt, updatedAt, revision } = task;
  return { publicId, title, description, status, priority, rank, plannedDate, deadline, estimateMinutes,
    tags, waitingReason, waitingPerson, followUpDate, completedAt, archivedAt, createdAt, updatedAt, revision,
    projectPublicId: project?.workspaceId === task.workspaceId ? project.publicId : undefined,
    lanePublicId: lane?.workspaceId === task.workspaceId ? lane.publicId : undefined };
}

export async function getAgentTask(db: Reader, workspaceId: WorkspaceId, { publicId }: Infer<typeof getAgentTaskArgs>) {
  checkPublicId(publicId);
  const task = await taskByPublicId(db, workspaceId, publicId);
  if (!task) notFound();
  return portableTask(db, task);
}

export async function listAgentTasks(db: Reader, workspaceId: WorkspaceId,
  { filter, limit, cursor }: Infer<typeof listAgentTaskArgs>) {
  const resolved = filter.kind === "project"
    ? { kind: "project" as const, projectId: await projectId(db, workspaceId, filter.projectPublicId) }
    : filter;
  try {
    const result = await readAgentPage(options => listTasks(db, workspaceId, resolved, options), { limit, cursor });
    return { items: await Promise.all(result.page.map(task => portableTask(db, task))),
      nextCursor: result.isDone ? null : result.continueCursor };
  } catch (error) {
    if (error instanceof RangeError) invalid("filter");
    throw error;
  }
}

export function checkedReason(reason: string) {
  if (/[\x00-\x1f\x7f]/u.test(reason)) invalid("reason");
  return requiredText(reason, "reason", 512);
}

export async function portableReceipt(db: Reader, result: OperationResult) {
  const event = await db.get("activityEvents", result.activityEventId);
  if (!event) throw new Error("Operation activity is missing");
  return { workspacePublicId: result.workspacePublicId, publicId: result.targetPublicId,
    revision: result.revision, activityEventPublicId: event.publicId };
}

export async function createAgentTask(db: Writer, { workspace, actor }: Grant,
  { operationId, publicId, reason, task }: Infer<typeof createAgentTaskArgs>, origin: "api" | "mcp" = "api") {
  const agentReason = checkedReason(reason);
  const result = await runOperation(db, {
    workspace, actor, origin, action: "task.create", operationId, targetPublicId: publicId,
    input: { reason: agentReason, task },
  }, async ({ db, now }) => {
    checkPublicId(publicId);
    const { projectPublicId, lanePublicId, ...fields } = task;
    const command: TaskDomainCommand = { kind: "task.create", publicId, ...fields,
      projectId: projectPublicId === undefined ? undefined : await projectId(db, workspace._id, projectPublicId),
      laneId: lanePublicId === undefined ? undefined : await laneId(db, workspace._id, lanePublicId) };
    const change = await applyTaskDomainCommand(db, workspace._id, command);
    if (change.target.kind !== "task") throw new Error("Task creation did not return a task");
    const after = await db.get("tasks", change.target.id);
    if (!after) throw new Error("Created task is unavailable");
    await checkAgentTaskChange(db, null, after, now);
    return { ...change, agentReason };
  });
  return portableReceipt(db, result);
}

export async function updateAgentTask(db: Writer, { workspace, actor }: Grant,
  { operationId, publicId, reason, expectedRevision, patch }: Infer<typeof updateAgentTaskArgs>, origin: "api" | "mcp" = "api") {
  const agentReason = checkedReason(reason);
  if (!Object.values(patch).some(value => value !== undefined)) invalid("patch");
  const result = await runOperation(db, {
    workspace, actor, origin, action: "task.update", operationId, targetPublicId: publicId, expectedRevision,
    input: { reason: agentReason, patch },
  }, async ({ db, now }) => {
    checkPublicId(publicId);
    const before = await taskByPublicId(db, workspace._id, publicId);
    if (!before) notFound();
    const { projectPublicId, lanePublicId, ...fields } = patch;
    const command: TaskDomainCommand = { kind: "task.update", publicId, expectedRevision, patch: { ...fields } };
    if (projectPublicId !== undefined) {
      command.patch.projectId = projectPublicId === null ? null : await projectId(db, workspace._id, projectPublicId);
    }
    if (lanePublicId !== undefined) {
      command.patch.laneId = lanePublicId === null ? null : await laneId(db, workspace._id, lanePublicId);
    }
    const change = await applyTaskDomainCommand(db, workspace._id, command);
    const after = await db.get("tasks", before._id);
    if (!after) throw new Error("Updated task is unavailable");
    await checkAgentTaskChange(db, before, after, now);
    return { ...change, beforeRevision: expectedRevision, inverse: taskInverse(before, command, change.revision), agentReason };
  });
  return portableReceipt(db, result);
}
