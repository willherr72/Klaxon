import { defineTable } from "convex/server";
import { v } from "convex/values";

export const authDetails = {
  clientId: v.string(), callback: v.string(), resource: v.string(), challenge: v.string(),
  scopes: v.array(v.string()), state: v.string(),
};

export const dotOAuthTables = {
  dotOAuthRequests: defineTable({ ...authDetails, hash: v.string(), expiresAt: v.number(), approvedUntil: v.number() })
    .index("by_hash", ["hash"]).index("by_expiry", ["expiresAt"]),
  dotOAuthGrants: defineTable({
    kind: v.union(v.literal("code"), v.literal("refresh")), hash: v.string(), expiresAt: v.number(),
    usedAt: v.optional(v.number()), approvedUntil: v.number(),
    clientId: v.string(), resource: v.string(), scopes: v.array(v.string()),
    callback: v.optional(v.string()), challenge: v.optional(v.string()), familyId: v.optional(v.id("dotOAuthFamilies")),
  }).index("by_hash", ["hash"]).index("by_expiry", ["expiresAt"]),
  dotOAuthFamilies: defineTable({ expiresAt: v.number(), revokedAt: v.optional(v.number()) })
    .index("by_expiry", ["expiresAt"]),
};
