import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { observeRenewalSocket, observeRunningRenewal } from "./renewal-observation.mjs";
import { withScriptedAndroidProvider } from "./scripted-android-provider.mjs";

class TestSocket extends EventTarget {
  static OPEN = 1;
  readyState = TestSocket.OPEN;

  send() {}

  receive(frame) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }
}

function authenticate(socket, value, baseVersion) {
  socket.send(JSON.stringify({ type: "Authenticate", tokenType: "User", baseVersion, value }));
}

function transition(socket, start, end) {
  socket.receive({ type: "Transition", startVersion: { identity: start }, endVersion: { identity: end } });
}

function changeQueries(socket, ...modifications) {
  socket.send(JSON.stringify({ type: "ModifyQuerySet", modifications }));
}

test("counts each bearer only after its socket acknowledges the matching identity version", () => {
  const observation = observeRenewalSocket(TestSocket);
  const socket = new observation.WebSocket();

  authenticate(socket, "initial", 0);
  transition(socket, 0, 0);
  assert.equal(observation.acknowledgedOrder("initial"), 0);
  transition(socket, 0, 1);
  assert.equal(observation.acknowledgedOrder("initial"), 1);

  authenticate(socket, "successor", 1);
  transition(socket, 0, 2);
  assert.equal(observation.acknowledgedOrder("successor"), 0);
  transition(socket, 1, 2);
  assert.equal(observation.acknowledgedOrder("successor"), 2);
  assert.equal(observation.continued(), true);

  const reconnect = new observation.WebSocket();
  authenticate(socket, "third", 2);
  transition(reconnect, 2, 3);
  assert.equal(observation.acknowledgedOrder("third"), 0);
  assert.equal(observation.continued(), false);
});

test("invalidates continuity after a task subscription is replaced or auth is rejected", () => {
  const observation = observeRenewalSocket(TestSocket);
  const socket = new observation.WebSocket();
  changeQueries(socket, { type: "Add", udfPath: "auth:isAuthenticated", queryId: 0 });
  assert.equal(observation.taskQueryId, undefined);
  changeQueries(socket, { type: "Add", udfPath: "tasks:list", queryId: 1 });
  assert.equal(observation.taskQueryId, 1);
  changeQueries(socket, { type: "Remove", queryId: 1 }, { type: "Add", udfPath: "tasks:list", queryId: 2 });
  assert.equal(observation.taskQueryId, undefined);

  const secondObservation = observeRenewalSocket(TestSocket);
  const secondSocket = new secondObservation.WebSocket();
  assert.equal(secondObservation.continued(), true);
  secondSocket.receive({ type: "AuthError" });
  assert.equal(secondObservation.continued(), false);
});

test("the running observer waits for the SDK timer and preserves its socket through native revoke", { timeout: 22_000 },
  async () => withScriptedAndroidProvider(async fixture => {
    const origin = `http://127.0.0.1:${fixture.port}`;
    const packagedOrigin = "http://tauri.localhost";
    const fetchQuery = (url, options) => fetch(url, {
      ...options, headers: { ...options.headers, Origin: packagedOrigin },
    });
    class PackagedSocket extends WebSocket {
      constructor(url) { super(url, { origin: packagedOrigin }); }
    }
    async function post(path, args) {
      const response = await fetch(`${origin}/api/mutation`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, format: "convex_encoded_json", args: [args] }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, "success");
      return result.value;
    }
    const { username, password } = fixture.input;
    const signedIn = await post("auth:signInWithUsernamePassword", { username, password });
    let grant = signedIn.tokens;
    const argsForGrant = () => ({ refreshToken: grant.refreshToken });
    const refresh = async () => {
      const result = await post("auth:refreshSession", argsForGrant());
      assert.equal(result.kind, "rotated");
      grant = result.tokens;
    };
    const nativeCalls = [];
    async function invoke(command, args) {
      nativeCalls.push([command, args?.forceRefresh]);
      if (command === "local_resume") {
        await refresh();
        return "authenticated";
      }
      if (command === "local_access") {
        if (args.forceRefresh) await refresh();
        return grant.accessToken;
      }
      assert.equal(command, "local_revoke");
      assert.equal(await post("auth:signOut", argsForGrant()), null);
      assert.deepEqual(await post("auth:refreshSession", argsForGrant()), { kind: "noSession" });
      return "revoked";
    }
    const progress = [];
    const renders = [];
    const rendered = () => renders.at(-1);
    let subscribedAt;
    const report = await observeRunningRenewal({
      origin, taskId: fixture.taskId, title: fixture.title, renewedTitle: fixture.renewedTitle, invoke,
      webSocketConstructor: PackagedSocket, fetchQuery,
      renderTasks: tasks => renders.push(tasks),
      renderedTask: expectedTitle => rendered()?.some(task => task._id === fixture.taskId && task.title === expectedTitle),
      renderedRows: () => rendered()?.length,
      waitFor: async (condition, timeoutMs) => {
        const deadline = performance.now() + timeoutMs;
        while (!condition() && performance.now() < deadline) await delay(10);
        return condition();
      },
      reportProgress(phase) {
        progress.push(phase);
        if (phase === "subscribed") subscribedAt = performance.now();
        if (phase === "renewed") {
          assert.ok(performance.now() - subscribedAt >= 8_000);
          fixture.publishRenewedTask();
        }
      },
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(progress, ["subscribed", "renewed", "updated", "revoked"]);
    assert.deepEqual(nativeCalls, [
      ["local_resume", undefined], ["local_access", false], ["local_access", true],
      ["local_access", false], ["local_revoke", undefined],
    ]);
    assert.deepEqual(renders.map(rows => rows.map(row => row.title)), [[fixture.title], [fixture.renewedTitle], []]);
    assert.equal(report.forcedRefreshes, 1);
    fixture.verify();
  }, { renewal: true }));
