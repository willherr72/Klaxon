import { v, ConvexError } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { checkedReason, listAgentTasks, portableReceipt, portableTask } from "./model/agentTasks";
import { searchArgs, stepList, taskAction } from "./model/agentTaskActions";
import { pageArgs, readAgentPage } from "./model/agentPagination";
import { taskPosition, stepPosition } from "./model/agentOrdering";
import { checkAgentTaskChange } from "./model/agentTaskPolicy";
import { enforceAutonomy } from "./model/autonomy";

import { taskByPublicId } from "./model/reads";
import { applyTaskDomainCommand, checkPublicId, requiredText, type TaskDomainCommand } from "./model/taskDomain";
import { taskInverse } from "./model/taskUndo";
import { runOperation, type OperationChange } from "./model/operations";

const authFields = { ...agentAuthArgs, workspacePublicId: v.string() };

export const listSteps = internalQuery({
  args: { ...authFields, ...stepList.fields },
  handler: async ({db}, { taskPublicId, limit, cursor, ...auth }) => {
    const { workspaceId } = await authorizeAgent(db, auth, "tasks:read");
    checkPublicId(taskPublicId);
    const parent = await taskByPublicId(db, workspaceId, taskPublicId);
    if (!parent) throw new ConvexError("NOT_FOUND");
    const steps = db.query("taskSteps").withIndex("by_workspace_task_rank", q =>
      q.eq("workspaceId", workspaceId).eq("taskId", parent._id));
    const result = await readAgentPage(options => steps.paginate(options), { limit, cursor });
    return { items: result.page.map(({ publicId, title, completed, completedAt, revision, rank }) =>
      ({ taskPublicId, publicId, title, completed, completedAt, rank, revision })), nextCursor: result.isDone ? null : result.continueCursor };
  },
});

export const listWaiting = internalQuery({
  args: { ...authFields, ...pageArgs },
  handler: async ({db}, { cursor, limit, ...auth }) => {
    const { workspaceId } = await authorizeAgent(db, auth, "tasks:read");
    return listAgentTasks(db, workspaceId, { filter: { kind: "status", status: "waiting" }, cursor, limit });
  },
});

export const search = internalQuery({
  args: { ...authFields, ...searchArgs.fields },
  handler: async ({db}, { text, field = "title", cursor, limit, ...auth }) => {
    const { workspaceId } = await authorizeAgent(db, auth, "tasks:read");
    const term = requiredText(text, "text", 256);
    const tasks = db.query("tasks");
    const hits = field === "description"
      ? tasks.withSearchIndex("search_description", q => q.search("description", term).eq("workspaceId", workspaceId))
      : tasks.withSearchIndex("search_title", q => q.search("title", term).eq("workspaceId", workspaceId));
    const result = await readAgentPage(options => hits.paginate(options), { limit, cursor });
    return { items: await Promise.all(result.page.map(task => portableTask(db, task))),
      nextCursor: result.isDone ? null : result.continueCursor };
  },
});

export const write = internalMutation({
  args: { ...authFields, command: taskAction, origin: v.optional(v.literal("mcp")) },
  handler: async ({db}, { command, origin, ...auth }) => {
    const { workspace, actor } = await authorizeAgent(db, auth, "tasks:write");
    const { operationId, publicId } = command;
    const agentReason = checkedReason(command.reason);
    const expectedRevision = "expectedRevision" in command ? command.expectedRevision : undefined;
    const result = await runOperation(db, { workspace, actor, origin: origin ?? "api", targetPublicId: publicId, expectedRevision,
      operationId, action: command.kind, input: { ...command, reason: agentReason } }, async ({now}) => {
      const taskPublicId = "taskPublicId" in command ? command.taskPublicId : publicId;
      checkPublicId(taskPublicId);
      const task = await taskByPublicId(db, workspace._id, taskPublicId);
      if (!task) throw new ConvexError("NOT_FOUND");
      await enforceAutonomy(db, workspace._id, [task], now,
        command.kind === "task.move" || command.kind === "step.move" ? "apply" : "preview");
      let change: TaskDomainCommand;
      let orderChanges: OperationChange["orderChanges"];
      let stepInverse: OperationChange["inverse"];
      switch (command.kind) {
        case "task.move": {
          const lane = command.lanePublicId === null ? null : await db.query("lanes").withIndex("by_workspace_public_id", q =>
            q.eq("workspaceId",workspace._id).eq("publicId",command.lanePublicId!)).unique();
          if (command.lanePublicId !== null && (!lane || lane.archivedAt !== undefined)) throw new ConvexError("NOT_FOUND");
          if (task.status === "archived") throw new ConvexError("INVALID_STATE");
          const order = await taskPosition(db, task, lane?._id, command.beforePublicId, now);
          orderChanges = order.orderChanges;
          change = {kind:"task.update",publicId,expectedRevision:command.expectedRevision,patch:{laneId:lane?._id ?? null,rank:order.rank}};
          break;
        }
        case "task.complete":
          change = { kind: "task.update", publicId, expectedRevision: command.expectedRevision, patch: { status: "done" } };
          break;
        case "task.reopen":
          change = { kind: "task.reopen", publicId, expectedRevision: command.expectedRevision };
          break;
        case "step.create":
          change = { kind: "step.create", publicId, taskId: task._id, title: command.title };
          break;
        default: {
          const step = await db.query("taskSteps").withIndex("by_workspace_public_id", q =>
            q.eq("workspaceId", workspace._id).eq("publicId", publicId)).unique();
          if (!step || step.taskId !== task._id) throw new ConvexError("NOT_FOUND");
          if (command.kind === "step.move") {
            const order = await stepPosition(db, task, publicId, command.beforePublicId, now);
            orderChanges = order.orderChanges;
            stepInverse = {command:{kind:"step.update",publicId,expectedRevision:command.expectedRevision+1,patch:{rank:step.rank}}};
            change = {kind:"step.update",publicId,expectedRevision:command.expectedRevision,patch:{rank:order.rank}};
            break;
          }
          change = { kind: "step.update", publicId, expectedRevision: command.expectedRevision,
            patch: command.kind === "step.complete" ? { completed: true } : { title: command.title } };
        }
      }
      const updated = await applyTaskDomainCommand(db, workspace._id, change);
      if (updated.target.kind === "task" && command.kind !== "task.move") {
        const after = await db.get("tasks", updated.target.id);
        if (!after) throw new Error("Updated task is unavailable");
        await checkAgentTaskChange(db, task, after, now);
      }
      return { ...updated, beforeRevision: expectedRevision, agentReason, orderChanges, inverse: stepInverse ?? taskInverse(task, change, updated.revision) };
    });
    return portableReceipt(db, result);
  },
});
