import { v } from "convex/values";
import { api } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const enroll = internalMutation({
  args: { username: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, credentials): Promise<null> => {
    // Nested mutations share this transaction. Concurrent signups never
    // observe the marker because it is removed before the transaction commits.
    const marker = await ctx.db.insert("fixtureEnrollments", {});
    const result = await ctx.runMutation(api.auth.signUpWithUsernamePassword, credentials);
    if (result.status !== "complete") {
      throw new Error("Could not enroll synthetic user");
    }
    await ctx.runMutation(api.auth.signOut, { refreshToken: result.tokens.refreshToken });
    await ctx.db.delete("fixtureEnrollments", marker);
    return null;
  },
});
