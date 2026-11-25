import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAlarmReceipt } from "./check.mjs";

const runId = "7207f1e6-08e6-49ad-82d2-7397d08ece7c";
const plan = {
  runId, armedPid: 2900, armedProcessStartElapsedMs: 88_000, armedAtMs: 1_000_000,
  replacedDueMs: 1_020_000, canceledDueMs: 1_024_000, dueMs: 1_030_000, mode: "inexact",
};
const retained = {
  runId, slot: "retained", revision: 2, dueMs: plan.dueMs, receivedAtMs: 1_031_200,
  pid: 2908, processStartElapsedMs: 119_100, interactive: false, keyguardLocked: true, idle: false,
};
const evidence = { runId, plan, receipts: [retained], coldBeforeMs: 1_012_000, observedThroughMs: 1_043_000 };

test("one matching cold noninteractive callback produces bounded local alarm evidence", () => {
  assert.deepEqual(verifyAlarmReceipt(evidence), {
    mode: "inexact", delayMs: 1200, callbacks: 1, coldProcess: true,
    interactive: false, keyguardLocked: true, idle: false, observedAfterCallbackMs: 11800,
  });
});

test("refuses missing, superseded, canceled, duplicate or foreign callbacks", () => {
  for (const receipts of [
    [], [{ ...retained, revision: 1 }], [{ ...retained, slot: "canceled" }], [retained, retained],
    [{ ...retained, runId: "another-run" }],
  ]) assert.throws(() => verifyAlarmReceipt({ ...evidence, receipts }));
});

test("refuses warm, interactive, early or insufficiently observed callbacks", () => {
  for (const change of [
    { coldBeforeMs: plan.replacedDueMs },
    { receipts: [{ ...retained, pid: plan.armedPid }] },
    { receipts: [{ ...retained, processStartElapsedMs: plan.armedProcessStartElapsedMs }] },
    { receipts: [{ ...retained, interactive: true }] },
    { receipts: [{ ...retained, receivedAtMs: plan.dueMs - 1 }] },
    { observedThroughMs: retained.receivedAtMs + 9_999 },
    { plan: { ...plan, mode: "unknown" } },
  ]) assert.throws(() => verifyAlarmReceipt({ ...evidence, ...change }));
});
