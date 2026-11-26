import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const create = internalMutation({
  args: { method: v.object({ name: v.literal("usernamePassword"), profile: v.object({}) }) },
  returns: v.id("users"),
  handler: ctx => ctx.db.insert("users", {}),
});
