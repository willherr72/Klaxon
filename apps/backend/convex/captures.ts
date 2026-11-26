import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { addCapture, captureByPublicId, searchCaptures } from "./model/captureStore";
import { runOperation } from "./model/operations";
import { boundedPage } from "./model/pagination";
import { applyTaskDomainCommand, checkedTags, checkPublicId, checkRevision, requiredText } from "./model/taskDomain";

const pageArgs = { workspaceId: v.id("workspaces"), paginationOpts: paginationOptsValidator };
const identity = { publicId: v.string() };
const existing = { ...identity, expectedRevision: v.number() };
const content = { body: v.string(), tags: v.optional(v.array(v.string())) };

export const list = query({
  args: pageArgs,
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return ctx.db.query("captures").withIndex("by_workspace_inbox", q =>
      q.eq("workspaceId", workspaceId).eq("archivedAt", undefined).eq("promotedTaskId", undefined))
      .order("desc").paginate(boundedPage(paginationOpts));
  },
});

export const search = query({
  args: { ...pageArgs, text: v.string() },
  handler: async (ctx, { workspaceId, text, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return searchCaptures(ctx.db, workspaceId, text).paginate(boundedPage(paginationOpts));
  },
});

export const apply = mutation({
  args: {
    workspaceId: v.id("workspaces"), operationId: v.string(),
    command: v.union(
      v.object({ kind: v.literal("capture.create"), ...identity, ...content }),
      v.object({ kind: v.literal("capture.update"), ...existing, ...content }),
      v.object({ kind: v.literal("capture.archive"), ...existing }),
      v.object({ kind: v.literal("capture.promote"), ...existing, taskPublicId: v.string(), title: v.string() }),
    ),
  },
  handler: async (ctx, { workspaceId, operationId, command }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    const publicId = command.publicId;
    checkPublicId(publicId);
    const expectedRevision = "expectedRevision" in command ? command.expectedRevision : undefined;
    return runOperation(ctx.db, {
      workspace, actor: { kind: "user", userId }, origin: "app", action: command.kind,
      operationId, expectedRevision, targetPublicId: publicId, input: command,
    }, async ({ db, now }) => {
      if (command.kind === "capture.create") {
        return addCapture(db, workspaceId, command, { kind: "manual" }, now);
      }
      const capture = await captureByPublicId(db, workspaceId, publicId);
      if (!capture) throw new ConvexError({ code: "NOT_FOUND" });
      checkRevision(capture.revision, command.expectedRevision);
      if (capture.archivedAt !== undefined || capture.promotedTaskId) throw new ConvexError({ code: "INVALID_STATE" });
      const version = { revision: capture.revision + 1, updatedAt: now };
      if (command.kind === "capture.promote") {
        const task = await applyTaskDomainCommand(db, workspaceId, {
          kind: "task.create", publicId: command.taskPublicId, title: command.title, status: "inbox",
          description: capture.body, tags: capture.tags,
        });
        if (task.target.kind !== "task") throw new Error("Expected a task from task.create");
        await db.patch("tasks", task.target.id, { source: { kind: "capture", captureId: capture._id } });
        await db.patch("captures", capture._id, { ...version, promotedTaskId: task.target.id });
      } else if (command.kind === "capture.archive") {
        await db.patch("captures", capture._id, { ...version, archivedAt: now });
      } else {
        await db.patch("captures", capture._id, {
          ...version, body: requiredText(command.body, "body", 32_768), tags: checkedTags(command.tags ?? capture.tags),
        });
      }
      return { target: { kind: "capture", id: capture._id }, targetPublicId: publicId,
        revision: version.revision, beforeRevision: capture.revision };
    });
  },
});
