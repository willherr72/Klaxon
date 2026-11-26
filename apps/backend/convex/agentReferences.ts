import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type DatabaseReader } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { addLinkArgs, createCaptureArgs, listLinkArgs, searchCaptureArgs } from "./model/agentReferences";
import { readAgentPage } from "./model/agentPagination";
import { enforceAutonomy } from "./model/autonomy";
import { checkedReason, portableReceipt } from "./model/agentTasks";
import { addCapture, searchCaptures as searchCaptureRows } from "./model/captureStore";
import { requireExpectedRevision, runOperation } from "./model/operations";
import { taskByPublicId } from "./model/reads";
import { addReference, referenceFields } from "./model/referenceStore";
import { checkPublicId } from "./model/taskDomain";

const authArgs = { ...agentAuthArgs, workspacePublicId: v.string() };
const originArg = { origin: v.optional(v.union(v.literal("api"), v.literal("mcp"))) };
const maxBodyPreview = 2000;

async function requireTask(db: DatabaseReader, workspaceId: Id<"workspaces">, publicId: string) {
  checkPublicId(publicId);
  const task = await taskByPublicId(db, workspaceId, publicId);
  if (!task) throw new ConvexError("NOT_FOUND");
  return task;
}

export const listLinks = internalQuery({
  args: { ...authArgs, ...listLinkArgs.fields },
  handler: async ({ db }, { taskPublicId, limit, cursor, ...auth }) => {
    const { workspaceId } = await authorizeAgent(db, auth, "tasks:read");
    const task = await requireTask(db, workspaceId, taskPublicId);
    const links = db.query("externalLinks").withIndex("by_workspace_task_reference", q =>
      q.eq("workspaceId", workspaceId).eq("taskId", task._id).eq("provider", "url").eq("relationship", "reference")
        .eq("connectionId", undefined).eq("removedAt", undefined));
    const result = await readAgentPage(options => links.paginate(options), { cursor, limit });
    const items = result.page.flatMap(({ publicId, canonicalUrl, label, revision }) => {
      if (!canonicalUrl) return [];
      try {
        const fields = referenceFields({ url: canonicalUrl, label });
        return [{ publicId, taskPublicId, url: fields.canonicalUrl, label: fields.label, revision }];
      } catch (error) {
        if (error instanceof ConvexError) return [];
        throw error;
      }
    });
    return { items, nextCursor: result.isDone ? null : result.continueCursor };
  },
});

export const link = internalMutation({
  args: { ...authArgs, ...addLinkArgs.fields, ...originArg },
  handler: async ({ db }, { operationId, reason, origin = "api", publicId, taskPublicId, expectedRevision, url, label, ...auth }) => {
    const { workspace, actor } = await authorizeAgent(db, auth, "tasks:write");
    checkPublicId(publicId);
    const agentReason = checkedReason(reason);
    const reference = { publicId, url, label };
    const result = await runOperation(db, { workspace, actor, origin, action: "link.add", operationId,
      targetPublicId: publicId, expectedRevision, input: { ...reference, taskPublicId, reason: agentReason },
    }, async ({ now }) => {
      const task = await requireTask(db, workspace._id, taskPublicId);
      await enforceAutonomy(db, workspace._id, [task], now, "preview");
      requireExpectedRevision(expectedRevision, task.revision);
      const change = await addReference(db, task, reference, now);
      return { ...change, agentReason };
    });
    return portableReceipt(db, result);
  },
});

export const searchCaptures = internalQuery({
  args: { ...authArgs, ...searchCaptureArgs.fields },
  handler: async ({ db }, { text, cursor, limit, ...auth }) => {
    const { workspaceId } = await authorizeAgent(db, auth, "captures:read");
    const hits = searchCaptureRows(db, workspaceId, text);
    const result = await readAgentPage(options => hits.paginate(options), { cursor, limit });
    return { items: result.page.map(({ publicId, body, tags, archivedAt, promotedTaskId, source, revision, createdAt, updatedAt }) => ({
      publicId, body: body.slice(0, maxBodyPreview), bodyTruncated: body.length > maxBodyPreview ? true : undefined,
      tags, archived: archivedAt !== undefined, promoted: promotedTaskId !== undefined, source: source?.kind,
      revision, createdAt, updatedAt,
    })), nextCursor: result.isDone ? null : result.continueCursor };
  },
});

export const createCapture = internalMutation({
  args: { ...authArgs, ...createCaptureArgs.fields, ...originArg },
  handler: async ({ db }, { operationId, reason, origin = "api", publicId, body, tags, ...auth }) => {
    const { workspace, actor } = await authorizeAgent(db, auth, "captures:write");
    checkPublicId(publicId);
    const agentReason = checkedReason(reason);
    const input = { publicId, body, tags };
    const result = await runOperation(db, { workspace, actor, origin, action: "capture.create",
      operationId, targetPublicId: publicId, input: { ...input, reason: agentReason },
    }, async ({ now }) => {
      const change = await addCapture(db, workspace._id, input, { kind: "agent", credentialId: actor.credentialId }, now);
      return { ...change, agentReason };
    });
    return portableReceipt(db, result);
  },
});
