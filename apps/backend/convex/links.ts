import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type DatabaseReader } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { runOperation } from "./model/operations";
import { boundedPage } from "./model/pagination";
import { checkPublicId, checkRevision, requiredText } from "./model/taskDomain";

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

function referenceFields(input: { url: string; label?: string }) {
  const raw = requiredText(input.url, "url", 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "url" });
  }
  if (url.protocol !== "https:" || url.username || url.password || /[\x00-\x20\x7f]/u.test(raw)) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "url" });
  }
  const label = input.label?.trim() ? requiredText(input.label, "label", 512) : undefined;
  return { canonicalUrl: url.href, label };
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
      if (task.status === "archived") throw new ConvexError({ code: "INVALID_STATE" });
      const targetPublicId = command.publicId;
      const link = await db.query("externalLinks").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId", workspaceId).eq("publicId", targetPublicId)).unique();
      if (command.kind === "link.add") {
        if (link) throw new ConvexError({ code: "ALREADY_EXISTS" });
        const id = await db.insert("externalLinks", {
          workspaceId, taskId, publicId: targetPublicId, provider: "url", relationship: "reference",
          ...referenceFields(command), createdAt: now, updatedAt: now, revision: 1,
        });
        return { target: { kind: "external_link", id }, targetPublicId, revision: 1 };
      }
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
