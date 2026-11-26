import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { recordVersion } from "./fixtures";

// The provider's session verification has its own tests. Exercise the real
// registered queries and membership checks with synthetic authenticated users.
vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

function healthBackend() {
  return convexTest({
    schema,
    modules: {
      "../convex/_generated/server.js": () => import("../convex/_generated/server"),
      "../convex/health.ts": () => import("../convex/health"),
    },
  });
}

async function healthFixture() {
  const t = healthBackend();
  const { ownerId, plannerId, readerId, outsiderId, workspaceId, otherWorkspaceId } = await t.run(async ({ db }) => {
    const ownerId = await db.insert("users", {});
    const plannerId = await db.insert("users", {});
    const readerId = await db.insert("users", {});
    const outsiderId = await db.insert("users", {});
    const workspaceId = await db.insert("workspaces", {
      ...recordVersion, ownerId, name: "Owner space", publicId: "owner-space",
    });
    const otherWorkspaceId = await db.insert("workspaces", {
      ...recordVersion, ownerId: outsiderId, name: "Other space", publicId: "other-space",
    });
    for (const [id, userId, role] of [
      [workspaceId, ownerId, "owner"],
      [workspaceId, plannerId, "planner"],
      [workspaceId, readerId, "reader"],
      [otherWorkspaceId, outsiderId, "owner"],
    ] as const) {
      await db.insert("memberships", { ...recordVersion, workspaceId: id, userId, role, publicId: role });
    }
    return { ownerId, plannerId, readerId, outsiderId, workspaceId, otherWorkspaceId };
  });
  return { t, ownerId, plannerId, readerId, outsiderId, workspaceId, otherWorkspaceId,
    owner: t.withIdentity({ subject: ownerId }) };
}

const privateConnection = {
  ...recordVersion,
  provider: "outlook" as const,
  state: "reauthorization_required" as const,
  accountId: "synthetic-provider-account",
  scopeIds: ["synthetic-provider-resource"],
  grantedScopes: ["synthetic-granted-scope"],
  secretRef: "synthetic-provider-secret",
  label: "synthetic-account-label",
};

const privateImport = {
  ...recordVersion,
  archiveHash: "synthetic-archive-hash",
  sourceOrigin: "synthetic-device",
  format: "legacy_sqlite" as const,
  exportFormatVersion: 1,
  sourceSchemaVersion: 17,
  state: "failed" as const,
  counts: [{ sourceTable: "synthetic-table-name", extracted: 1, imported: 0, skipped: 0, rejected: 1, divergent: 0 }],
  checkpoint: { phase: "synthetic-phase", nextBatch: 3 },
  errors: [{ code: "synthetic-private-code", message: "synthetic-import-content" }],
};

test("health exposes only allowlisted job, connection, and checkpoint fields from the selected workspace", async () => {
  const { t, owner, ownerId, outsiderId, workspaceId, otherWorkspaceId } = await healthFixture();
  const { jobId, connectionId, checkpointId } = await t.run(async ({ db }) => {
    const job = { ...privateImport, publicId: "private-job-id" };
    const jobId = await db.insert("importRuns", { ...job, workspaceId, updatedAt: 12 });
    await db.insert("importRuns", { ...job, workspaceId: otherWorkspaceId, createdAt: 99 });
    const connection = { ...privateConnection, publicId: "private-connection-id", updatedAt: 8 };
    const connectionId = await db.insert("integrationConnections", { ...connection, workspaceId, userId: ownerId });
    await db.insert("integrationConnections", { ...connection, workspaceId: otherWorkspaceId, userId: outsiderId });
    const checkpoint = {
      ...recordVersion, connectionId, publicId: "private-checkpoint-id",
      stream: "synthetic-mailbox-identifier", cursor: "synthetic-resume-cursor",
      lastSuccessAt: 4, lastErrorAt: 6, updatedAt: 7,
      lastError: { code: "synthetic-raw-provider-code", message: "synthetic-raw-provider-response" },
    };
    const checkpointId = await db.insert("syncCheckpoints", { ...checkpoint, workspaceId });
    await db.insert("syncCheckpoints", { ...checkpoint, workspaceId: otherWorkspaceId });
    return { jobId, connectionId, checkpointId };
  });

  expect(await owner.query(anyApi.health.jobs, { workspaceId })).toEqual({
    rows: [{ id: jobId, format: "legacy_sqlite", state: "failed", createdAt: 1, updatedAt: 12, hasErrors: true }],
    truncated: false,
  });
  expect(await owner.query(anyApi.health.integrations, { workspaceId })).toEqual({
    rows: [{ id: connectionId, provider: "outlook", state: "reauthorization_required", updatedAt: 8 }],
    truncated: false,
  });
  expect(await owner.query(anyApi.health.checkpoints, { workspaceId, connectionId })).toEqual({
    rows: [{ id: checkpointId, lastSuccessAt: 4, lastErrorAt: 6, hasError: true }],
    truncated: false,
  });
});

