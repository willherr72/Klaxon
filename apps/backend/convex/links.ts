import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type DatabaseReader } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { runOperation } from "./model/operations";
import { boundedPage } from "./model/pagination";
import { addReference, linkByPublicId, referenceFields } from "./model/referenceStore";
import { checkPublicId, checkRevision } from "./model/taskDomain";

const scope = { workspaceId: v.id("workspaces"), taskId: v.id("tasks") };
const reference = { url: v.string(), label: v.optional(v.string()) };

function editable(link: Doc<"externalLinks">) {
  return link.provider === "url" && link.relationship === "reference" && !link.connectionId;
}

async function requireTask(db: DatabaseReader, workspaceId: Id<"workspaces">, taskId: Id<"tasks">) {
  const task = await db.get("tasks", taskId);
  if (!task || task.workspaceId !== workspaceId) throw new ConvexError({ code: "NOT_FOUND" });
  return task;
}

export const list = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, taskId, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    await requireTask(ctx.db, workspaceId, taskId);
    const result = await ctx.db.query("externalLinks").withIndex("by_workspace_removed_task", q =>
      q.eq("workspaceId", workspaceId).eq("removedAt", undefined).eq("taskId", taskId)).paginate(boundedPage(paginationOpts));
    return { ...result, page: result.page.map(link => {
      const { publicId, revision, relationship, provider, canonicalUrl, label, externalObjectId } = link;
      return { publicId, revision, relationship, provider, canonicalUrl, label, externalObjectId, editable: editable(link) };
    }) };
  },
});

export const apply = mutation({
  args: { ...scope, operationId: v.string(), command: v.union(
    v.object({ kind: v.literal("link.add"), publicId: v.string(), ...reference }),
    v.object({ kind: v.literal("link.edit"), publicId: v.string(), expectedRevision: v.number(), ...reference }),
    v.object({ kind: v.literal("link.remove"), publicId: v.string(), expectedRevision: v.number() }),
  ) },
  handler: async (ctx, { workspaceId, taskId, operationId, command }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    const task = await requireTask(ctx.db, workspaceId, taskId);
    checkPublicId(command.publicId);
    const expectedRevision = "expectedRevision" in command ? command.expectedRevision : undefined;
    return runOperation(ctx.db, {
      workspace, actor: { kind: "user", userId }, origin: "app", action: command.kind,
      targetPublicId: command.publicId, operationId, expectedRevision, input: { taskId, command },
    }, async ({ db, now }) => {
      const targetPublicId = command.publicId;
      if (command.kind === "link.add") return addReference(db, task, command, now);
      if (task.status === "archived") throw new ConvexError({ code: "INVALID_STATE" });
      const link = await linkByPublicId(db, workspaceId, targetPublicId);
      if (!link || link.taskId !== taskId || link.removedAt !== undefined) throw new ConvexError({ code: "NOT_FOUND" });
      if (!editable(link)) throw new ConvexError({ code: "MANAGED_LINK" });
      checkRevision(link.revision, command.expectedRevision);
      const revision = link.revision + 1;
      const fields = command.kind === "link.remove" ? { removedAt: now } : referenceFields(command);
      await db.patch("externalLinks", link._id, { ...fields, revision, updatedAt: now });
      return { target: { kind: "external_link", id: link._id }, targetPublicId, revision, beforeRevision: link.revision };
    });
  },
});
