import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { integrationTables } from "./model/integrations";
import { ledgerTables } from "./model/ledger";
import { instant, provider, workspaceId } from "./model/values";

const maxRows = 10;
const importRun = ledgerTables.importRuns.validator.fields;
const connection = integrationTables.integrationConnections.validator.fields;

export const jobs = query({
  args: { workspaceId },
  returns: v.object({
    rows: v.array(v.object({
      id: v.id("importRuns"),
      format: importRun.format,
      state: importRun.state,
      createdAt: instant,
      updatedAt: instant,
      hasErrors: v.boolean(),
    })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { workspaceId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const records = await ctx.db.query("importRuns")
      .withIndex("by_workspace_created_at", q => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(maxRows + 1);
    return {
      rows: records.slice(0, maxRows).map(run => ({
        id: run._id,
        format: run.format,
        state: run.state,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        hasErrors: run.errors.length > 0,
      })),
      truncated: records.length > maxRows,
    };
  },
});

export const integrations = query({
  args: { workspaceId },
  returns: v.object({
    rows: v.array(v.object({
      id: v.id("integrationConnections"),
      provider,
      state: connection.state,
      updatedAt: instant,
    })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { workspaceId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const records = await ctx.db.query("integrationConnections")
      .withIndex("by_workspace_provider_account", q => q.eq("workspaceId", workspaceId))
      .take(maxRows + 1);
    return {
      rows: records.slice(0, maxRows).map(row => ({
        id: row._id,
        provider: row.provider,
        state: row.state,
        updatedAt: row.updatedAt,
      })),
      truncated: records.length > maxRows,
    };
  },
});

export const checkpoints = query({
  args: { workspaceId, connectionId: v.id("integrationConnections") },
  returns: v.object({
    rows: v.array(v.object({
      id: v.id("syncCheckpoints"),
      lastSuccessAt: v.optional(instant),
      lastErrorAt: v.optional(instant),
      hasError: v.boolean(),
    })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { workspaceId, connectionId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const selected = await ctx.db.get("integrationConnections", connectionId);
    if (selected?.workspaceId !== workspaceId) throw new ConvexError("INTEGRATION_UNAVAILABLE");
    const records = await ctx.db.query("syncCheckpoints")
      .withIndex("by_workspace_connection_stream", q => q.eq("workspaceId", workspaceId).eq("connectionId", connectionId))
      .take(maxRows + 1);
    return {
      rows: records.slice(0, maxRows).map(row => ({
        id: row._id,
        lastSuccessAt: row.lastSuccessAt,
        lastErrorAt: row.lastErrorAt,
        hasError: row.lastError !== undefined,
      })),
      truncated: records.length > maxRows,
    };
  },
});
