import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await getAuthUserId(ctx);
    if (!owner) return [];
    return ctx.db.query("tasks")
      .withIndex("by_owner", q => q.eq("owner", owner))
      .order("desc")
      .take(20);
  },
});

export const create = mutation({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const owner = await getAuthUserId(ctx);
    if (!owner) throw new Error("Sign in required");
    return ctx.db.insert("tasks", { owner, title });
  },
});

export const rename = mutation({
  args: { id: v.id("tasks"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const owner = await getAuthUserId(ctx);
    const task = await ctx.db.get("tasks", id);
    if (!owner || task?.owner !== owner) throw new Error("Task unavailable");
    await ctx.db.patch("tasks", id, { title });
  },
});
