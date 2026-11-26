import { anyApi, makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { authorizeAgent, hashAgentToken } from "../convex/model/agentCredentials";
import schema from "../convex/schema";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function setup() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agentCredentials.ts": () => import("../convex/agentCredentials"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
  const userId = await t.run(({ db }) => db.insert("users", {}));
  const owner = t.withIdentity({ subject: userId });
  const workspace = await owner.mutation(anyApi.workspaces.ensurePersonal, {});
  const token = "klx_" + "ab".repeat(32);
  const tokenHash = await hashAgentToken(token);
  const args = { workspaceId: workspace._id, tokenHash, label: "Planner", scopes: ["tasks:read"],
    expiresAt: Date.now() + 120_000 };
  const issue = () => owner.mutation(anyApi.agentCredentials.issue, args);
  const listArgs = { workspaceId: workspace._id, paginationOpts: { cursor: null, numItems: 10 } };
  const authArgs = { tokenHash, workspacePublicId: workspace.publicId };
  return { t, owner, userId, workspace, token, tokenHash, args, issue, listArgs, authArgs };
}

test("OAuth requires an operator mapping, explicit owner consent and a current scope on every read", async () => {
  const { t, owner, issue, workspace, listArgs } = await setup();
  const credential = await issue();
  const pair = { workspacePublicId: workspace.publicId, credentialPublicId: credential.publicId };
  const principal = { issuer: "https://issuer.example", subject: "dedicated-agent", clientId: "planner-client" };
  const auth = { verifiedOAuth: { ...principal, scopes: ["tasks:read", "tasks:write"], expiresAt: Date.now() + 60_000 } };
  const binding = { workspaceId: workspace._id, publicId: credential.publicId, expectedPrincipal: principal };
  const check = () => t.run(({ db }) => authorizeAgent(db, auth, "tasks:read"));
  const mapping = { ...principal, ...pair };
  vi.stubEnv("KLAXON_OAUTH_BINDINGS", JSON.stringify([mapping]));
  try {
    expect((await owner.query(anyApi.agentCredentials.list, listArgs)).page[0].oauthBindingAvailable).toBe(true);
    await expect(check()).rejects.toThrow(/AGENT_UNAUTHORIZED/);
    await owner.mutation(anyApi.agentCredentials.bindOAuth, binding);
    expect((await check()).scopes).toEqual(["tasks:read"]);
    await expect(t.run(({ db }) => authorizeAgent(db, { verifiedOAuth: { ...auth.verifiedOAuth, scopes: [] } }, "tasks:read")))
      .rejects.toThrow(/FORBIDDEN/);
    await expect(t.run(({ db }) => authorizeAgent(db, { verifiedOAuth: { ...auth.verifiedOAuth, expiresAt: Date.now() } }, "tasks:read")))
      .rejects.toThrow(/AGENT_UNAUTHORIZED/);
    vi.stubEnv("KLAXON_OAUTH_BINDINGS", JSON.stringify([{ ...mapping, subject: "replacement" }]));
    await expect(check()).rejects.toThrow(/AGENT_UNAUTHORIZED/);
    await expect(t.run(({ db }) => authorizeAgent(db, { verifiedOAuth: { ...auth.verifiedOAuth, subject: "replacement" } }, "tasks:read")))
      .rejects.toThrow(/AGENT_UNAUTHORIZED/);
    vi.stubEnv("KLAXON_OAUTH_BINDINGS", JSON.stringify([mapping]));
    await owner.mutation(anyApi.agentCredentials.revoke, { workspaceId: workspace._id, publicId: credential.publicId });
    await expect(check()).rejects.toThrow(/AGENT_UNAUTHORIZED/);
  } finally { vi.unstubAllEnvs(); }
});

test("owners register only a digest and list safe credential metadata", async () => {
  const { t, owner, token, tokenHash, args, issue, listArgs } = await setup();
  await expect(t.mutation(anyApi.agentCredentials.issue, args)).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(t.query(anyApi.agentCredentials.list, listArgs)).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(owner.mutation(anyApi.agentCredentials.issue, { ...args, tokenHash: token }))
    .rejects.toThrow(/INVALID_AGENT_CREDENTIAL/);
  await expect(owner.mutation(anyApi.agentCredentials.issue, { ...args, expiresAt: Date.now() - 1 }))
    .rejects.toThrow(/INVALID_AGENT_CREDENTIAL/);
  const issued = await issue();
  expect(issued).toMatchObject({ label: "Planner", scopes: ["tasks:read"], expiresAt: args.expiresAt });
  expect(issued).not.toHaveProperty("token");
  expect(issued).not.toHaveProperty("tokenHash");
  expect((await owner.query(anyApi.agentCredentials.list, listArgs)).page).toEqual([issued]);
  expect(await issue()).toEqual(issued);
  await expect(owner.mutation(anyApi.agentCredentials.issue, { ...args, label: "Renamed" }))
    .rejects.toThrow(/AGENT_TOKEN_IN_USE/);
  const stored = await t.run(({ db }) => db.query("agentCredentials").unique());
  expect(stored?.tokenHash).toEqual(tokenHash);
  expect(JSON.stringify(stored)).not.toContain(token);
});

