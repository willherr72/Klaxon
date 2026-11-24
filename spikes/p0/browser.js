import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { mount } from "svelte";
import { writable } from "svelte/store";
import TaskList from "./TaskList.svelte";

const endpoint = "http://127.0.0.1:3210";
const http = new ConvexHttpClient(endpoint);
const live = new ConvexClient(endpoint);
let tokens;
let unsubscribe;
const tasks = writable([]);
mount(TaskList, { target: document.body, props: { tasks } });

window.probe = {
  async login(credentials, signup) {
    const method = signup ? api.auth.signUpWithUsernamePassword : api.auth.signInWithUsernamePassword;
    const result = await http.mutation(method, credentials);
    if (result.status !== "complete") throw new Error("Login failed");
    tokens = result.tokens;
    http.setAuth(tokens.accessToken);
    live.setAuth(async () => tokens?.accessToken ?? null);
    unsubscribe = live.onUpdate(api.tasks.list, {}, rows => tasks.set(rows));
    return http.query(api.auth.isAuthenticated, {});
  },
  async refresh() {
    const previous = tokens.refreshToken;
    const result = await http.mutation(api.auth.refreshSession, { refreshToken: previous });
    if (result.kind !== "rotated") return false;
    tokens = result.tokens;
    http.setAuth(tokens.accessToken);
    live.setAuth(async () => tokens.accessToken);
    return previous !== tokens.refreshToken && await http.query(api.auth.isAuthenticated, {});
  },
  create: title => http.mutation(api.tasks.create, { title }),
  list: () => http.query(api.tasks.list, {}),
  rename: (id, title) => http.mutation(api.tasks.rename, { id, title }),
  async logout() {
    const refreshToken = tokens.refreshToken;
    await http.mutation(api.auth.signOut, { refreshToken });
    const revoked = !await http.query(api.auth.isAuthenticated, {});
    const result = await http.mutation(api.auth.refreshSession, { refreshToken });
    http.clearAuth();
    unsubscribe();
    await live.close();
    tokens = undefined;
    tasks.set([]);
    return revoked && result.kind === "noSession";
  },
};
