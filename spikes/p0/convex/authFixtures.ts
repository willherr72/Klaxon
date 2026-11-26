import { v } from "convex/values";
import { api, components } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { disposableFixtureRetirement } from "./schema";

const MAX_OWNERS_PER_RUN = 2;
const MAX_TASKS_PER_OWNER = 16;
const MAX_SESSIONS_PER_OWNER = 100; // Auth 2.1's per-user session cap.
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_TITLE = /^Hosted (?:provider fixture|control edit) [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const enroll = internalMutation({
  args: { username: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, credentials): Promise<null> => {
    await enrollAndSignOut(ctx, credentials);
    return null;
  },
});

export const enrollDisposable = internalMutation({
  args: { runId: v.string(), username: v.string(), password: v.string() },
  returns: v.string(),
  handler: async (ctx, { runId, username, password }): Promise<string> => {
    const run = await findRun(ctx, runId);
    if (!isRunUsername(runId, username)) {
      throw new Error("Expected a bounded disposable fixture username for this run");
    }
    if (run?.retirement) throw new Error("Disposable fixture run is retired");
    const owners = run?.owners ?? [];
    if (owners.length >= MAX_OWNERS_PER_RUN) throw new Error("Disposable fixture owner limit reached");

    // Signup creates a fresh app user or fails without adopting an existing username.
    const userId = await enrollAndSignOut(ctx, { username, password });
    const owner = ctx.db.normalizeId("users", userId);
    if (owner === null || owners.some(entry => entry.owner === owner)) {
      throw new Error("Expected a fresh disposable fixture owner");
    }
    const registered = [...owners, { owner, username }];
    if (run) {
      await ctx.db.patch("disposableFixtureRuns", run._id, { owners: registered });
    } else {
      await ctx.db.insert("disposableFixtureRuns", { runId, owners: registered });
    }
    return owner;
  },
});

export const retireDisposable = internalMutation({
  args: { runId: v.string() },
  returns: disposableFixtureRetirement,
  handler: async (ctx, { runId }) => {
    const run = await findRun(ctx, runId);
    if (run?.retirement) return run.retirement;

    const owners = run?.owners ?? [];
    if (owners.length > MAX_OWNERS_PER_RUN || new Set(owners.map(entry => entry.owner)).size !== owners.length) {
      throw new Error("Unexpected disposable fixture registrations");
    }

    const usernames = components.authUsername.public;
    const auth = components.auth.public;
    const preflight = [];
    for (const { owner, username } of owners) {
      const currentUsername = await ctx.runQuery(usernames.getUsername, { userId: owner });
      if (!isRunUsername(runId, username) || (currentUsername !== null && currentUsername !== username)) {
        throw new Error("Unexpected username for disposable fixture owner");
      }
      const tasks = await ctx.db.query("tasks")
        .withIndex("by_owner", q => q.eq("owner", owner))
        .take(MAX_TASKS_PER_OWNER + 1);
      if (tasks.length > MAX_TASKS_PER_OWNER || tasks.some(task => !TASK_TITLE.test(task.title))) {
        throw new Error("Unexpected tasks for disposable fixture owner");
      }
      const sessions = await ctx.runQuery(auth.listSessions, { userId: owner });
      if (sessions.length > MAX_SESSIONS_PER_OWNER) {
        throw new Error("Unexpected session count for disposable fixture owner");
      }
      preflight.push({ owner, tasks, sessions, user: await ctx.db.get("users", owner) });
    }

    const retirement = {
      ownersRetired: owners.length,
      sessionsRevoked: 0,
      tasksDeleted: 0,
      usernamesDeleted: 0,
      usersDeleted: 0,
      // Auth 2.1 exposes no deletion API for either row. The removed username
      // mapping previously provided the only password sign-in path to this ID.
      passwordRowsRetained: owners.length,
      authUserIdRowsRetained: owners.length,
    };
    for (const { owner, tasks, sessions, user } of preflight) {
      if (sessions.length > 0) {
        const revoked = await ctx.runMutation(auth.revokeSessions, {
          sessionIds: sessions.map(session => session.sessionId),
        });
        if (revoked.length !== sessions.length) throw new Error("Incomplete disposable fixture session revocation");
        retirement.sessionsRevoked += revoked.length;
      }
      for (const task of tasks) {
        await ctx.db.delete("tasks", task._id);
        retirement.tasksDeleted++;
      }
      const { deleted } = await ctx.runMutation(usernames.deleteUsername, { userId: owner });
      if (deleted) retirement.usernamesDeleted++;
      if (user !== null) {
        await ctx.db.delete("users", owner);
        retirement.usersDeleted++;
      }
    }

    // Keep aggregate counts for retries and close the run even if retirement
    // won the race with the first enrollment. Drop registered usernames/IDs.
    if (run) {
      await ctx.db.patch("disposableFixtureRuns", run._id, { owners: [], retirement });
    } else {
      await ctx.db.insert("disposableFixtureRuns", { runId, owners: [], retirement });
    }
    return retirement;
  },
});

async function findRun(ctx: MutationCtx, runId: string) {
  if (!RUN_ID.test(runId)) throw new Error("Expected a lowercase UUIDv4 disposable fixture run ID");
  const runs = await ctx.db.query("disposableFixtureRuns")
    .withIndex("by_run", q => q.eq("runId", runId))
    .take(2);
  if (runs.length > 1) throw new Error("Duplicate disposable fixture run");
  return runs[0];
}

function isRunUsername(runId: string, username: string) {
  const prefix = `p0-hosted-${runId}-`;
  return username.startsWith(prefix) && /^[a-z0-9]{1,16}$/.test(username.slice(prefix.length));
}

async function enrollAndSignOut(
  ctx: MutationCtx,
  credentials: { username: string; password: string },
): Promise<string> {
  // Nested mutations share this transaction. Concurrent signups never
  // observe the marker because it is removed before the transaction commits.
  const marker = await ctx.db.insert("fixtureEnrollments", {});
  const result = await ctx.runMutation(api.auth.signUpWithUsernamePassword, credentials);
  if (result.status !== "complete") {
    throw new Error("Could not enroll synthetic user");
  }
  await ctx.runMutation(api.auth.signOut, { refreshToken: result.tokens.refreshToken });
  await ctx.db.delete("fixtureEnrollments", marker);
  return result.tokens.userId;
}