test("every health query requires current ownership and checkpoint IDs must belong to the same workspace", async () => {
  const { t, owner, ownerId, plannerId, readerId, outsiderId, workspaceId, otherWorkspaceId } = await healthFixture();
  const [connectionId, foreignConnectionId, removedConnectionId] = await t.run(async ({ db }) => {
    const connection = { ...privateConnection, scopeIds: [], grantedScopes: [], publicId: "connection" };
    const local = await db.insert("integrationConnections", { ...connection, workspaceId, userId: ownerId });
    const foreign = await db.insert("integrationConnections", {
      ...connection, workspaceId: otherWorkspaceId, userId: outsiderId,
    });
    const removed = await db.insert("integrationConnections", {
      ...connection, publicId: "removed", workspaceId, userId: ownerId,
    });
    await db.delete(removed);
    return [local, foreign, removed];
  });
  const checks = [
    [anyApi.health.jobs, { workspaceId }],
    [anyApi.health.integrations, { workspaceId }],
    [anyApi.health.checkpoints, { workspaceId, connectionId }],
  ] as const;
  for (const [ref, args] of checks) {
    await expect(t.query(ref, args)).rejects.toThrow(/UNAUTHENTICATED/);
    await expect(t.withIdentity({ subject: plannerId }).query(ref, args)).rejects.toThrow(/FORBIDDEN/);
    await expect(t.withIdentity({ subject: readerId }).query(ref, args)).rejects.toThrow(/FORBIDDEN/);
    await expect(t.withIdentity({ subject: outsiderId }).query(ref, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  }
  expect(await owner.query(anyApi.health.checkpoints, { workspaceId, connectionId })).toEqual({
    rows: [], truncated: false,
  });
  for (const unavailableId of [foreignConnectionId, removedConnectionId]) {
    await expect(owner.query(anyApi.health.checkpoints, { workspaceId, connectionId: unavailableId }))
      .rejects.toThrow(/INTEGRATION_UNAVAILABLE/);
  }

  await t.run(async ({ db }) => {
    const membership = await db.query("memberships")
      .withIndex("by_workspace_user", q => q.eq("workspaceId", workspaceId).eq("userId", ownerId))
      .unique();
    if (membership === null) throw new Error("Missing test owner's membership");
    await db.delete(membership._id);
  });
  for (const [ref, args] of checks) {
    await expect(owner.query(ref, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  }
});

test("health snapshots cap each list and report truncation without a continuation cursor", async () => {
  const { t, owner, ownerId, workspaceId } = await healthFixture();
  const { connectionId, otherCheckpointId } = await t.run(async ({ db }) => {
    const connection = { ...privateConnection, workspaceId, userId: ownerId, scopeIds: [], grantedScopes: [] };
    const id = await db.insert("integrationConnections", { ...connection, publicId: "connection-00", accountId: "00" });
    for (let index = 1; index <= 11; index++) {
      const suffix = String(index).padStart(2, "0");
      await db.insert("importRuns", {
        ...privateImport, counts: [], errors: [], workspaceId, publicId: suffix, createdAt: index,
      });
      await db.insert("integrationConnections", { ...connection, publicId: suffix, accountId: suffix });
      await db.insert("syncCheckpoints", {
        ...recordVersion, workspaceId, connectionId: id, publicId: suffix, stream: suffix,
      });
    }
    const otherConnectionId = await db.insert("integrationConnections", {
      ...connection, publicId: "other-connection", accountId: "other",
    });
    const otherCheckpointId = await db.insert("syncCheckpoints", {
      ...recordVersion, workspaceId, connectionId: otherConnectionId, publicId: "other-checkpoint", stream: "00",
    });
    return { connectionId: id, otherCheckpointId };
  });

  const jobs = await owner.query(anyApi.health.jobs, { workspaceId });
  expect(jobs.rows.map((row: { createdAt: number }) => row.createdAt)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  expect(jobs.rows[0].hasErrors).toBe(false);
  const integrations = await owner.query(anyApi.health.integrations, { workspaceId });
  const checkpoints = await owner.query(anyApi.health.checkpoints, { workspaceId, connectionId });
  expect(checkpoints.rows[0]).toEqual({ id: expect.any(String), hasError: false });
  expect(checkpoints.rows).not.toContainEqual(expect.objectContaining({ id: otherCheckpointId }));
  for (const result of [jobs, integrations, checkpoints]) {
    expect(result).toEqual({ rows: expect.any(Array), truncated: true });
    expect(result.rows).toHaveLength(10);
  }

  await t.run(async ({ db }) => {
    const oldest = await db.query("importRuns")
      .withIndex("by_workspace_created_at", q => q.eq("workspaceId", workspaceId))
      .first();
    if (oldest === null) throw new Error("Missing test import run");
    await db.delete(oldest._id);
  });
  expect(await owner.query(anyApi.health.jobs, { workspaceId })).toEqual({ rows: jobs.rows, truncated: false });
});
