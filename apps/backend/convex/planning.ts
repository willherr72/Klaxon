import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { normalizePreferences, preferenceRow, preferenceValues, visiblePreferences } from "./model/calendarStore";
import { calendarError } from "./model/calendarTime";
import { requireExpectedRevision, runOperation } from "./model/operations";
import { visibleDayPlan } from "./model/scheduling";
import { applyPreview, revisionByPublicId, savePreview, validatePlanSelection } from "./model/planPreview";

const scope = { workspaceId: v.id("workspaces") };
const date = { localDate: v.string() };
const operation = { operationId: v.string() };

export const getPreferences = query({
  args: scope,
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    return visiblePreferences(await preferenceRow(ctx.db, workspaceId, userId));
  },
});

function validRevision(revision: number, min: number) {
  if (!Number.isSafeInteger(revision) || revision < min) calendarError("INVALID_ARGUMENT", "Invalid expected revision");
}

export const updatePreferences = mutation({
  args: { ...scope, ...operation, expectedRevision: v.number(), preferences: preferenceValues },
  handler: async (ctx, { workspaceId, operationId, expectedRevision, preferences }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    validRevision(expectedRevision, 0);
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "planning.updatePreferences",
      operationId, expectedRevision: expectedRevision || undefined, input: { preferences, expectedRevision },
    }, async ({ db, now }) => {
      const row = await preferenceRow(db, workspaceId, userId);
      requireExpectedRevision(expectedRevision, row?.revision ?? 0);
      const { timezone, workHours, breaks, bufferMinutes, discretionaryMinutes, lockManuallyMovedBlocks } = normalizePreferences(preferences);
      const publicId = row?.publicId ?? crypto.randomUUID();
      const revision = expectedRevision + 1;
      const values = { timezone, workHours, breaks, bufferMinutes, updatedAt: now, revision,
        autonomyPolicy: { ...row?.autonomyPolicy, planApplication: row?.autonomyPolicy.planApplication ?? ("automatic" as const),
          lockManuallyMovedBlocks, discretionaryMinutes } };
      let id: Id<"preferences">;
      if (row) {
        id = row._id;
        await db.patch("preferences", id, values);
      } else {
        id = await db.insert("preferences", { ...values, workspaceId, userId, publicId, createdAt: now,
          notificationSettings: { enabled: false, native: false, webPush: false }, importFilters: [] });
      }
      return { target: { kind: "preferences", id }, targetPublicId: publicId, revision, beforeRevision: row?.revision };
    });
  },
});

export const getDayPlan = query({
  args: { ...scope, ...date },
  handler: async (ctx, { workspaceId, localDate }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "read");
    return visibleDayPlan(ctx.db, workspaceId, userId, localDate);
  },
});

export const preview = mutation({
  args: { ...scope, ...operation, ...date, taskPublicIds: v.array(v.string()),
    expectedDayPlanRevision: v.union(v.number(), v.null()) },
  handler: async (ctx, { workspaceId, operationId, localDate, taskPublicIds, expectedDayPlanRevision }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    validatePlanSelection(taskPublicIds, expectedDayPlanRevision);
    const actor = { kind: "user" as const, userId };
    const result = await runOperation(ctx.db, { workspace, actor, origin: "app", action: "planning.preview", operationId,
      input: { localDate, taskPublicIds, expectedDayPlanRevision },
    }, async ({ db, now }) => {
      return savePreview(db, { workspaceId, userId, now, localDate, taskPublicIds,
        expectedDayPlanRevision, actor });
    });
    const saved = await revisionByPublicId(ctx.db, workspaceId, result.targetPublicId);
    if (!saved?.previewSummary || saved.expiresAt === undefined) throw new Error("Preview receipt has no saved preview");
    return { publicId: saved.publicId, revision: result.revision, localDate: saved.localDate, timezone: saved.timezone,
      expiresAt: saved.expiresAt, baseDayPlanRevision: saved.baseDayPlanRevision, ...saved.previewSummary };
  },
});

export const apply = mutation({
  args: { ...scope, ...operation, publicId: v.string(), expectedRevision: v.number() },
  handler: async (ctx, { workspaceId, operationId, publicId, expectedRevision }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "write");
    return runOperation(ctx.db, { workspace, actor: { kind: "user", userId }, origin: "app", action: "planning.apply",
      operationId, targetPublicId: publicId, expectedRevision, input: null,
    }, async ({ db, now }) => {
      const saved = await revisionByPublicId(db, workspaceId, publicId);
      if (!saved?.previewSummary || saved.actor.kind !== "user" || saved.actor.userId !== userId) calendarError("PLAN_UNAVAILABLE");
      requireExpectedRevision(expectedRevision, saved.revision);
      return applyPreview(db, saved, userId, now, "automation");
    });
  },
});