test("agent authorization is workspace-bound, scoped, current and revocable", async () => {
  const { t, userId, owner, workspace, issue, authArgs, args, listArgs } = await setup();
  const issued = await issue();
  expect(await t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read")))
    .toMatchObject({ workspaceId: workspace._id, userId, actor: { kind: "agent" } });
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:write"))).rejects.toThrow(/FORBIDDEN/);
  await expect(t.run(({ db }) => authorizeAgent(db, { ...authArgs, workspacePublicId: "foreign" }, "tasks:read")))
    .rejects.toThrow(/AGENT_UNAUTHORIZED/);
  const plannerId = await t.run(async ({ db }) => {
    const id = await db.insert("users", {});
    await db.insert("memberships", {
      workspaceId: workspace._id, userId: id, role: "planner", publicId: "planner",
      createdAt: 1, updatedAt: 1, revision: 1,
    });
    return id;
  });
  const revokeArgs = { workspaceId: workspace._id, publicId: issued.publicId };
  const planner = t.withIdentity({ subject: plannerId });
  await expect(planner.mutation(anyApi.agentCredentials.revoke, revokeArgs)).rejects.toThrow(/FORBIDDEN/);
  await expect(planner.mutation(anyApi.agentCredentials.issue, args)).rejects.toThrow(/FORBIDDEN/);
  await expect(planner.query(anyApi.agentCredentials.list, listArgs)).rejects.toThrow(/FORBIDDEN/);
  const revoked = await owner.mutation(anyApi.agentCredentials.revoke, revokeArgs);
  expect(revoked.revokedAt).toEqual(expect.any(Number));
  expect(await owner.mutation(anyApi.agentCredentials.revoke, revokeArgs)).toEqual(revoked);
  expect(await issue()).toEqual(revoked);
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read"))).rejects.toThrow(/AGENT_UNAUTHORIZED/);
});

test("expired credentials and credentials with removed membership are invalid", async () => {
  const { t, userId, workspace, args, issue, authArgs } = await setup();
  await issue();
  const credentialId = await t.run(async ({ db }) => (await db.query("agentCredentials").unique())!._id);
  const past = Date.now();
  await t.run(({ db }) => db.patch(credentialId, { expiresAt: past }));
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read"))).rejects.toThrow(/AGENT_UNAUTHORIZED/);
  await t.run(async ({ db }) => {
    await db.patch(credentialId, { expiresAt: args.expiresAt });
    const membership = await db.query("memberships").withIndex("by_workspace_user", q =>
      q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    await db.delete(membership!._id);
  });
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read"))).rejects.toThrow(/AGENT_UNAUTHORIZED/);
});

test("write credentials honor a membership downgrade after workspace ownership changes", async () => {
  const { t, owner, userId, workspace, args, authArgs } = await setup();
  const open = makeFunctionReference<"mutation", { tokenHash: string }, {
    workspacePublicId: string; scopes: string[];
  }>("agentCredentials:openMcpRequest");
  await owner.mutation(anyApi.agentCredentials.issue, { ...args, scopes: ["tasks:read", "tasks:write", "planning:preview", "planning:apply"] });
  expect(await t.mutation(open, { tokenHash: authArgs.tokenHash })).toEqual({
    workspacePublicId: workspace.publicId, scopes: ["tasks:read", "tasks:write", "planning:preview", "planning:apply"],
  });
  await t.run(async ({ db }) => {
    const nextOwnerId = await db.insert("users", {});
    const membership = await db.query("memberships").withIndex("by_workspace_user", q =>
      q.eq("workspaceId", workspace._id).eq("userId", userId)).unique();
    await db.patch(workspace._id, { ownerId: nextOwnerId });
    await db.patch(membership!._id, { role: "reader" });
  });
  for (const scope of ["planning:preview", "planning:apply"] as const) {
    await expect(t.run(({ db }) => authorizeAgent(db, authArgs, scope))).rejects.toThrow(/FORBIDDEN/);
  }
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:write"))).rejects.toThrow(/FORBIDDEN/);
  await expect(t.run(({ db }) => authorizeAgent(db, { ...authArgs, workspacePublicId: "foreign" }, "tasks:write")))
    .rejects.toThrow(/AGENT_UNAUTHORIZED/);
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read"))).resolves.toBeDefined();
  expect(await t.mutation(open, { tokenHash: authArgs.tokenHash })).toEqual({
    workspacePublicId: workspace.publicId, scopes: ["tasks:read"],
  });
});

test("authorization is limited across scopes by credential and resets after one minute", async () => {
  const { t, owner, args, authArgs } = await setup();
  await owner.mutation(anyApi.agentCredentials.issue, { ...args, scopes: ["tasks:read", "tasks:write"] });
  const secondHash = await hashAgentToken("klx_" + "de".repeat(32));
  await owner.mutation(anyApi.agentCredentials.issue, { ...args, tokenHash: secondHash });
  const charge = makeFunctionReference<"mutation", {
    tokenHash: string; workspacePublicId: string; scope: "tasks:read" | "tasks:write";
  }, { workspacePublicId: string }>("agentCredentials:chargeAgentRequest");
  for (let request = 0; request < 60; request++) {
    await t.mutation(charge, { ...authArgs, scope: request % 2 === 0 ? "tasks:read" : "tasks:write" });
  }
  await expect(t.mutation(charge, { ...authArgs, scope: "tasks:read" })).rejects.toThrow(/AGENT_RATE_LIMITED/);
  await expect(t.mutation(charge, { ...authArgs, tokenHash: secondHash, scope: "tasks:read" })).resolves
    .toEqual({ workspacePublicId: authArgs.workspacePublicId });
  await expect(t.run(({ db }) => authorizeAgent(db, authArgs, "tasks:read"))).resolves.toBeDefined();
  await t.run(async ({ db }) => {
    const row = await db.query("agentCredentials").withIndex("by_token_hash", q =>
      q.eq("tokenHash", authArgs.tokenHash)).unique();
    await db.patch(row!._id, { rateWindowStartedAt: Date.now() - 60_000 });
  });
  await expect(t.mutation(charge, { ...authArgs, scope: "tasks:read" })).resolves
    .toEqual({ workspacePublicId: authArgs.workspacePublicId });
});
