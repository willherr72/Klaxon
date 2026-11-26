import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";

const stageTimeoutMs = 12_000;

function confirmedBearerLifetime(client, bearer) {
  const auth = client.getAuth();
  if (auth?.token !== bearer) return undefined;
  const { iat, exp } = auth.decoded;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat <= 0 || exp <= iat) return undefined;
  return { issuedAt: iat * 1_000, expiresAt: exp * 1_000, ttlSeconds: exp - iat };
}

// The pinned SDK exposes the bearer it sent through getAuth(), but does not
// report a second auth change when the server accepts a replacement bearer.
export function observeRenewalSocket(Socket) {
  let original;
  let sockets = 0;
  let authRejected = false;
  let queryReplaced = false;
  let taskQueryId;
  const authenticates = new Map();
  const acknowledgments = [];

  function frameOf(data) {
    if (typeof data !== "string") return undefined;
    try { return JSON.parse(data); }
    catch { return undefined; }
  }

  return {
    WebSocket: class extends Socket {
      constructor(...args) {
        super(...args);
        sockets++;
        if (sockets !== 1) return;
        original = this;
        this.addEventListener("message", ({ data }) => {
          const frame = frameOf(data);
          if (frame?.type === "AuthError") authRejected = true;
          if (frame?.type !== "Transition") return;
          const start = frame.startVersion?.identity;
          if (frame.endVersion?.identity === start + 1 && authenticates.has(start)) {
            acknowledgments.push({ bearer: authenticates.get(start), at: Date.now() });
            authenticates.delete(start);
          }
        });
      }

      send(data) {
        super.send(data);
        if (this !== original) return;
        const frame = frameOf(data);
        if (frame?.type === "Authenticate" && frame.tokenType === "User") {
          authenticates.set(frame.baseVersion, frame.value);
        }
        if (frame?.type !== "ModifyQuerySet") return;
        for (const modification of frame.modifications ?? []) {
          if (modification.type === "Add" && modification.udfPath === "tasks:list") {
            if (taskQueryId !== undefined) queryReplaced = true;
            else taskQueryId = modification.queryId;
          }
          if (modification.type === "Remove" && taskQueryId === modification.queryId) queryReplaced = true;
        }
      }
    },
    get taskQueryId() { return queryReplaced ? undefined : taskQueryId; },
    continued: () => !authRejected && !queryReplaced && sockets === 1 && original.readyState === Socket.OPEN,
    acknowledgedOrder: bearer => acknowledgments.findIndex(ack => ack.bearer === bearer) + 1,
    acknowledgedAt: (bearer, order) => acknowledgments[order - 1]?.bearer === bearer ?
      acknowledgments[order - 1].at : undefined,
  };
}

