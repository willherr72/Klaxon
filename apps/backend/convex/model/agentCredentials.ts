import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authorize } from "./access";
import { oauthBindings, principalFields, samePrincipal } from "./agentBindings";

import { agentScopeNames, isWriteScope, type AgentScope } from "./agentScopes";
export { agentScope, type AgentScope } from "./agentScopes";

const oauthClaims = v.object({ ...principalFields, expiresAt: v.number(), scopes: v.array(v.string()) });
export const agentAuthArgs = { tokenHash: v.optional(v.string()), verifiedOAuth: v.optional(oauthClaims) };
export type AgentAuth = { tokenHash?: string; verifiedOAuth?: Infer<typeof oauthClaims> };
const TOKEN_HASH = /^[a-f0-9]{64}$/;
const REQUESTS_PER_WINDOW = 60;
const WINDOW_MS = 60_000;

export async function hashAgentToken(token: string) {
  if (!token.startsWith("klx_") || !isAgentTokenHash(token.slice(4))) {
    throw new ConvexError("AGENT_UNAUTHORIZED");
  }
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function isAgentTokenHash(value: string) {
  return value.length === 64 && TOKEN_HASH.test(value);
}

export function credentialMetadata(credential: Doc<"agentCredentials">) {
  return {
    publicId: credential.publicId,
    label: credential.label,
    scopes: credential.scopes,
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    createdAt: credential.createdAt,
  };
}

async function credentialFrom(db: QueryCtx["db"], { tokenHash, verifiedOAuth }: AgentAuth) {
  if (tokenHash !== undefined) {
    if (verifiedOAuth || !isAgentTokenHash(tokenHash)) return null;
    return db.query("agentCredentials").withIndex("by_token_hash", q => q.eq("tokenHash", tokenHash)).unique();
  }
  if (!verifiedOAuth || !Number.isSafeInteger(verifiedOAuth.expiresAt) || verifiedOAuth.expiresAt <= Date.now()) return null;
  const mapping = oauthBindings().find(entry => samePrincipal(entry, verifiedOAuth));
  if (!mapping) return null;
  const workspace = await db.query("workspaces").withIndex("by_public_id", q =>
    q.eq("publicId", mapping.workspacePublicId)).unique();
  if (!workspace) return null;
  const row = await db.query("agentCredentials").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspace._id).eq("publicId", mapping.credentialPublicId)).unique();
  return row && samePrincipal(row.oauthPrincipal, verifiedOAuth) ? row : null;
}

export async function authorizeAgent(db: QueryCtx["db"],
  auth: AgentAuth & { workspacePublicId?: string }, scope?: AgentScope) {
  const credential = await credentialFrom(db, auth);
  if (!credential || credential.revokedAt !== undefined || credential.expiresAt <= Date.now()) {
    throw new ConvexError("AGENT_UNAUTHORIZED");
  }
  const { workspaceId, userId } = credential;
  const { workspace, role } = await authorize(db, workspaceId, userId, "read").catch((error: unknown) => {
    if (error instanceof ConvexError && error.data === "WORKSPACE_UNAVAILABLE") {
      throw new ConvexError("AGENT_UNAUTHORIZED");
    }
    throw error;
  });
  if ((auth.workspacePublicId !== undefined && workspace.publicId !== auth.workspacePublicId) || !await db.get("users", userId)) {
    throw new ConvexError("AGENT_UNAUTHORIZED");
  }
  const scopes = agentScopeNames
    .filter(value => credential.scopes.includes(value) && (!isWriteScope(value) || role !== "reader") &&
      (!auth.verifiedOAuth || auth.verifiedOAuth.scopes.includes(value)));
  if (scope !== undefined && !scopes.includes(scope)) throw new ConvexError("FORBIDDEN");

  return { workspace, credential, workspaceId, userId, scopes, actor: { kind: "agent" as const, credentialId: credential._id } };
}

export async function chargeAgentQuota(db: MutationCtx["db"], credential: Doc<"agentCredentials">) {
  const now = Date.now();
  const windowStartedAt = credential.rateWindowStartedAt ?? now;
  const activeWindow = now < windowStartedAt + WINDOW_MS;
  const requestCount = activeWindow ? (credential.rateWindowRequests ?? 0) : 0;
  if (requestCount >= REQUESTS_PER_WINDOW) throw new ConvexError("AGENT_RATE_LIMITED");
  await db.patch("agentCredentials", credential._id, {
    rateWindowStartedAt: activeWindow ? windowStartedAt : now,
    rateWindowRequests: requestCount + 1,
  });
}
