// This internal module is copied only to the disposable staged deployment.
import { v } from "convex/values";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import schema from "./schema";

export const requireEmpty = internalQuery({
  args: {},
  handler: async ({ db }) => {
    const tables = Object.keys(schema.tables) as (keyof typeof schema.tables)[];
    if ((await Promise.all(tables.map(table => db.query(table).first()))).some(Boolean)) {
      throw new Error("The staged deployment contains data");
    }
    if (await db.system.query("_storage").first() || await db.system.query("_scheduled_functions").first()) {
      throw new Error("The staged deployment contains storage or scheduled functions");
    }
    return true;
  },
});

export const enroll = internalMutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, credentials): Promise<Id<"users">> => {
    if (!/^dot-owner-[0-9a-f-]{36}$/.test(credentials.username) ||
        await ctx.db.query("dotOperatorState").first() || await ctx.db.query("users").first()) {
      throw new Error("Refusing to enroll a non-fixture owner");
    }
    const userId = await ctx.runMutation(internal.auth.enrollWithUsernamePassword, credentials);
    await ctx.db.insert("dotOperatorState", { userId });
    return userId;
  },
});

export const retirementMarker = internalQuery({
  args: {},
  handler: () => "klaxon-dot-disposable-v1",
});

// Recover the same synthetic login only after a failed pre-consent bootstrap.
export const recoverBeforeConsent = internalMutation({
  args: { password: v.string() },
  handler: async (ctx, { password }) => {
    const { db } = ctx;
    const [markers, users, workspaces, credentials, members] = await Promise.all([
      db.query("dotOperatorState").take(2), db.query("users").take(2), db.query("workspaces").take(2),
      db.query("agentCredentials").take(2), db.query("memberships").take(2),
    ]);
    const [user] = users, [workspace] = workspaces, [credential] = credentials;
    if (![markers, users, workspaces, credentials, members].every(rows => rows.length === 1) ||
        markers[0].userId !== user._id || user.personalWorkspaceId !== workspace._id || workspace.ownerId !== user._id ||
        members[0].userId !== user._id || members[0].workspaceId !== workspace._id || members[0].role !== "owner" ||
        credential.workspaceId !== workspace._id || credential.userId !== user._id || credential.revokedAt === undefined ||
        credential.label !== "Dot disposable task fixture" || credential.scopes.length !== 2 ||
        !credential.scopes.includes("tasks:read") || !credential.scopes.includes("tasks:write")) throw new Error("Fixture recovery refused");
    const allowed = new Set(["users", "workspaces", "memberships", "agentCredentials", "dotOperatorState"]);
    const other = (Object.keys(schema.tables) as (keyof typeof schema.tables)[]).filter(table => !allowed.has(table));
    if ((await Promise.all(other.map(table => db.query(table).first()))).some(Boolean) ||
        await db.system.query("_storage").first() || await db.system.query("_scheduled_functions").first() ||
        (await ctx.runQuery(components.auth.public.listSessions, { userId: user._id })).length) {
      throw new Error("Expected unused, retired fixture");
    }
    const username = await ctx.runQuery(components.authUsername.public.getUsername, { userId: user._id });
    if (!username || !/^dot-owner-[0-9a-f-]{36}$/.test(username) || !/^[0-9a-f]{64}$/.test(password)) {
      throw new Error("Unexpected fixture login");
    }
    const result = await ctx.runMutation(components.authPassword.public._internal_dangerous_setPassword,
      { userId: user._id, password, minimumLength: 32 });
    if (!result.success) throw new Error("Could not reset fixture login");
    return { userId: user._id, username };
  },
});

