import assert from "node:assert/strict";
import { test } from "node:test";
import * as observation from "./observation.mjs";

const { isCachedBearerRenameDenied, observeOutcome, subscriptionOrigin } = observation;

const evidence = {
  uninterrupted: true,
  sameBearer: true,
  bearerUnexpired: true,
  forcedRefreshes: 0,
  queryErrors: 0,
  emptyCallback: true,
  subscriptionRows: 0,
  renderedRows: 0,
  httpAuthenticated: false,
  httpRows: 0,
};

test("accepts an empty subscription callback and denied cached bearer with socket continuity", () => {
  assert.equal(observeOutcome(evidence), "passed");
});

test("a disconnect, auth change, refresh, expiration, or query error obscures the observation", () => {
  for (const change of [
    { uninterrupted: false }, { sameBearer: false }, { bearerUnexpired: false },
    { forcedRefreshes: 1 }, { queryErrors: 1 },
  ]) {
    assert.equal(observeOutcome({ ...evidence, ...change }), "inconclusive");
  }
});

test("fails when the UI is cleared without an empty callback or the cached bearer still grants access", () => {
  for (const change of [
    { emptyCallback: false }, { subscriptionRows: 1 }, { renderedRows: 1 },
    { httpAuthenticated: true }, { httpRows: 1 },
  ]) {
    assert.equal(observeOutcome({ ...evidence, ...change }), "failed");
  }
});

test("routes only a validated reconnect port to a different loopback subscription origin", () => {
  const direct = "http://127.0.0.1:3210";
  assert.equal(subscriptionOrigin(direct), direct);
  assert.equal(subscriptionOrigin(direct, 49152), "http://127.0.0.1:49152");
  for (const port of [null, "49152", "49152/path", 0, -1, 1.5, 65536, 3210]) {
    assert.throws(() => subscriptionOrigin(direct, port), RangeError);
  }
});

test("the hosted outage gate closes the live socket and prevents an open while cut", async () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = Socket.OPEN;
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.dispatchEvent(new Event("close")));
    }
  }
  const gate = observation.createSubscriptionGate(Socket);
  const original = new gate.WebSocket();
  gate.disconnect();
  assert.equal(original.readyState, 3);
  const blocked = new gate.WebSocket();
  assert.equal(blocked.readyState, 3);
  gate.restore();
  assert.equal(new gate.WebSocket().readyState, Socket.OPEN);
});

const reconnectEvidence = {
  ...evidence,
  uninterrupted: false,
  disconnectedBeforeRevoke: true,
  disconnectedAfterRevoke: true,
  nativeRevoked: true,
  staleWhileOffline: true,
  reconnected: true,
  emptyCallbackConnection: 2,
  connectionCount: 2,
  emptyAfterRestore: true,
  postRestoreNonemptyCallbacks: 0,
  postClearNonemptyCallbacks: 0,
  staleBearerRenameDenied: true,
  staleBearerRenameOutcome: "denied",
};

test("accepts a new connection and an authoritative empty result with or without offline cached rows", () => {
  assert.equal(observeOutcome(reconnectEvidence, "reconnect"), "passed");
  assert.equal(observeOutcome({ ...reconnectEvidence, staleWhileOffline: false }, "reconnect"), "passed");
});

test("cannot score a reconnect without offline revocation and a new SDK connection", () => {
  for (const change of [
    { disconnectedBeforeRevoke: false }, { disconnectedAfterRevoke: false },
    { nativeRevoked: false }, { reconnected: false }, { reconnected: undefined },
    { forcedRefreshes: 1 }, { sameBearer: false }, { bearerUnexpired: false }, { queryErrors: 1 },
    { httpRows: null }, { httpAuthenticated: null }, { postClearNonemptyCallbacks: undefined },
    { staleBearerRenameDenied: false, staleBearerRenameOutcome: "unexpected-error" },
  ]) {
    assert.equal(observeOutcome({ ...reconnectEvidence, ...change }, "reconnect"), "inconclusive",
      JSON.stringify(change));
  }
});

test("fails reconnects with only a local clear, exposed rows, or cached-bearer access", () => {
  for (const change of [
    { emptyAfterRestore: false }, { emptyCallback: false }, { subscriptionRows: 1 }, { renderedRows: 1 },
    { postRestoreNonemptyCallbacks: 1 }, { postClearNonemptyCallbacks: 1 },
    { httpAuthenticated: true }, { httpRows: 1 },
    { staleBearerRenameDenied: false, staleBearerRenameOutcome: "succeeded" },
  ]) {
    assert.equal(observeOutcome({ ...reconnectEvidence, ...change }, "reconnect"), "failed",
      JSON.stringify(change));
  }
});

test("counts only the Convex function rejection as denial of the cached-bearer rename", () => {
  for (const code of [200, 560]) {
    const denial = new Error("Uncaught Error: Task unavailable\n    at handler");
    assert.equal(isCachedBearerRenameDenied(code, "error", denial), true);
    assert.equal(isCachedBearerRenameDenied(code, "success", denial), false);
  }
  for (const [status, error] of [
    [200, undefined],
    [undefined, new TypeError("Failed to fetch")], [503, new Error("Error: Task unavailable")],
    [560, new Error("Error: Task unavailable today")], [560, new Error("Other application error")],
  ]) {
    assert.equal(isCachedBearerRenameDenied(status, "error", error), false);
  }
});

test("an empty callback on an earlier socket cannot verify the current connection", () => {
  assert.equal(observeOutcome({ ...reconnectEvidence, connectionCount: 3 }, "reconnect"), "inconclusive");
});
