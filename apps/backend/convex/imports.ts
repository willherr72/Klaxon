import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authorize, requireSessionUser } from "./model/access";
import { decodeLegacyArchive, legacyError } from "./model/legacyImportFormat";
import { existingLegacyRun, writeLegacyArchive } from "./model/legacyImportStore";
import { runOperation } from "./model/operations";
import { boundedPage } from "./model/pagination";

export const createWorkspace = mutation({
  args: { workspaceId: v.id("workspaces"), operationId: v.string() },
  handler: async (ctx, { workspaceId, operationId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace: source } = await authorize(ctx.db, workspaceId, userId, "manage");
    const operation = await runOperation(ctx.db, {
      workspace: source, actor: { kind: "user", userId }, origin: "import", action: "legacy_import.create_workspace",
      operationId, input: {},
    }, async ({ db, now }) => {
      const version = { revision: 1, createdAt: now, updatedAt: now };
      const publicId = crypto.randomUUID();
      const targetId = await db.insert("workspaces", {
        ...version, ownerId: userId, name: "Legacy import rehearsal", publicId, legacyImport: true,
      });
      await db.insert("memberships", {
        ...version, workspaceId: targetId, userId, role: "owner", publicId: crypto.randomUUID(),
      });
      return { target: { kind: "workspace", id: targetId }, targetPublicId: publicId, revision: 1 };
    });
    const target = await ctx.db.query("workspaces").withIndex("by_public_id", q =>
      q.eq("publicId", operation.targetPublicId)).unique();
    if (!target) legacyError("LEGACY_IMPORT_WORKSPACE");
    const { workspace } = await authorize(ctx.db, target._id, userId, "manage");
    if (!workspace.legacyImport) legacyError("LEGACY_IMPORT_WORKSPACE");
    return { workspaceId: workspace._id, workspacePublicId: workspace.publicId };
  },
});

export const apply = mutation({
  args: {
    workspaceId: v.id("workspaces"), operationId: v.string(), timezone: v.string(), manifest: v.string(),
    projection: v.string(), report: v.string(),
  },
  handler: async (ctx, { workspaceId, operationId, ...artifacts }): Promise<Doc<"importRuns">> => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    if (!workspace.legacyImport) legacyError("LEGACY_IMPORT_WORKSPACE");
    const archive = await decodeLegacyArchive(artifacts);
    const operation = await runOperation(ctx.db, {
      workspace, actor: { kind: "user", userId }, origin: "import", action: "legacy_import.apply",
      operationId, input: { archiveHash: archive.archiveHash, timezone: archive.timezone },
    }, async ({ db, now }) => {
      const previous = await existingLegacyRun(db, workspaceId, archive);
      const run: { id: Id<"importRuns">; publicId: string; revision: number } = previous
        ? { id: previous._id, publicId: previous.publicId, revision: previous.revision }
        : await writeLegacyArchive(db, workspaceId, userId, archive, now);
      return { target: { kind: "import_run", id: run.id }, targetPublicId: run.publicId, revision: run.revision };
    });
    const run = await ctx.db.query("importRuns").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", operation.targetPublicId)).unique();
    if (!run) throw new Error("Legacy import operation is missing its run");
    return run;
  },
});

export const get = query({
  args: { workspaceId: v.id("workspaces"), publicId: v.string() },
  handler: async (ctx, { workspaceId, publicId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    if (!workspace.legacyImport) legacyError("LEGACY_IMPORT_WORKSPACE");
    return ctx.db.query("importRuns").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
  },
});

export const listHolds = query({
  args: {
    workspaceId: v.id("workspaces"), state: v.union(v.literal("quarantined"), v.literal("divergent"), v.literal("deleted")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { workspaceId, state, paginationOpts }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    if (!workspace.legacyImport) legacyError("LEGACY_IMPORT_WORKSPACE");
    return ctx.db.query("importMappings").withIndex("by_workspace_state", q =>
      q.eq("workspaceId", workspaceId).eq("state", state)).paginate(boundedPage(paginationOpts));
  },
});
