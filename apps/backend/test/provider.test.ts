import { expect, test } from "vitest";
import * as auth from "../convex/auth";
import * as users from "../convex/users";

test("account enrollment and user creation are internal Convex mutations", () => {
  for (const mutation of [auth.enrollWithUsernamePassword, users.create]) {
    expect(mutation.isMutation).toBe(true);
    expect(mutation.isInternal).toBe(true);
  }
  expect(auth).not.toHaveProperty("signUpWithUsernamePassword");
});

test("clients can sign in, refresh, sign out, and check their session", () => {
  for (const mutation of [auth.signInWithUsernamePassword, auth.refreshSession, auth.signOut]) {
    expect(mutation.isMutation).toBe(true);
    expect(mutation.isPublic).toBe(true);
  }
  expect(auth.isAuthenticated.isQuery).toBe(true);
  expect(auth.isAuthenticated.isPublic).toBe(true);
});
