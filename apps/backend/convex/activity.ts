import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { boundedPage } from "./model/pagination";
import { runOperation, requireExpectedRevision } from "./model/operations";
import { applyTaskDomainCommand } from "./model/taskDomain";

export const list = query({
  args:{workspaceId:v.id("workspaces"),paginationOpts:paginationOptsValidator},
  handler:async (ctx,{workspaceId,paginationOpts}) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const {role} = await authorize(ctx.db,workspaceId,userId,"read");
    const result = await ctx.db.query("activityEvents").withIndex("by_workspace_created_at",q =>
      q.eq("workspaceId",workspaceId)).order("desc").paginate(boundedPage(paginationOpts));
    const page = await Promise.all(result.page.map(async event => {
      const principal = event.actor;
      const credential = principal.kind === "agent" ? await ctx.db.get("agentCredentials", principal.credentialId) : null;
      const agentLabel = credential?.workspaceId === workspaceId ? `Agent - ${credential.label}` : "Agent";
      const actor = principal.kind === "user" ? (principal.userId === userId ? "You" : "Workspace member")
        : principal.kind === "system" ? "Automation" : principal.kind === "integration" ? "Integration" : agentLabel;
      const inverse = event.undoEligible && role !== "reader" ? await ctx.db.query("taskUndoChanges")
        .withIndex("by_workspace_event",q => q.eq("workspaceId",workspaceId).eq("eventId",event._id)).unique() : null;
      return {eventId:event._id,actor,origin:event.origin,action:event.action,createdAt:event.createdAt,reason:event.reason,
        targetKind:event.target.kind,targetPublicId:event.targetPublicId,revision:event.afterRevision,undoEligible:!!inverse};
    }));
    return {...result,page};
  },
});

export const undo = mutation({
  args:{workspaceId:v.id("workspaces"),eventId:v.id("activityEvents"),expectedRevision:v.number(),operationId:v.string()},
  handler:async (ctx,{workspaceId,eventId,expectedRevision,operationId}) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const {workspace} = await authorize(ctx.db,workspaceId,userId,"write");
    const event = await ctx.db.get("activityEvents",eventId);
    if (!event || event.workspaceId !== workspaceId) throw new ConvexError({code:"NOT_FOUND"});
    return runOperation(ctx.db,{workspace,actor:{kind:"user",userId},origin:"app",action:"activity.undo",
      operationId,targetPublicId:event.targetPublicId,expectedRevision,input:{eventId}},async ({db}) => {
      if (event.target.kind !== "task" || !event.undoEligible || event.afterRevision === undefined) throw new ConvexError({code:"UNDO_UNAVAILABLE"});
      requireExpectedRevision(expectedRevision,event.afterRevision);
      const inverse = await db.query("taskUndoChanges").withIndex("by_workspace_event",q =>
        q.eq("workspaceId",workspaceId).eq("eventId",eventId)).unique();
      if (!inverse) throw new ConvexError({code:"UNDO_UNAVAILABLE"});
      const task = await db.get("tasks",event.target.id);
      if (!task || task.workspaceId !== workspaceId || task.publicId !== event.targetPublicId) throw new ConvexError({code:"NOT_FOUND"});
      requireExpectedRevision(expectedRevision,task.revision);
      const change = await applyTaskDomainCommand(db,workspaceId,inverse.command);
      const {completedAt,archivedAt,archivedFromStatus,rankTieBreak} = inverse;
      await db.patch("tasks",task._id,{completedAt,archivedAt,archivedFromStatus,rankTieBreak});
      await db.delete("taskUndoChanges",inverse._id);
      return {...change,beforeRevision:expectedRevision,reason:"Reversed a reviewed task change"};
    });
  },
});
