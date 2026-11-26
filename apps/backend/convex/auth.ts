import { setupUsernamePassword, type SignInResult } from "@convex-dev/auth/methods/username-password/server";
import { setupConvexAuth } from "@convex-dev/auth/server";
import type { RegisteredMutation } from "convex/server";
import { ConvexError, v } from "convex/values";
import { api, components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";

const auth = setupConvexAuth({ component: components.auth });
export const { signOut, refreshSession, isAuthenticated } = auth;

const passwordAuth = setupUsernamePassword(auth, {
  component: components.authPassword,
  usernameComponent: components.authUsername,
}).attachUserCallbacks({ createUser: internal.users.create });

const credentialsArgs = { username: v.string(), password: v.string() };
type Credentials = { username: string; password: string };

// Convex 1.51 exposes this hook on registered mutations at runtime. Keep the
// version dependency here so signup stays internal and public errors are uniform.
function passwordHandler<T>(registered: RegisteredMutation<"public", Credentials, Promise<T>>) {
  return (registered as typeof registered & { _handler(ctx: MutationCtx, args: Credentials): Promise<T> })._handler;
}

export const signInWithUsernamePassword = mutation({
  args: credentialsArgs,
  handler: async (ctx, credentials): Promise<SignInResult> => {
    const result = await passwordHandler(passwordAuth.signInWithUsernamePassword)(ctx, credentials);
    if (result.status === "error") return { status: "error", userError: { error: "INVALID_CREDENTIALS" } };
    return result;
  },
});

export const enrollWithUsernamePassword = internalMutation({
  args: credentialsArgs,
  returns: v.id("users"),
  handler: async (ctx, credentials): Promise<Id<"users">> => {
    const result = await passwordHandler(passwordAuth.signUpWithUsernamePassword)(ctx, credentials);
    if (result.status === "error") throw new ConvexError(result.userError);

    const userId = ctx.db.normalizeId("users", result.tokens.userId);
    if (userId === null) throw new Error("Enrollment returned an invalid user ID");
    // The operator receives an ID. Revoke the signup session in the same transaction.
    await ctx.runMutation(api.auth.signOut, { refreshToken: result.tokens.refreshToken });
    return userId;
  },
});
