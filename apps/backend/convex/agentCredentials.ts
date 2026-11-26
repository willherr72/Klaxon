import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { agentAuthArgs, agentScope, authorizeAgent, chargeAgentQuota, credentialMetadata, isAgentTokenHash } from "./model/agentCredentials";
import { oauthBindings, oauthPrincipal, samePrincipal } from "./model/agentBindings";
import { boundedPage } from "./model/pagination";

const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// Charge before business logic so a rejected task operation still consumes quota.
export const chargeAgentRequest = internalMutation({
  args: { ...agentAuthArgs, workspacePublicId: v.optional(v.string()), scope: agentScope },
  handler: async (ctx, { scope, ...auth }) => {
    const { credential, workspace } = await authorizeAgent(ctx.db, auth, scope);
    await chargeAgentQuota(ctx.db, credential);
    return { workspacePublicId: workspace.publicId };
  },
});

export const openMcpRequest = internalMutation({
  args: agentAuthArgs,
  handler: async (ctx, auth) => {
    const { workspace, credential, scopes } = await authorizeAgent(ctx.db, auth);
    await chargeAgentQuota(ctx.db, credential);
    return { workspacePublicId: workspace.publicId, scopes };
  },
});

export const issue = mutation({
  args: {
    workspaceId: v.id("workspaces"), label: v.string(), scopes: v.array(agentScope),
    expiresAt: v.number(), tokenHash: v.string(),
  },
  handler: async (ctx, { workspaceId, label, scopes, expiresAt, tokenHash }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    await authorize(ctx.db, workspaceId, userId, "manage");
    const now = Date.now();
    const name = label.trim();
    if (!isAgentTokenHash(tokenHash) || !name || name.length > 100 || scopes.length < 1 ||
        new Set(scopes).size !== scopes.length || !Number.isSafeInteger(expiresAt)) {
      throw new ConvexError("INVALID_AGENT_CREDENTIAL");
    }
    const existing = await ctx.db.query("agentCredentials").withIndex("by_token_hash", q =>
      q.eq("tokenHash", tokenHash)).unique();
    if (existing) {
      if (existing.workspaceId !== workspaceId || existing.userId !== userId || existing.label !== name ||
          existing.expiresAt !== expiresAt || existing.scopes.length !== scopes.length ||
          !scopes.every(scope => existing.scopes.includes(scope))) {
        throw new ConvexError("AGENT_TOKEN_IN_USE");
      }
      return credentialMetadata(existing);
    }
    if (expiresAt <= now || expiresAt > now + MAX_LIFETIME_MS) {
      throw new ConvexError("INVALID_AGENT_CREDENTIAL");
    }
    const id = await ctx.db.insert("agentCredentials", {
      workspaceId, userId, publicId: crypto.randomUUID(), label: name, scopes, expiresAt, tokenHash,
      revision: 1, createdAt: now, updatedAt: now,
    });
    return credentialMetadata((await ctx.db.get("agentCredentials", id))!);
  },
});

export const list = query({
  args: { workspaceId: v.id("workspaces"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, paginationOpts }) => {
    const { workspace } = await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const page = await ctx.db.query("agentCredentials").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId)).paginate(boundedPage(paginationOpts));
    const mappings = oauthBindings().filter(entry => entry.workspacePublicId === workspace.publicId);
    return { ...page, page: page.page.map(row => {
      const metadata = credentialMetadata(row);
      const candidate = mappings.find(entry => entry.credentialPublicId === row.publicId);
      if (!candidate || row.revokedAt !== undefined || row.expiresAt <= Date.now()) return metadata;
      const { issuer, subject, clientId } = candidate;
      return { ...metadata, oauthCandidate: { issuer, subject, clientId }, oauthBindingAvailable: true,
        oauthBound: samePrincipal(row.oauthPrincipal, candidate) };
    }) };
  },
});

export const bindOAuth = mutation({
  args: { workspaceId: v.id("workspaces"), publicId: v.string(), expectedPrincipal: oauthPrincipal },
  handler: async (ctx, { workspaceId, publicId, expectedPrincipal }) => {
    const { workspace } = await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const row = await ctx.db.query("agentCredentials").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
    const mapping = oauthBindings().find(entry => entry.workspacePublicId === workspace.publicId && entry.credentialPublicId === publicId);
    if (!row || row.revokedAt !== undefined || row.expiresAt <= Date.now() || !samePrincipal(mapping, expectedPrincipal)) {
      throw new ConvexError("AGENT_BINDING_UNAVAILABLE");
    }
    if (!samePrincipal(row.oauthPrincipal, expectedPrincipal)) {
      await ctx.db.patch("agentCredentials", row._id, { oauthPrincipal: expectedPrincipal, revision: row.revision + 1, updatedAt: Date.now() });
    }
    return { publicId, oauthBound: true };
  },
});

export const revoke = mutation({
  args: { workspaceId: v.id("workspaces"), publicId: v.string() },
  handler: async (ctx, { workspaceId, publicId }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "manage");
    const credential = await ctx.db.query("agentCredentials").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
    if (!credential) throw new ConvexError("AGENT_CREDENTIAL_UNAVAILABLE");
    if (credential.revokedAt !== undefined) return credentialMetadata(credential);
    const revokedAt = Date.now();
    await ctx.db.patch("agentCredentials", credential._id, {
      revokedAt, updatedAt: revokedAt, revision: credential.revision + 1,
    });
    return credentialMetadata({ ...credential, revokedAt });
  },
});
