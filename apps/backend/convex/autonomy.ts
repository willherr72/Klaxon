import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { normalizeAutonomy, ownerAutonomy, visibleAutonomy } from "./model/autonomy";
import { autonomyPolicy } from "./model/autonomyValues";
import { preferenceRow, visiblePreferences } from "./model/calendarStore";
import { calendarError } from "./model/calendarTime";
import { requireExpectedRevision, runOperation } from "./model/operations";
import { taskByPublicId } from "./model/reads";

const workspaceArgs = { workspaceId: v.id("workspaces") };

export const get = query({
  args: workspaceArgs,
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "manage");
    const snapshot = await ownerAutonomy(ctx.db, workspaceId);
    const { excludedTaskPublicIds, excludedProjectPublicIds, scope } = snapshot.policy;
    const projectIds = new Set([...excludedProjectPublicIds, ...(scope.kind === "projects" ? scope.projectPublicIds : [])]);
    const [taskNames, projectNames] = await Promise.all([
      Promise.all(excludedTaskPublicIds.map(async publicId => ({
        publicId, name: (await taskByPublicId(ctx.db, workspaceId, publicId))?.title ?? "Unavailable task",
      }))),
      Promise.all([...projectIds].map(async publicId => {
        const project = await ctx.db.query("projects").withIndex("by_workspace_public_id", q =>
          q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
        return { publicId, name: project?.name ?? "Unavailable project" };
      })),
    ]);
    return { ...snapshot, taskNames, projectNames };
  },
});

export const searchTasks = query({
  args: { ...workspaceArgs, title: v.string() },
  handler: async (ctx, { workspaceId, title }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const search = title.trim();
    if (search.length < 2 || search.length > 100) calendarError("INVALID_ARGUMENT", "Enter 2–100 characters");
    const matches = await ctx.db.query("tasks").withSearchIndex("search_title", q =>
      q.search("title", search).eq("workspaceId", workspaceId)).take(15);
    return matches.map(({ publicId, title: name }) => ({ publicId, name }));
  },
});

export const update = mutation({
  args: { ...workspaceArgs, expectedRevision: v.number(), operationId: v.string(), policy: autonomyPolicy },
  handler: async (ctx, { workspaceId, expectedRevision, operationId, policy }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      calendarError("INVALID_ARGUMENT", "Expected a nonnegative preference revision");
    }
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "autonomy.update",
      operationId, expectedRevision: expectedRevision || undefined, input: { policy, expectedRevision },
    }, async ({ db, now }) => {
      const row = await preferenceRow(db, workspaceId, userId);
      requireExpectedRevision(expectedRevision, row?.revision ?? 0);
      const normalized = await normalizeAutonomy(db, workspaceId, policy, visibleAutonomy(row));
      const { timezone, workHours, breaks, bufferMinutes, discretionaryMinutes, lockManuallyMovedBlocks } = visiblePreferences(row);
      const revision = expectedRevision + 1;
      const values = { revision, updatedAt: now, autonomyPolicy: { ...normalized, lockManuallyMovedBlocks,
        discretionaryMinutes: row ? row.autonomyPolicy.discretionaryMinutes : discretionaryMinutes } };
      const publicId = row?.publicId ?? crypto.randomUUID();
      const id = row?._id ?? await db.insert("preferences", { ...values, workspaceId, userId, publicId, createdAt: now,
        timezone, workHours, breaks, bufferMinutes, notificationSettings: { enabled: false, native: false, webPush: false },
        importFilters: [] });
      if (row) await db.patch("preferences", id, values);
      return { target: { kind: "preferences", id }, targetPublicId: publicId, revision, beforeRevision: row?.revision };
    });
  },
});
