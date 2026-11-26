import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query, type DatabaseReader } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { authorize, requireSessionUser } from "./model/access";
import { checkPublicId, requiredText } from "./model/taskDomain";
import { runOperation } from "./model/operations";

const scope = { workspaceId: v.id("workspaces") };
const projectScope = { ...scope, projectId: v.id("projects") };

async function projectRecord(db: DatabaseReader, workspaceId: Id<"workspaces">, projectId: Id<"projects">) {
  const project = await db.get("projects", projectId);
  if (!project || project.workspaceId !== workspaceId) throw new ConvexError({ code: "NOT_FOUND" });
  return project;
}

export const lanes = query({
  args: projectScope,
  handler: async (ctx, {workspaceId, projectId}) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    const project = await projectRecord(ctx.db, workspaceId, projectId);
    const limit = 64;
    const groups = await Promise.all([projectId, undefined].map(id => ctx.db.query("lanes")
      .withIndex("by_workspace_project_active_rank", q => q.eq("workspaceId", workspaceId)
        .eq("projectId", id).eq("archivedAt", undefined)).take(limit + 1)));
    const configured = new Map(project.board?.laneIds.map((id,i) => [id,i]));
    const rows = groups.flat().sort((a,b) => (configured.get(a._id) ?? Infinity) - (configured.get(b._id) ?? Infinity)
      || a.rank - b.rank || a.publicId.localeCompare(b.publicId));
    return { lanes: rows.slice(0,limit).map(({_id,publicId,name,rank}) => ({_id,publicId,name,rank})), partial: rows.length > limit };
  },
});

export const createLane = mutation({
  args: {...projectScope, operationId: v.string(), publicId: v.string(), name: v.string()},
  handler: async (ctx, {workspaceId, projectId, operationId, publicId, name}) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const {workspace} = await authorize(ctx.db, workspaceId, userId, "write");
    const project = await projectRecord(ctx.db, workspaceId, projectId);
    checkPublicId(publicId);
    return runOperation(ctx.db, {workspace, actor:{kind:"user",userId}, origin:"app", action:"lane.create",
      operationId, targetPublicId: publicId, input:{projectId,publicId,name}}, async ({db,now}) => {
      if (project.archivedAt !== undefined) throw new ConvexError({code:"INVALID_STATE"});
      const existing = await db.query("lanes").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId",workspaceId).eq("publicId",publicId)).unique();
      if (existing) throw new ConvexError({code:"ALREADY_EXISTS"});
      const last = await db.query("lanes").withIndex("by_workspace_project_rank", q =>
        q.eq("workspaceId",workspaceId).eq("projectId",projectId)).order("desc").first();
      const rank = last ? last.rank + 1 : 0;
      if (!Number.isFinite(rank) || (last && rank <= last.rank)) throw new ConvexError({code:"RANK_LIMIT"});
      const id = await db.insert("lanes",{workspaceId,projectId,publicId,name:requiredText(name,"name",512),rank,
        isDefault:false,createdAt:now,updatedAt:now,revision:1});
      return {target:{kind:"lane",id},targetPublicId: publicId,revision:1};
    });
  },
});

export const search = query({
  args: { ...scope, text: v.string() },
  handler: async (ctx, { workspaceId, text }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    const term = requiredText(text, "text", 256);
    const limit = 12;
    const [titles, descriptions, links, notes] = await Promise.all([
      ctx.db.query("tasks").withSearchIndex("search_title", q => q.search("title", term).eq("workspaceId", workspaceId)).take(limit + 1),
      ctx.db.query("tasks").withSearchIndex("search_description", q => q.search("description", term).eq("workspaceId", workspaceId)).take(limit + 1),
      ctx.db.query("externalLinks").withIndex("by_workspace_external_id_removed", q => q.eq("workspaceId", workspaceId)
        .eq("externalObjectId", term).eq("removedAt", undefined)).take(limit + 1),
      ctx.db.query("dayNotes").withSearchIndex("search_body", q => q.search("body", term).eq("workspaceId", workspaceId)).take(limit + 1),
    ]);
    const linkedTasks = await Promise.all([...new Set(links.map(link => link.taskId))].map(id => ctx.db.get("tasks", id)));
    const matches = new Map([...linkedTasks, ...titles, ...descriptions].flatMap(task => task?.workspaceId === workspaceId
      ? [[task.publicId, { publicId: task.publicId, title: task.title, status: task.status }] as const] : []));
    return { tasks: [...matches.values()].slice(0,limit), notes: notes.slice(0,limit).map(note => ({
      publicId: note.publicId, localDate: note.localDate, excerpt: note.body.slice(0,320),
    })), partial: matches.size > limit || [titles, descriptions, links, notes].some(rows => rows.length > limit) };
  },
});
