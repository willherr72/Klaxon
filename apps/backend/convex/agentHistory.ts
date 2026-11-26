import { ConvexError, v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { listActivityArgs, undoArgs, calendarArgs } from "./model/agentHistory";
import { checkedReason, portableReceipt } from "./model/agentTasks";
import { checkAgentTaskChange } from "./model/agentTaskPolicy";
import { planningContextArgs, getAgentPlanningContext } from "./model/agentPlanningContext";
import { calendarRange, zonedClock } from "./model/calendarTime";
import { blocksInRange, blockTask, eventsInRange, visibleEvent } from "./model/calendarStore";
import { runOperation } from "./model/operations";
import { readAgentPage } from "./model/agentPagination";
import { undoTaskEvent } from "./model/taskUndo";

const authFields = { ...agentAuthArgs, workspacePublicId:v.string() };

export const list = internalQuery({
  args:{ ...authFields, ...listActivityArgs.fields },
  handler:async ({db}, {limit, cursor, ...proof}) => {
    const grant = await authorizeAgent(db, proof, "activity:read");
    const events = db.query("activityEvents").withIndex("by_workspace_created_at",q =>
      q.eq("workspaceId", grant.workspaceId)).order("desc");
    const result = await readAgentPage(options => events.paginate(options), { limit, cursor });
    const items = await Promise.all(result.page.map(async row => {
      const actor = row.actor;
      const credential = actor.kind === "agent" ? await db.get(actor.credentialId) : null;
      const canUndo = row.undoEligible && actor.kind === "agent" && actor.credentialId === grant.credential._id &&
        grant.scopes.includes("tasks:write") && grant.scopes.includes("activity:undo");
      const inverse = canUndo ? await db.query("taskUndoChanges").withIndex("by_workspace_event", q =>
        q.eq("workspaceId",grant.workspaceId).eq("eventId",row._id)).unique() : null;
      return {publicId:row.publicId, actorKind:actor.kind, agentLabel:credential?.workspaceId === grant.workspaceId ? credential.label : undefined,
        origin:row.origin, action:row.action, createdAt:row.createdAt, reason:row.reason, targetKind:row.target.kind,
        targetPublicId:row.targetPublicId, revision:row.afterRevision, undoEligible:Boolean(inverse),reorderedNeighbors:row.orderChanges?.length};
    }));
    return {items, nextCursor:result.isDone ? null : result.continueCursor};
  },
});

export const undo = internalMutation({
  args:{ ...authFields, ...undoArgs.fields, origin:v.optional(v.literal("mcp")) },
  handler:async ({db}, {eventPublicId, expectedRevision, operationId, reason, origin, ...proof}) => {
    const {workspace, actor, scopes} = await authorizeAgent(db, proof, "activity:undo");
    if (!scopes.includes("tasks:write")) throw new ConvexError("FORBIDDEN");
    const agentReason = checkedReason(reason);
    const event = await db.query("activityEvents").withIndex("by_workspace_public_id",q =>
      q.eq("workspaceId",workspace._id).eq("publicId",eventPublicId)).unique();
    if (!event || event.actor.kind !== "agent" || event.actor.credentialId !== actor.credentialId) throw new ConvexError("NOT_FOUND");
    const result = await runOperation(db,{workspace,actor,origin:origin ?? "api",action:"activity.undo",operationId,
      targetPublicId:event.targetPublicId,expectedRevision,input:{eventPublicId,reason:agentReason}},async ({ now }) => {
      const change = await undoTaskEvent(db,event,expectedRevision,
        (before, after, organizesWork) => checkAgentTaskChange(db, before, after, now, organizesWork));
      return {...change,beforeRevision:expectedRevision,agentReason};
    });
    return portableReceipt(db,result);
  },
});

export const day = internalQuery({
  args:{ ...authFields, ...planningContextArgs.fields },
  handler:async ({db},{date,timezone,...proof}) => {
    const grant = await authorizeAgent(db,proof,"planning:read");
    const {dayPlan,asOf} = await getAgentPlanningContext(db,grant,{date,timezone});
    return {workspacePublicId:grant.workspace.publicId,date,timezone,asOf,dayPlan};
  },
});

export const calendar = internalQuery({
  args:{ ...authFields, ...calendarArgs.fields },
  handler:async ({db},{date,timezone,view,...proof}) => {
    const {workspaceId,userId} = await authorizeAgent(db,proof,"planning:read");
    const range = calendarRange(date,view === "week" ? 7 : 1,zonedClock(timezone));
    const [blocks,events] = await Promise.all([blocksInRange(db,workspaceId,range),eventsInRange(db,workspaceId,userId,range)]);
    const limit = 100;
    const items = await Promise.all(blocks.slice(0,limit).map(async block => {
      const taskId = blockTask(block);
      const task = taskId ? await db.get(taskId) : null;
      const {publicId,revision,startAt,endAt,origin,locked,title} = block;
      return {publicId,revision,startAt,endAt,origin,locked,title,taskPublicId:task?.workspaceId === workspaceId ? task.publicId : undefined};
    }));
    return {date,timezone,...range,asOf:Date.now(),blocks:{items,partial:blocks.length>limit},
      meetings:{items:events.slice(0,limit).map(visibleEvent),partial:events.length>limit}};
  },
});
