import assert from "node:assert/strict";
import { test } from "node:test";
import { observeOutcome } from "./observation.mjs";

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
