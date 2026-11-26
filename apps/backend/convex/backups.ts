import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorize, ensurePersonalWorkspace, requireSessionUser } from "./model/access";
import { decodeBackup, encodeBackup } from "./model/backupFormat";
import { readBackup, writeBackup } from "./model/backupStore";
import { runOperation } from "./model/operations";

export const exportWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ archive: v.string() }),
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    return { archive: await encodeBackup(await readBackup(ctx.db, workspace)) };
  },
});

export const restoreWorkspace = mutation({
  args: { archive: v.string(), operationId: v.string() },
  returns: v.object({ workspaceId: v.id("workspaces"), workspacePublicId: v.string() }),
  handler: async (ctx, { archive, operationId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    if (!await ctx.db.get("users", userId)) throw new ConvexError("UNAUTHENTICATED");
    const { payload, checksum, version } = await decodeBackup(archive);
    const workspace = await ensurePersonalWorkspace(ctx.db, userId);
    const operation = await runOperation(ctx.db, {
      workspace, actor: { kind: "user", userId }, origin: "import", action: "workspace.restore",
      operationId, input: { checksum, version },
    }, async ({ db }) => {
      const restored = await writeBackup(db, userId, payload);
      return { target: { kind: "workspace", id: restored.workspaceId }, targetPublicId: restored.workspacePublicId,
        revision: 1 };
    });
    const event = await ctx.db.get("activityEvents", operation.activityEventId);
    if (event?.target.kind !== "workspace") throw new ConvexError("WORKSPACE_UNAVAILABLE");
    const { workspace: restored } = await authorize(ctx.db, event.target.id, userId, "manage");
    return { workspaceId: restored._id, workspacePublicId: operation.targetPublicId };
  },
});
