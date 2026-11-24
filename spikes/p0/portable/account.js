import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

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
  if (result.status !== "complete") {
    throw new Error(result.userError?.error === "RATE_LIMITED"
      ? "Sign-in rate limit reached. Wait a minute and retry."
      : "Sign-in failed. Check the enrolled username and password.");
  }
  let tokens = result.tokens;
  let refreshing;
  let closing = false;
  let disposed = false;
  const http = new ConvexHttpClient(origin, options);
  http.setAuth(tokens.accessToken);
  const live = new ConvexClient(origin, { logger: false });
  const transport = live.subscribeToConnectionState(state => {
    if (!disposed) events.connected(state.isWebSocketConnected);
  });
  events.connected(live.connectionState().isWebSocketConnected);

  async function rotate() {
    const rotated = await sessionClient.mutation(api.auth.refreshSession, { refreshToken: tokens.refreshToken });
    if (disposed) return null;
    if (rotated.kind !== "rotated") {
      expire();
      return null;
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
  live.onUpdate(api.tasks.list, {}, rows => { if (!disposed) events.rows(rows); },
    () => { if (!disposed) events.error("Task subscription failed. Read tasks to retry."); });

  return {
    read: () => http.query(api.tasks.list, {}),
    create: title => http.mutation(api.tasks.create, { title }),
    rename: (id, title) => http.mutation(api.tasks.rename, { id, title }),
    async refresh() {
      if (!await refresh()) return;
      if (!await http.query(api.auth.isAuthenticated, {})) expire();
    },
    async signOut() {
      closing = true;
      try {
        await refreshing;
        if (!tokens) return;
        await sessionClient.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
      } catch {
        closing = false;
        if (!disposed) live.setAuth(fetchToken, authChanged);
        throw new Error("Sign-out could not be confirmed. Reconnect and retry.");
      }
      dispose();
    },
  };
}
