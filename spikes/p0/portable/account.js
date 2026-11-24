import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

// No persistent tokens. A cold launch needs a fresh sign-in with an enrolled account.
export async function signIn(origin, username, password, events) {
  const http = new ConvexHttpClient(origin, {
    logger: false,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }),
  });
  const result = await http.mutation(api.auth.signInWithUsernamePassword, { username, password });
  if (result.status !== "complete") {
    throw new Error(result.userError?.error === "RATE_LIMITED"
      ? "Sign-in rate limit reached. Wait a minute and retry."
      : "Sign-in failed. Check the enrolled username and password.");
  }
  let tokens = result.tokens;
  let refreshing;
  let closing = false;
  http.setAuth(tokens.accessToken);
  const live = new ConvexClient(origin, { logger: false });
  const transport = live.subscribeToConnectionState(state => events.connected(state.isWebSocketConnected));
  events.connected(live.connectionState().isWebSocketConnected);

  async function rotate() {
    const rotated = await http.mutation(api.auth.refreshSession, { refreshToken: tokens.refreshToken });
    if (rotated.kind !== "rotated") {
      dispose();
      events.expired();
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
    closing = true;
    transport();
    http.clearAuth();
    tokens = undefined;
    void live.close();
  }
  live.setAuth(async ({ forceRefreshToken }) => {
    if (closing) return null;
    return forceRefreshToken ? refresh() : tokens.accessToken;
  }, authenticated => events.authenticated(authenticated));
  live.onUpdate(api.tasks.list, {}, events.rows, () => events.error("Task subscription failed. Read tasks to retry."));

  return {
    read: () => http.query(api.tasks.list, {}),
    create: title => http.mutation(api.tasks.create, { title }),
    rename: (id, title) => http.mutation(api.tasks.rename, { id, title }),
    async refresh() {
      if (!await refresh() || !await http.query(api.auth.isAuthenticated, {})) {
        throw new Error("Session expired. Sign in again.");
      }
    },
    async signOut() {
      closing = true;
      try {
        await refreshing;
        if (!tokens) return;
        await http.mutation(api.auth.signOut, { refreshToken: tokens.refreshToken });
      } catch {
        closing = false;
        throw new Error("Sign-out could not be confirmed. Reconnect and retry.");
      }
      dispose();
    },
  };
}
