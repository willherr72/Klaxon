import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";

export const create = internalMutation({
  args: { method: v.object({ name: v.literal("usernamePassword"), profile: v.object({}) }) },
  returns: v.id("users"),
  handler: async (ctx) => {
    const local = process.env.CONVEX_CLOUD_URL === "http://127.0.0.1:3210";
    if (!local && !await ctx.db.query("fixtureEnrollments").unique()) {
      throw new ConvexError("P0_ENROLLMENT_REQUIRED");
    }
    return ctx.db.insert("users", {});
  },
});