export async function observeRunningRenewal({
  origin, taskId, title, renewedTitle, invoke, renderTasks, renderedTask, renderedRows, waitFor, reportProgress,
  realProvider = false, webSocketConstructor = WebSocket, fetchQuery = fetch,
}) {
  let stage = "renewal observation input";
  const failure = () => ({ status: "failed", stage });
  let client;
  try {
    if (typeof taskId !== "string" || !taskId || typeof title !== "string" || typeof renewedTitle !== "string" ||
        title === renewedTitle) return failure();
    stage = "native resume";
    if (await invoke("local_resume") !== "authenticated") return failure();
    stage = "initial native access";
    const initialBearer = await invoke("local_access", { forceRefresh: false });
    if (typeof initialBearer !== "string" || !initialBearer) return failure();

    stage = "initial authenticated subscription";
    const socket = observeRenewalSocket(webSocketConstructor);
    client = new ConvexClient(origin, {
      logger: false, expectAuth: true, initialAuthTokenReuse: true, webSocketConstructor: socket.WebSocket,
    });
    let rows = [];
    let callbacks = 0;
    let initialObserved = false;
    let initialLifetime;
    let initialConnectionCount;
    let initialQueryId;
    let forcedRefreshes = 0;
    let forcedRefreshAt;
    let renewedBearer;
    let refreshFailed = false;
    let queryFailed = false;
    let revokeStarted = false;
    let emptyCallback = false;
    const hasTask = (tasks, expectedTitle) => tasks.some(task => task._id === taskId && task.title === expectedTitle);
    const sameSubscription = () => {
      const state = client.connectionState();
      return socket.continued() && socket.taskQueryId === initialQueryId &&
        state.isWebSocketConnected && state.connectionCount === initialConnectionCount;
    };
    const interrupted = () => queryFailed || refreshFailed || (initialObserved && !sameSubscription());
    const waitForHealthy = async (condition, timeoutMs = stageTimeoutMs) =>
      await waitFor(() => interrupted() || condition(), timeoutMs) && !interrupted();

    client.setAuth(async ({ forceRefreshToken }) => {
      if (!forceRefreshToken) return initialBearer;
      // Reject startup fallback and auth-error retries. The running SDK must
      // ask for the forced grant after the original subscription is ready.
      forcedRefreshAt = Date.now();
      if (++forcedRefreshes !== 1 || !initialObserved || interrupted() ||
          forcedRefreshAt <= initialLifetime.issuedAt || forcedRefreshAt >= initialLifetime.expiresAt) {
        refreshFailed = true;
        return null;
      }
      try {
        const fresh = await invoke("local_access", { forceRefresh: true });
        if (typeof fresh === "string" && fresh && fresh !== initialBearer) {
          renewedBearer = fresh;
          return fresh;
        }
      } catch {
        // Settle the SDK fetcher even if the native provider failed.
      }
      refreshFailed = true;
      return null;
    });
    client.onUpdate(api.tasks.list, {}, tasks => {
      rows = tasks;
      renderTasks(tasks);
      callbacks++;
      if (revokeStarted && tasks.length === 0) emptyCallback = true;
    }, () => { queryFailed = true; });

    if (!await waitForHealthy(() => socket.continued() && Number.isSafeInteger(socket.taskQueryId) &&
      socket.acknowledgedOrder(initialBearer) === 1 && client.connectionState().isWebSocketConnected &&
      hasTask(rows, title) && renderedTask(title))) return failure();
    stage = "confirmed cold-resumed bearer lifetime";
    initialLifetime = confirmedBearerLifetime(client, initialBearer);
    if (!initialLifetime || initialLifetime.expiresAt <= Date.now()) return failure();
    initialConnectionCount = client.connectionState().connectionCount;
    initialQueryId = socket.taskQueryId;
    const initialCallbacks = callbacks;
    const initialSubscriptionRows = rows.length;
    const initialRenderedRows = renderedRows();
    initialObserved = true;
    reportProgress("subscribed");

    stage = "scheduled SDK renewal and socket acknowledgment";
    let acknowledgedAt;
    if (!await waitForHealthy(() => renewedBearer !== undefined &&
      (acknowledgedAt = socket.acknowledgedAt(renewedBearer, 2)) !== undefined &&
      client.getAuth()?.token === renewedBearer, initialLifetime.expiresAt - Date.now()) ||
      acknowledgedAt >= initialLifetime.expiresAt) return failure();
    const successorLifetime = confirmedBearerLifetime(client, renewedBearer);
    if (!successorLifetime || successorLifetime.issuedAt <= initialLifetime.issuedAt) return failure();
    const renewalCallbacks = callbacks;
    reportProgress("renewed");

    stage = "independent edit on the original subscription";
    if (!await waitForHealthy(() => callbacks > renewalCallbacks && hasTask(rows, renewedTitle) &&
      renderedTask(renewedTitle))) return failure();
    reportProgress("updated");

    stage = "explicit HTTP read with the successor bearer";
    const bearer = await invoke("local_access", { forceRefresh: false });
    if (bearer !== renewedBearer) return failure();
    const httpForBearer = inspectResponse => new ConvexHttpClient(origin, {
      auth: bearer, logger: false,
      fetch: async (input, options) => {
        const response = await fetchQuery(input, {
          ...options, redirect: "error", signal: AbortSignal.timeout(stageTimeoutMs),
        });
        inspectResponse?.(response.status);
        return response;
      },
    });
    const http = httpForBearer();
    const [authenticated, httpRows] = await Promise.all([
      http.query(api.auth.isAuthenticated, {}), http.query(api.tasks.list, {}),
    ]);
    if (authenticated !== true || !hasTask(httpRows, renewedTitle) || interrupted() ||
        !hasTask(rows, renewedTitle) || !renderedTask(renewedTitle)) return failure();

    stage = "native revoke of the successor grant";
    revokeStarted = true;
    if (await invoke("local_revoke") !== "revoked") return failure();
    reportProgress("revoked");

    let revokedHttpBeforeExpiryMs;
    if (realProvider) {
      stage = "fresh HTTP denial with the revoked successor bearer";
      if (successorLifetime.expiresAt <= Date.now()) return failure();
      const queryDenied = async (reference, deniedValue) => {
        let status;
        const staleHttp = httpForBearer(value => { status = value; });
        try { return deniedValue(await staleHttp.query(reference, {})); }
        catch { return status === 401; }
      };
      const [authDenied, tasksDenied] = await Promise.all([
        queryDenied(api.auth.isAuthenticated, value => value === false),
        queryDenied(api.tasks.list, value => Array.isArray(value) && value.length === 0),
      ]);
      revokedHttpBeforeExpiryMs = successorLifetime.expiresAt - Date.now();
      if (!authDenied || !tasksDenied || revokedHttpBeforeExpiryMs <= 0) return failure();
    }

    stage = "cleared original subscription and task list";
    if (!await waitForHealthy(() => emptyCallback && rows.length === 0 && renderedRows() === 0)) return failure();
    return {
      status: "passed",
      forcedRefreshes,
      initialBearerTtlSeconds: initialLifetime.ttlSeconds,
      forcedRefreshAfterIssuedMs: forcedRefreshAt - initialLifetime.issuedAt,
      forcedRefreshBeforeExpiryMs: initialLifetime.expiresAt - forcedRefreshAt,
      successorAcknowledgedBeforeExpiryMs: initialLifetime.expiresAt - acknowledgedAt,
      successorBearerTtlSeconds: successorLifetime.ttlSeconds,
      connectionCount: initialConnectionCount,
      taskQueryId: initialQueryId,
      uninterrupted: true,
      successorAuthenticated: true,
      controlEditDelivered: true,
      httpAuthenticated: authenticated,
      httpRows: httpRows.length,
      nativeRevoked: true,
      ...(realProvider && { revokedHttpDenied: true, revokedHttpBeforeExpiryMs }),
      emptyCallback,
      initialSubscriptionRows,
      initialRenderedRows,
      subscriptionUpdates: callbacks - initialCallbacks,
      subscriptionRows: rows.length,
      renderedRows: renderedRows(),
    };
  } catch {
    return failure();
  } finally {
    await client?.close();
  }
}
