import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { observeOutcome } from "./observation.mjs";

const origin = "http://127.0.0.1:3210";
const observationMs = 12_000;
const taskList = document.createElement("ul");
taskList.setAttribute("aria-label", "Local provider tasks");
document.body.append(taskList);

let signInResult;
let result;
let started = false;
const fixture = {
  get signInResult() { return signInResult; },
  get result() { return result; },
  signIn() {
    void invoke("local_sign_in").then(status => {
      signInResult = status === "fixture-ready" ? status : "failed";
    }, () => { signInResult = "failed"; });
  },
  observe(expected) {
    if (started) return;
    started = true;
    void exercise(expected).then(report => { result = report; }, () => {
      result = { status: "failed", stage: "WebView observation" };
    });
  },
};
window.p0LocalProvider = fixture;

async function invoke(command, args) {
  return window.__TAURI__.core.invoke(command, args);
}

function renderTasks(tasks) {
  taskList.replaceChildren(...tasks.map(task => {
    const row = document.createElement("li");
    row.dataset.taskId = task._id;
    row.textContent = task.title;
    return row;
  }));
}

async function waitFor(predicate) {
  const deadline = performance.now() + observationMs;
  while (!predicate() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

async function exercise({ taskId, title }) {
  let stage = "native resume";
  let client;
  try {
    if (await invoke("local_resume") !== "authenticated") return { status: "failed", stage };
    stage = "native access";
    const bearer = await invoke("local_access", { forceRefresh: false });
    if (typeof bearer !== "string" || !bearer) return { status: "failed", stage };

    const http = new ConvexHttpClient(origin, {
      auth: bearer,
      logger: false,
      fetch: (input, options) => fetch(input, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(observationMs),
      }),
    });
    const hasTask = rows => rows.some(task => task._id === taskId && task.title === title);
    stage = "initial authenticated HTTP read";
    const [initialAuth, initialHttpRows] = await Promise.all([
      http.query(api.auth.isAuthenticated, {}),
      http.query(api.tasks.list, {}),
    ]);
    if (initialAuth !== true || !hasTask(initialHttpRows)) return { status: "failed", stage };

    stage = "initial authenticated subscription and render";
    client = new ConvexClient(origin, { logger: false, expectAuth: true, initialAuthTokenReuse: true });
    let forcedRefreshes = 0;
    let queryErrors = 0;
    let rows = [];
    let callbacks = 0;
    let revokeStarted;
    let emptyAt;
    client.setAuth(async ({ forceRefreshToken }) => {
      // The existing socket and HTTP client keep the same bearer for the observation.
      if (forceRefreshToken) forcedRefreshes++;
      return bearer;
    });
    client.onUpdate(api.tasks.list, {}, tasks => {
      rows = tasks;
      renderTasks(tasks);
      callbacks++;
      if (revokeStarted !== undefined && tasks.length === 0) emptyAt ??= performance.now();
    }, () => { queryErrors++; });

    function hasRenderedTask() {
      return [...taskList.children].some(row => row.dataset.taskId === taskId && row.textContent === title);
    }
    function matchesBearer() {
      return client.getAuth()?.token === bearer;
    }
    const ready = await waitFor(() => queryErrors > 0 ||
      (hasTask(rows) && hasRenderedTask() && client.connectionState().isWebSocketConnected && matchesBearer()));
    if (!ready || queryErrors > 0) return { status: "failed", stage };

    const before = client.connectionState();
    const expiryMs = Number(client.getAuth()?.decoded.exp) * 1_000;
    const initialSubscriptionRows = rows.length;
    const initialRenderedRows = taskList.children.length;
    const initialCallbacks = callbacks;
    const initialForcedRefreshes = forcedRefreshes;
    stage = "native revoke";
    revokeStarted = performance.now();
    if (await invoke("local_revoke") !== "revoked") return { status: "failed", stage };
    const revokeAcknowledged = performance.now();

    stage = "revocation observation";
    const [httpResult] = await Promise.all([
      Promise.all([http.query(api.auth.isAuthenticated, {}), http.query(api.tasks.list, {})])
        .then(([authenticated, tasks]) => ({ authenticated, rows: tasks.length }), () => null),
      waitFor(() => emptyAt !== undefined || queryErrors > 0 || !socketContinued() ||
        forcedRefreshes !== initialForcedRefreshes || !matchesBearer()),
    ]);

    function socketContinued() {
      const state = client.connectionState();
      return state.isWebSocketConnected && state.connectionCount === before.connectionCount;
    }

    const evidence = {
      uninterrupted: socketContinued(),
      sameBearer: matchesBearer(),
      bearerUnexpired: expiryMs > Date.now() + 5_000,
      forcedRefreshes: forcedRefreshes - initialForcedRefreshes,
      queryErrors,
      emptyCallback: emptyAt !== undefined,
      subscriptionRows: rows.length,
      renderedRows: taskList.children.length,
      httpAuthenticated: httpResult?.authenticated ?? null,
      httpRows: httpResult?.rows ?? null,
    };
    const sinceRevokeMs = instant => Math.round((instant - revokeStarted) / 100) * 100;
    return {
      status: observeOutcome(evidence),
      ...evidence,
      initialHttpRows: initialHttpRows.length,
      initialSubscriptionRows,
      initialRenderedRows,
      subscriptionUpdates: callbacks - initialCallbacks,
      nativeRevokeCompletedMs: sinceRevokeMs(revokeAcknowledged),
      emptyCallbackMs: emptyAt === undefined ? null : sinceRevokeMs(emptyAt),
    };
  } catch {
    return { status: "failed", stage };
  } finally {
    // The native slot can clear on revoke. Close the WebView socket only after measuring.
    await client?.close();
  }
}
