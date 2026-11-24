import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { mount } from "svelte";
import { writable } from "svelte/store";
import TaskList from "./TaskList.svelte";

const endpoint = P0_BACKEND_ORIGIN;
const http = new ConvexHttpClient(endpoint);
const sessionClient = new ConvexHttpClient(endpoint);
const live = new ConvexClient(endpoint);
let tokens;
let unsubscribe;
let refreshInFlight;
const tasks = writable([]);
mount(TaskList, { target: document.body, props: { tasks } });

async function rotateTokens() {
  const previous = tokens.refreshToken;
  const result = await sessionClient.mutation(api.auth.refreshSession, { refreshToken: previous });
  if (result.kind !== "rotated") return false;
  tokens = result.tokens;
  http.setAuth(tokens.accessToken);
  return previous !== tokens.refreshToken;
}

function refreshTokens() {
  refreshInFlight ??= rotateTokens().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

window.probe = {
  async anonymousSignupDenied(credentials) {
    try {
      await new ConvexHttpClient(endpoint).mutation(api.auth.signUpWithUsernamePassword, credentials);
    } catch (error) {
      if (error.data === "P0_ENROLLMENT_REQUIRED" || /\bP0_ENROLLMENT_REQUIRED\b/.test(error.message)) return true;
      throw error;
    }
    return false;
  },
  async login(credentials, signup) {
    const method = signup ? api.auth.signUpWithUsernamePassword : api.auth.signInWithUsernamePassword;
    let result = await http.mutation(method, credentials);
    if (result.userError?.error === "RATE_LIMITED" && result.userError.retryAfterMs <= 61000) {
      await new Promise(resolve => setTimeout(resolve, result.userError.retryAfterMs + 100));
      result = await http.mutation(method, credentials);
    }
    if (result.status !== "complete") throw new Error("Login failed: " + result.userError.error);
    tokens = result.tokens;
    http.setAuth(tokens.accessToken);
    live.setAuth(async ({ forceRefreshToken }) => {
      if (forceRefreshToken && !await refreshTokens()) return null;
      return tokens?.accessToken ?? null;
    });
    unsubscribe = live.onUpdate(api.tasks.list, {}, rows => tasks.set(rows));
    return http.query(api.auth.isAuthenticated, {});
  },
  async refresh() {
    return await refreshTokens() && await http.query(api.auth.isAuthenticated, {});
  },
  create: title => http.mutation(api.tasks.create, { title }),
  list: () => http.query(api.tasks.list, {}),
  rename: (id, title) => http.mutation(api.tasks.rename, { id, title }),
  async logout() {
    unsubscribe();
    await live.close();
    await refreshInFlight;
    const refreshToken = tokens.refreshToken;
    await sessionClient.mutation(api.auth.signOut, { refreshToken });
    const revoked = !await http.query(api.auth.isAuthenticated, {});
    const result = await sessionClient.mutation(api.auth.refreshSession, { refreshToken });
    http.clearAuth();
    tokens = undefined;
    tasks.set([]);
    return revoked && result.kind === "noSession";
  },
};
