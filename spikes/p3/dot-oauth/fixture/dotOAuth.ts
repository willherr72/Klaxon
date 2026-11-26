import { v } from "convex/values";
import { env, internalMutation } from "./_generated/server";
import { fixtureConfig, type FixtureConfig } from "./dotOAuth/config";
import { authDetails } from "./dotOAuth/tables";
import { requestedScopes } from "./dotOAuth/protocol";

const minute = 60_000;
const requestLifetime = 5 * minute;
const codeLifetime = 2 * minute;

function matches(config: FixtureConfig, value: {
  resource: string; clientId: string; callback?: string; scopes: string[]; approvedUntil?: number;
}) {
  return value.resource === config.resource && value.clientId === config.clientId &&
    (value.callback === undefined || value.callback === config.callback) &&
    (value.approvedUntil === undefined || value.approvedUntil === config.expiresAt) &&
    !!requestedScopes(value.scopes.join(" "), config);
}

export const begin = internalMutation({
  args: { ...authDetails, hash: v.string() },
  handler: async ({ db }, request) => {
    const config = fixtureConfig(env);
    if (!config || !matches(config, request)) return false;
    const now = Date.now();
    for (const entry of await db.query("dotOAuthRequests").withIndex("by_expiry", q => q.lte("expiresAt", now)).take(40)) {
      await db.delete("dotOAuthRequests", entry._id);
    }
    if ((await db.query("dotOAuthRequests").withIndex("by_expiry", q => q.gt("expiresAt", now)).take(40)).length >= 40) {
      return false;
    }
    await db.insert("dotOAuthRequests", { ...request, approvedUntil: config.expiresAt,
      expiresAt: Math.min(config.expiresAt, now + requestLifetime) });
    return true;
  },
});

export const agree = internalMutation({
  args: { nonceHash: v.string(), codeHash: v.string() },
  handler: async ({ db }, { nonceHash, codeHash }) => {
    const config = fixtureConfig(env);
    if (!config) return null;
    const row = await db.query("dotOAuthRequests").withIndex("by_hash", q => q.eq("hash", nonceHash)).unique();
    const now = Date.now();
    if (!row || row.expiresAt <= now || !matches(config, row)) return null;
    for (const grant of await db.query("dotOAuthGrants").withIndex("by_expiry", q => q.lte("expiresAt", now)).take(20)) {
      await db.delete("dotOAuthGrants", grant._id);
    }
    for (const family of await db.query("dotOAuthFamilies").withIndex("by_expiry", q => q.lte("expiresAt", now)).take(20)) {
      await db.delete("dotOAuthFamilies", family._id);
    }
    const { clientId, callback, resource, challenge, scopes, state, approvedUntil } = row;
    await db.delete("dotOAuthRequests", row._id);
    await db.insert("dotOAuthGrants", { kind: "code", hash: codeHash, clientId, callback, resource, challenge, scopes, approvedUntil,
      expiresAt: Math.min(config.expiresAt, now + codeLifetime) });
    return { callback, state };
  },
});

export const exchange = internalMutation({
  args: {
    kind: v.union(v.literal("code"), v.literal("refresh")), hash: v.string(), nextHash: v.string(),
    callback: v.optional(v.string()), challenge: v.optional(v.string()),
  },
  handler: async ({ db }, { kind, hash, nextHash, callback, challenge }) => {
    const config = fixtureConfig(env);
    if (!config) return null;
    const now = Date.now();
    const grant = await db.query("dotOAuthGrants").withIndex("by_hash", q => q.eq("hash", hash)).unique();
    if (!grant || grant.kind !== kind || grant.expiresAt <= now || !matches(config, grant)) return null;
    const { clientId, resource, scopes, approvedUntil } = grant;
    if (kind === "code") {
      if (callback === undefined || challenge === undefined || callback !== grant.callback || challenge !== grant.challenge) return null;
      await db.delete("dotOAuthGrants", grant._id);
      const refresh = config.refresh && scopes.includes("offline_access");
      if (refresh) {
        const expiresAt = config.expiresAt;
        const familyId = await db.insert("dotOAuthFamilies", { expiresAt });
        await db.insert("dotOAuthGrants", { kind: "refresh", hash: nextHash, expiresAt,
          clientId, resource, scopes, familyId, approvedUntil });
      }
      return { scopes, refresh };
    }
    if (!config.refresh || !grant.familyId) return null;
    const family = await db.get("dotOAuthFamilies", grant.familyId);
    if (!family || family.revokedAt !== undefined || family.expiresAt <= now) return null;
    if (grant.usedAt !== undefined) {
      await db.patch("dotOAuthFamilies", family._id, { revokedAt: now });
      return null;
    }
    await db.patch("dotOAuthGrants", grant._id, { usedAt: now });
    await db.insert("dotOAuthGrants", { kind: "refresh", hash: nextHash, clientId, resource, scopes,
      expiresAt: Math.min(config.expiresAt, family.expiresAt), familyId: family._id, approvedUntil });
    return { scopes, refresh: true };
  },
});

export const revoke = internalMutation({
  args: { hash: v.string() },
  handler: async ({ db }, { hash }) => {
    const config = fixtureConfig(env);
    if (!config) return;
    const grant = await db.query("dotOAuthGrants").withIndex("by_hash", q => q.eq("hash", hash)).unique();
    if (!grant || grant.kind !== "refresh" || !grant.familyId || !matches(config, grant)) return;
    const family = await db.get("dotOAuthFamilies", grant.familyId);
    if (family && family.revokedAt === undefined) await db.patch("dotOAuthFamilies", family._id, { revokedAt: Date.now() });
  },
});
