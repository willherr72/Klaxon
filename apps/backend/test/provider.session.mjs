import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { withLocalProvider } from "./provider.local.mjs";

const enroll = "auth:enrollWithUsernamePassword";
const signIn = "auth:signInWithUsernamePassword";
const refresh = "auth:refreshSession";
const signOut = "auth:signOut";
const authenticated = "auth:isAuthenticated";
const ensurePersonal = "workspaces:ensurePersonal";
const listTasks = "tasks:list";

function clientFor(url, auth) {
  return new ConvexHttpClient(url, { auth, logger: false });
}

function account() {
  return {
    username: `p1-${randomBytes(12).toString("hex")}`,
    password: randomBytes(24).toString("base64url"),
  };
}

async function call(label, action) {
  try {
    return await action();
  } catch {
    throw new Error(`${label} failed`);
  }
}

async function denied(label, action, code) {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    const data = error?.data;
    rejected = code === undefined || data === code || data?.error === code;
  }
  assert.ok(rejected, `${label} must be denied${code ? ` with ${code}` : ""}`);
}

function expectGrant(tokens, userId) {
  assert.ok(tokens?.userId === userId, "Grant belongs to the same user");
  const { accessToken, refreshToken, refreshTokenExpiresAt } = tokens;
  assert.ok(typeof accessToken === "string" && accessToken.length > 0, "Grant has an access token");
  assert.ok(typeof refreshToken === "string" && refreshToken.length > 0, "Grant has a refresh token");
  assert.ok(Number.isFinite(refreshTokenExpiresAt) && refreshTokenExpiresAt > Date.now(), "Grant has a future expiry");
  return tokens;
}

test("operator enrollment, rotating sessions, revocation, and workspace reads on local Convex", { timeout: 240_000 }, async () => {
  await withLocalProvider(async ({ url, adminKey }) => {
    const admin = clientFor(url);
    admin.setAdminAuth(adminKey);
    const anonymous = clientFor(url);
    const first = account();
    const second = account();
    const query = (client, path, args = {}) => client.query(makeFunctionReference(path), args);
    const mutate = (client, path, args = {}) => client.mutation(makeFunctionReference(path), args);
    const isAuthenticated = client => call("Session check", () => query(client, authenticated));
    const taskArgs = workspaceId => ({
      workspaceId,
      filter: { kind: "status", status: "inbox" },
      paginationOpts: { cursor: null, numItems: 8 },
    });

    assert.equal(await isAuthenticated(anonymous), false);
    await denied("Anonymous enrollment", () => mutate(anonymous, enroll, first));
    await denied("Public signup", () => mutate(anonymous, "auth:signUpWithUsernamePassword", first));
    await denied("Public user creation", () => mutate(anonymous, "users:create", {
      method: { name: "usernamePassword", profile: {} },
    }));
    await denied("Weak password enrollment", () => admin.function(enroll, undefined, {
      ...first, password: "short",
    }), "PASSWORD_TOO_SHORT");

    const firstId = await call("Operator enrollment A", () => admin.function(enroll, undefined, first));
    const secondId = await call("Operator enrollment B", () => admin.function(enroll, undefined, second));
    assert.ok(typeof firstId === "string" && typeof secondId === "string" && firstId !== secondId,
      "Enrollment returns two distinct app user IDs");
    await denied("Duplicate enrollment", () => admin.function(enroll, undefined, {
      ...first, password: account().password,
    }), "USERNAME_TAKEN");
    for (const userId of [firstId, secondId]) {
      const sessions = await call("Inspect enrollment sessions", () => admin.function("public:listSessions", "auth", { userId }));
      assert.ok(Array.isArray(sessions) && sessions.length === 0, "Operator enrollment leaves no session");
    }

    const wrong = await call("Wrong-password sign-in", () => mutate(anonymous, signIn, {
      ...first, password: second.password,
    }));
    assert.ok(wrong?.status === "error" && wrong.userError?.error === "INVALID_CREDENTIALS", "Wrong password cannot sign in");
    const unknown = await call("Unknown-user sign-in", () => mutate(anonymous, signIn, account()));
    assert.ok(unknown?.status === "error" && unknown.userError?.error === "INVALID_CREDENTIALS",
      "Public sign-in returns the same credential error for an unknown username");
    const signInAs = async (credentials, userId) => {
      const result = await call("Password sign-in", () => mutate(anonymous, signIn, credentials));
      assert.ok(result?.status === "complete", "Sign-in completes");
      return expectGrant(result.tokens, userId);
    };
    const original = await signInAs(first, firstId);
    const control = await signInAs(second, secondId);
    const clientA = clientFor(url, original.accessToken);
    const clientB = clientFor(url, control.accessToken);
    assert.equal(await isAuthenticated(clientA), true);
    assert.equal(await isAuthenticated(clientB), true);
    await denied("Signed-in enrollment", () => mutate(clientA, enroll, account()));

    const workspaceA = await call("Bootstrap workspace A", () => mutate(clientA, ensurePersonal));
    const workspaceB = await call("Bootstrap workspace B", () => mutate(clientB, ensurePersonal));
    assert.ok(workspaceA.ownerId === firstId && workspaceB.ownerId === secondId && workspaceA._id !== workspaceB._id,
      "Each user bootstraps a distinct workspace they own");
    for (const [client, workspace] of [[clientA, workspaceA], [clientB, workspaceB]]) {
      const own = await call("Owner task read", () => query(client, listTasks, taskArgs(workspace._id)));
      assert.deepEqual(own.page, []);
    }
    await denied("Cross-workspace task read", () => query(clientB, listTasks, taskArgs(workspaceA._id)), "WORKSPACE_UNAVAILABLE");
    await denied("Anonymous task read", () => query(anonymous, listTasks, taskArgs(workspaceA._id)), "UNAUTHENTICATED");

    const rotate = token => call("Refresh session", () => mutate(anonymous, refresh, { refreshToken: token }));
    const rotateGrant = async token => {
      const result = await rotate(token);
      assert.ok(result?.kind === "rotated", "Refresh returns a rotated grant");
      return expectGrant(result.tokens, firstId);
    };
    const renewed = await rotateGrant(original.refreshToken);
    assert.ok(renewed.refreshToken !== original.refreshToken, "Refresh rotates the token");
    const retried = await rotateGrant(original.refreshToken);
    assert.ok(retried.refreshToken !== renewed.refreshToken && retried.refreshToken !== original.refreshToken,
      "Retry issues a separate successor");
    const latest = await rotateGrant(retried.refreshToken);
    assert.ok(latest.refreshToken !== retried.refreshToken, "The retry successor can refresh");
    const refreshedClient = clientFor(url, latest.accessToken);
    assert.equal(await isAuthenticated(refreshedClient), true);
    const refreshedTasks = await call("Refreshed owner read", () => query(refreshedClient, listTasks, taskArgs(workspaceA._id)));
    assert.deepEqual(refreshedTasks.page, []);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await call("Sign-out", () => mutate(anonymous, signOut, { refreshToken: latest.refreshToken })), null);
    }
    const revoked = await rotate(latest.refreshToken);
    assert.ok(revoked?.kind === "noSession" && !Object.hasOwn(revoked, "tokens"),
      "A revoked refresh token returns no session or grant");
    assert.equal(await isAuthenticated(refreshedClient), false);
    assert.equal(await isAuthenticated(clientA), false);
    await denied("Revoked task read", () => query(refreshedClient, listTasks, taskArgs(workspaceA._id)), "UNAUTHENTICATED");
    assert.equal(await isAuthenticated(clientB), true);
  });
});
