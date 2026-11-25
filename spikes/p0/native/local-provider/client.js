import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { createSubscriptionGate, isCachedBearerRenameDenied, observeOutcome, subscriptionOrigin } from "./observation.mjs";
import { observeRunningRenewal } from "./renewal-observation.mjs";

const origin = typeof P0_PROVIDER_ORIGIN === "string" ? P0_PROVIDER_ORIGIN : "http://127.0.0.1:3210";
const observationMs = 12_000;
const reconnectFollowUpMs = 1_000;
const taskList = document.createElement("ul");
taskList.setAttribute("aria-label", "Local provider tasks");
document.body.append(taskList);

let signInResult;
let result;
let renewalProgress;
let renewalResult;
let started = false;
const fixture = {
  get origin() { return origin; },
  hostedProbeVersion: 1,
  get signInResult() { return signInResult; },
  get result() { return result; },
  get renewalProgress() { return renewalProgress; },
  get renewalResult() { return renewalResult; },
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
  observeRenewal({ taskId, title, renewedTitle }) {
    if (started) return;
    started = true;
    const reportProgress = phase => { renewalProgress = { phase }; };
    reportProgress("initial");
    void observeRunningRenewal({
      origin, taskId, title, renewedTitle, invoke, renderTasks, waitFor, reportProgress,
      renderedTask: expectedTitle => hasRenderedTask(taskId, expectedTitle),
      renderedRows: () => taskList.children.length,
    }).then(report => { renewalResult = report; }, () => {
      renewalResult = { status: "failed", stage: "WebView renewal observation" };
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

function hasRenderedTask(taskId, title) {
  return [...taskList.children].some(row => row.dataset.taskId === taskId && row.textContent === title);
}

async function waitFor(predicate, timeoutMs = observationMs) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate() && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return predicate();
}

async function exercise({ taskId, title, reconnectPort, hostedReconnect, hostedProbeTitle }) {
  let stage = "native resume";
  let client;
  try {
    const reconnect = hostedReconnect || reconnectPort !== undefined;
    const gate = hostedReconnect && origin.startsWith("https:") ? createSubscriptionGate(WebSocket) : undefined;
    let socketOrigin = origin;
    if (reconnect) {
      stage = "reconnect transport configuration";
      socketOrigin = subscriptionOrigin(origin, reconnectPort);
      if ((hostedReconnect && !gate) || (!gate && typeof window.p0DisconnectTransport !== "function") ||
          typeof window.p0RestoreTransport !== "function") {
        return { status: "failed", stage };
      }
      stage = "native resume";
    }
    if (await invoke("local_resume") !== "authenticated") return { status: "failed", stage };
    stage = "native access";
    const bearer = await invoke("local_access", { forceRefresh: false });
    if (typeof bearer !== "string" || !bearer) return { status: "failed", stage };

    let renameResponseStatus;
    let renameEnvelopeStatus;
    const http = new ConvexHttpClient(origin, {
      auth: bearer,
      logger: false,
      fetch: async (input, options) => {
        const response = await fetch(input, {
          ...options,
          redirect: "error",
          signal: AbortSignal.timeout(observationMs),
        });
        if (reconnect && input === `${origin}/api/mutation`) {
          renameResponseStatus = response.status;
          renameEnvelopeStatus = (await response.clone().json()).status;
        }
        return response;
      },
    });
    const hasTask = rows => rows.some(task => task._id === taskId && task.title === title);
    stage = "initial authenticated HTTP read";
    const [initialAuth, initialHttpRows] = await Promise.all([
      http.query(api.auth.isAuthenticated, {}),
      http.query(api.tasks.list, {}),
    ]);
    if (initialAuth !== true || !hasTask(initialHttpRows)) return { status: "failed", stage };

    stage = "initial authenticated subscription and render";
    client = new ConvexClient(socketOrigin, {
      logger: false, expectAuth: true, initialAuthTokenReuse: true,
      ...(gate && { webSocketConstructor: gate.WebSocket }),
    });
    let forcedRefreshes = 0;
    let queryErrors = 0;
    let rows = [];
    let callbacks = 0;
    let revokeStarted;
    let emptyAt;
    let restoreStarted;
    let emptyAfterRestoreAt;
    let emptyCallbackConnection;
    let postRestoreNonemptyCallbacks = 0;
    let postClearNonemptyCallbacks = 0;
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
      if (restoreStarted !== undefined && socketReconnected()) {
        if (tasks.length === 0) {
          emptyAfterRestoreAt ??= performance.now();
          emptyCallbackConnection = client.connectionState().connectionCount;
        }
        else postRestoreNonemptyCallbacks++;
      }
      if (emptyAfterRestoreAt !== undefined && tasks.length > 0) postClearNonemptyCallbacks++;
    }, () => { queryErrors++; });

    function matchesBearer() {
      return client.getAuth()?.token === bearer;
    }
    const ready = await waitFor(() => queryErrors > 0 ||
      (hasTask(rows) && hasRenderedTask(taskId, title) && client.connectionState().isWebSocketConnected && matchesBearer()));
    if (!ready || queryErrors > 0) return { status: "failed", stage };

    const before = client.connectionState();
    const expiryMs = Number(client.getAuth()?.decoded.exp) * 1_000;
    const initialSubscriptionRows = rows.length;
    const initialRenderedRows = taskList.children.length;
    const initialCallbacks = callbacks;
    const initialForcedRefreshes = forcedRefreshes;
    function socketContinued() {
      const state = client.connectionState();
      return state.isWebSocketConnected && state.connectionCount === before.connectionCount;
    }
    function socketOffline() {
      const state = client.connectionState();
      return !state.isWebSocketConnected && state.connectionCount === before.connectionCount;
    }
    function socketReconnected() {
      const state = client.connectionState();
      return state.isWebSocketConnected && state.connectionCount > before.connectionCount;
    }

    let offlineEvidence;
    if (reconnect) {
      stage = "disconnect subscription transport";
      if (gate) gate.disconnect();
      else await window.p0DisconnectTransport();
      if (!await waitFor(socketOffline)) return { status: "failed", stage };
      offlineEvidence = {
        disconnectedBeforeRevoke: true,
        cachedBeforeRevoke: hasTask(rows),
        renderedBeforeRevoke: hasRenderedTask(taskId, title),
      };
    }
    stage = "native revoke";
    revokeStarted = performance.now();
    // The native command acknowledges sign-out only after verifying the exact refresh grant is gone.
    if (await invoke("local_revoke") !== "revoked") return { status: "failed", stage };
    const revokeAcknowledged = performance.now();

    if (reconnect) {
      stage = "confirm transport stayed offline during revoke";
      if (!socketOffline()) return { status: "failed", stage };
      Object.assign(offlineEvidence, {
        nativeRevoked: true,
        disconnectedAfterRevoke: true,
        cachedAfterRevoke: hasTask(rows),
        staleWhileOffline: hasRenderedTask(taskId, title),
      });
      stage = "restore subscription transport";
      // A server update can arrive as soon as the host opens the relay.
      restoreStarted = performance.now();
      await window.p0RestoreTransport();
      gate?.restore();
      stage = "wait for the new subscription connection";
      if (!await waitFor(socketReconnected)) return { status: "inconclusive", stage };
    }

    stage = "revocation observation";
    const [httpResult, staleBearerRenameOutcome] = await Promise.all([
      Promise.all([http.query(api.auth.isAuthenticated, {}), http.query(api.tasks.list, {})])
        .then(([authenticated, tasks]) => ({ authenticated, rows: tasks.length }), () => null),
      reconnect ? checkCachedBearerRename() : null,
      reconnect ? waitForReconnectedSubscription() :
        waitFor(() => emptyAt !== undefined || queryErrors > 0 || !socketContinued() ||
          forcedRefreshes !== initialForcedRefreshes || !matchesBearer()),
    ]);

    async function checkCachedBearerRename() {
      let probeTitle = hostedProbeTitle;
      if (!hostedReconnect) {
        probeTitle = title === "Revoked session rename probe" ? "Unexpected revoked session write" :
          "Revoked session rename probe";
      }
      if (typeof probeTitle !== "string" || probeTitle === title) return "unexpected-error";
      try {
        await http.mutation(api.tasks.rename, { id: taskId, title: probeTitle });
        return "succeeded";
      } catch (error) {
        return isCachedBearerRenameDenied(renameResponseStatus, renameEnvelopeStatus, error) ? "denied" : "unexpected-error";
      }
    }

    async function waitForReconnectedSubscription() {
      if (await waitFor(() => emptyAfterRestoreAt !== undefined)) {
        // Keep this subscription active while the surviving owner's edit is
        // confirmed by a second live subscription.
        await window.p0VerifyControlRename();
        await new Promise(resolve => setTimeout(resolve, reconnectFollowUpMs));
      }
    }

    const observedEmptyAt = reconnect ? emptyAfterRestoreAt : emptyAt;
    const evidence = {
      uninterrupted: socketContinued(),
      sameBearer: matchesBearer(),
      bearerUnexpired: expiryMs > Date.now() + 5_000,
      forcedRefreshes: forcedRefreshes - initialForcedRefreshes,
      queryErrors,
      emptyCallback: observedEmptyAt !== undefined,
      subscriptionRows: rows.length,
      renderedRows: taskList.children.length,
      httpAuthenticated: httpResult?.authenticated ?? null,
      httpRows: httpResult?.rows ?? null,
    };
    if (reconnect) {
      Object.assign(evidence, offlineEvidence, {
        initialConnectionCount: before.connectionCount,
        connectionCount: client.connectionState().connectionCount,
        emptyCallbackConnection,
        reconnected: socketReconnected(),
        emptyAfterRestore: emptyAfterRestoreAt !== undefined,
        postRestoreNonemptyCallbacks,
        postClearNonemptyCallbacks,
        staleBearerRenameDenied: staleBearerRenameOutcome === "denied",
        staleBearerRenameOutcome,
        renameHttpStatus: renameResponseStatus,
      });
    }
    const sinceRevokeMs = instant => Math.round((instant - revokeStarted) / 100) * 100;
    return {
      status: observeOutcome(evidence, reconnect ? "reconnect" : undefined),
      ...evidence,
      initialHttpRows: initialHttpRows.length,
      initialSubscriptionRows,
      initialRenderedRows,
      subscriptionUpdates: callbacks - initialCallbacks,
      nativeRevokeCompletedMs: sinceRevokeMs(revokeAcknowledged),
      emptyCallbackMs: observedEmptyAt === undefined ? null : sinceRevokeMs(observedEmptyAt),
    };
  } catch {
    return { status: "failed", stage };
  } finally {
    // The native slot can clear on revoke. Close the WebView socket only after measuring.
    await client?.close();
  }
}
