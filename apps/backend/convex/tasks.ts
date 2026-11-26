import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { runOperation } from "./model/operations";
import { listTasks, taskByPublicId } from "./model/reads";
import { applyTaskDomainCommand, taskDomainCommand } from "./model/taskDomain";
import { taskStatus } from "./model/values";

const filterValidator = v.union(
  v.object({ kind: v.literal("status"), status: taskStatus }),
  v.object({ kind: v.literal("planned"), from: v.string(), until: v.string() }),
  v.object({ kind: v.literal("deadlineDate"), from: v.string(), until: v.string() }),
  v.object({ kind: v.literal("deadlineInstant"), from: v.number(), until: v.number() }),
  v.object({ kind: v.literal("project"), projectId: v.id("projects") }),
);

export const list = query({
  args: { workspaceId: v.id("workspaces"), filter: filterValidator, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, filter, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return listTasks(ctx.db, workspaceId, filter, paginationOpts);
  },
});

export const get = query({
  args: { workspaceId: v.id("workspaces"), publicId: v.string() },
  handler: async (ctx, { workspaceId, publicId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return taskByPublicId(ctx.db, workspaceId, publicId);
  },
});

export const apply = mutation({
  args: { workspaceId: v.id("workspaces"), operationId: v.string(), command: taskDomainCommand },
  handler: async (ctx, { workspaceId, operationId, command }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    const expectedRevision = "expectedRevision" in command ? command.expectedRevision : undefined;
    return runOperation(ctx.db, {
      workspace, actor: { kind: "user", userId }, origin: "app", action: command.kind,
      operationId, targetPublicId: command.publicId, expectedRevision, input: command,
    }, async ({ db }) => ({
      ...await applyTaskDomainCommand(db, workspaceId, command), beforeRevision: expectedRevision,
    }));
  },
});
