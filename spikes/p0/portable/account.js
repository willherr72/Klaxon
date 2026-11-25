import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

// The pinned SDK unwraps the mutation envelope. Check the Auth 2.1.0 value
// before either the HTTP client or the socket can use the returned grant.
function hasFields(value, ...fields) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

function validGrant(tokens) {
  if (!hasFields(tokens, "accessToken", "refreshToken", "refreshTokenExpiresAt", "userId")) return false;
  const nonblank = value => typeof value === "string" && value.trim().length > 0;
  return nonblank(tokens.userId) && nonblank(tokens.accessToken) && nonblank(tokens.refreshToken) &&
    Number.isFinite(tokens.refreshTokenExpiresAt) && tokens.refreshTokenExpiresAt > 0;
}

// No persistent tokens. A cold launch needs a fresh sign-in with an enrolled account.
export async function signIn(origin, username, password, events) {
  const options = {
    logger: false,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
  };
  const sessionClient = new ConvexHttpClient(origin, options);
  let result;
  try {
    result = await sessionClient.mutation(api.auth.signInWithUsernamePassword, { username, password });
  } catch {
    throw new Error("Could not reach the sign-in service. Check connectivity and retry.");
  }
  if (result?.status === "error") {
    throw new Error(result.userError?.error === "RATE_LIMITED"
      ? "Sign-in rate limit reached. Wait a minute and retry."
      : "Sign-in failed. Check the enrolled username and password.");
  }
  if (!hasFields(result, "status", "tokens") || result.status !== "complete" || !validGrant(result.tokens)) {
    throw new Error("Sign-in could not be confirmed. Try again.");
  }
  let tokens = result.tokens;
  let refreshing;
  let closing = false;
  let disposed = false;
  const http = new ConvexHttpClient(origin, options);
  http.setAuth(tokens.accessToken);
  const live = new ConvexClient(origin, { logger: false });
  const connectionState = () => live.connectionState();
  const publishConnection = state => {
    if (!disposed) events.connection(state);
  };
  const transport = live.subscribeToConnectionState(publishConnection);
  publishConnection(connectionState());

  async function rotate() {
    const rotated = await sessionClient.mutation(api.auth.refreshSession, { refreshToken: tokens.refreshToken });
    if (disposed) return null;
    if (hasFields(rotated, "kind") && rotated.kind === "noSession") {
      expire();
      return null;
    }
    if (!hasFields(rotated, "kind", "tokens") || rotated.kind !== "rotated" ||
        !validGrant(rotated.tokens) || rotated.tokens.userId !== tokens.userId ||
        rotated.tokens.refreshToken === tokens.refreshToken) {
      throw new Error("Invalid refresh response");
    }
    tokens = rotated.tokens;
    http.setAuth(tokens.accessToken);
    return tokens.accessToken;
  }
  function refresh() {
    refreshing ??= rotate().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    closing = true;
    transport();
    http.clearAuth();
    tokens = undefined;
    void live.close();
  }
  function expire(message = "Session expired. Sign in again.") {
    if (disposed) return;
    dispose();
    events.expired(message);
  }
  async function fetchToken({ forceRefreshToken }) {
    if (closing) return null;
    if (!forceRefreshToken) return tokens.accessToken;
    try { return await refresh(); }
    catch {
      // Convex pauses the socket while awaiting this callback. Always settle it.
      if (!closing) expire("Session refresh could not be confirmed. Reconnect and sign in again.");
      return null;
    }
  }
  function authChanged(authenticated) {
    if (disposed) return;
    // A null token while sign-out owns revocation is local, not a server denial.
    if (!authenticated && !closing) expire();
    else events.authenticated(authenticated);
  }
  live.setAuth(fetchToken, authChanged);
  live.onUpdate(api.tasks.list, {}, rows => {
    if (disposed) return;
    publishConnection(connectionState());
    events.rows(rows);
  },
    () => { if (!disposed) events.error("Task subscription failed. Read tasks to retry."); });

  return {
    connectionState,
    read: () => http.query(api.tasks.list, {}),
    create: title => http.mutation(api.tasks.create, { title }),
    rename: (id, title) => http.mutation(api.tasks.rename, { id, title }),
    async refresh() {
      try {
        if (!await refresh()) return;
        const confirmed = await http.query(api.auth.isAuthenticated, {});
        if (confirmed === false) expire();
        else if (confirmed !== true) throw new Error("Invalid authentication confirmation");
      } catch {
        throw new Error("Session refresh could not be confirmed. Retry or sign out.");
      }
    },
    async signOut() {
      closing = true;
      try {
        await refreshing;
        if (!tokens) return;
        const acknowledgment = await sessionClient.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
        if (acknowledgment !== null) throw new Error("Invalid sign-out acknowledgment");
      } catch {
        closing = false;
        if (!disposed) live.setAuth(fetchToken, authChanged);
        throw new Error("Sign-out could not be confirmed. Reconnect and retry.");
      }
      dispose();
    },
  };
}