export const inspect = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users"), credentialPublicId: v.string(),
    taskPublicId: v.string(), title: v.string(), updated: v.boolean(), revoked: v.boolean(), clientId: v.string(),
    issuer: v.string(), createOperationId: v.string(), updateOperationId: v.string() },
  handler: async ({ db }, args) => {
    const [users, workspaces, members, credentials, tasks, activity, receipts, storage, jobs, connections, reminders,
      subscriptions, blocks, captures, links, steps] = await Promise.all([
      db.query("users").take(2), db.query("workspaces").take(2), db.query("memberships").take(2),
      db.query("agentCredentials").take(3), db.query("tasks").take(2), db.query("activityEvents").take(3),
      db.query("operationReceipts").take(3), db.system.query("_storage").first(),
      db.system.query("_scheduled_functions").first(), db.query("integrationConnections").first(),
      db.query("reminders").first(), db.query("pushSubscriptions").first(), db.query("timeBlocks").first(),
      db.query("captures").first(), db.query("externalLinks").first(), db.query("taskSteps").first(),
    ]);
    const [user] = users, [workspace] = workspaces, [member] = members, [task] = tasks;
    const credential = credentials.find(row => row.publicId === args.credentialPublicId);
    if (users.length !== 1 || workspaces.length !== 1 || members.length !== 1 || !credential || credentials.length > 2 ||
        credentials.some(row => row !== credential && (row.revokedAt === undefined ||
          row.userId !== args.userId || row.workspaceId !== args.workspaceId || row.label !== "Dot disposable task fixture")) ||
        tasks.length !== (args.updated ? 1 : 0) || [storage, jobs, connections, reminders, subscriptions, blocks, captures, links, steps].some(Boolean) ||
        user._id !== args.userId || user.personalWorkspaceId !== args.workspaceId || workspace._id !== args.workspaceId ||
        workspace.ownerId !== args.userId || member.workspaceId !== args.workspaceId || member.userId !== args.userId ||
        member.role !== "owner") throw new Error("Unexpected staged data");
    if (credential.workspaceId !== args.workspaceId || credential.userId !== args.userId ||
        credential.publicId !== args.credentialPublicId || credential.scopes.length !== 2 ||
        !credential.scopes.includes("tasks:read") || !credential.scopes.includes("tasks:write") ||
        credential.oauthPrincipal?.issuer !== args.issuer || credential.oauthPrincipal.subject !== "klaxon-dot-fixture" ||
        credential.oauthPrincipal.clientId !== args.clientId || (credential.revokedAt !== undefined) !== args.revoked) {
      throw new Error("Unexpected grant or OAuth binding");
    }
    if (!args.updated) {
      if (activity.length !== 0 || receipts.length !== 0) throw new Error("The baseline contains activity");
      return { tasks: 0, revision: 0, activityEvents: 0, agentUpdates: 0, ownerBinding: true,
        taskPublicId: args.taskPublicId, revoked: args.revoked, checkedAt: new Date().toISOString() };
    }
    const revision = 2;
    if (task.workspaceId !== args.workspaceId || task.publicId !== args.taskPublicId || task.title !== args.title ||
        task.revision !== revision || task.status !== "ready" || task.priority !== "none" || task.description !== undefined ||
        task.projectId !== undefined || task.laneId !== undefined || task.estimateMinutes !== undefined ||
        task.plannedDate !== undefined || task.deadline !== undefined || task.tags !== undefined ||
        task.waitingReason !== undefined || task.waitingPerson !== undefined || task.followUpDate !== undefined) {
      throw new Error("Unexpected synthetic task state");
    }
    const [seed, update] = activity;
    if (activity.length !== revision || receipts.length !== revision ||
        seed.actor.kind !== "agent" || seed.actor.credentialId !== credential._id || seed.origin !== "mcp" ||
        seed.action !== "task.create" || seed.operationId !== args.createOperationId ||
        seed.targetPublicId !== task.publicId || seed.afterRevision !== 1 ||
        (args.updated && (update.actor.kind !== "agent" || update.actor.credentialId !== credential._id ||
          update.origin !== "mcp" || update.action !== "task.update" || update.operationId !== args.updateOperationId ||
          update.targetPublicId !== task.publicId ||
          update.beforeRevision !== 1 || update.afterRevision !== 2)) ||
        activity.some(event => event.workspaceId !== args.workspaceId || event.target.kind !== "task" ||
          event.target.id !== task._id || event.outcome !== "applied" ||
          !receipts.some(receipt => receipt.result.activityEventId === event._id))) {
      throw new Error("Unexpected staged audit trail");
    }
    return { tasks: 1, revision, activityEvents: revision, agentUpdates: args.updated ? 1 : 0,
      ownerBinding: true, taskPublicId: task.publicId, revoked: args.revoked, checkedAt: new Date().toISOString() };
  },
});

export const retire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { db } = ctx;
    const [users, workspaces, credentials, markers] = await Promise.all([
      db.query("users").take(2), db.query("workspaces").take(2), db.query("agentCredentials").take(3),
      db.query("dotOperatorState").take(2),
    ]);
    if (users.length === 0 && workspaces.length === 0 && credentials.length === 0 && markers.length === 0) {
      return { grantRevoked: true, ownerSessionsRevoked: true };
    }
    const [user] = users, [workspace] = workspaces;
    if (users.length !== 1 || markers.length !== 1 || markers[0].userId !== user._id ||
        workspaces.length > 1 || credentials.length > 2 ||
        (workspace && (workspace.ownerId !== user._id || workspace._id !== user.personalWorkspaceId)) ||
        credentials.some(credential => credential.userId !== user._id || credential.workspaceId !== workspace?._id ||
        credential.label !== "Dot disposable task fixture" || credential.scopes.length !== 2 ||
        !credential.scopes.includes("tasks:read") || !credential.scopes.includes("tasks:write"))) {
      throw new Error("Refusing to retire a non-fixture grant");
    }
    for (const credential of credentials.filter(row => row.revokedAt === undefined)) {
      const now = Date.now();
      await db.patch("agentCredentials", credential._id, { revokedAt: now, updatedAt: now, revision: credential.revision + 1 });
    }
    const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
    if (sessions.length) {
      await ctx.runMutation(components.auth.public.revokeSessions, { sessionIds: sessions.map(session => session.sessionId) });
    }
    const remaining = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
    if (remaining.length) throw new Error("Synthetic owner sessions remain");
    return { grantRevoked: true, ownerSessionsRevoked: true };
  },
});
