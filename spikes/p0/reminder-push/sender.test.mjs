import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchOnce, mockInput } from "./sender.mjs";

async function fixture(t) {
  const runDirectory = await mkdtemp(join(tmpdir(), "klaxon-p0-push-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  return { runDirectory, input: mockInput(), rehearsal: true };
}

test("one synthetic occurrence is offered once to each selected subscription", async t => {
  const run = await fixture(t);
  const calls = [];
  const result = await dispatchOnce({ ...run, sendNotification: async (subscription, json, options) => {
    const payload = JSON.parse(json);
    assert.deepEqual(subscription, run.input.subscriptions[payload.target]);
    assert.equal(payload.occurrenceId, run.input.occurrenceId);
    assert.equal(payload.body, payload.target + " " + payload.occurrenceId);
    assert.equal(payload.revision, 1);
    assert.equal(payload.title, "Klaxon P0 test");
    assert.equal(options.TTL, 300);
    calls.push(payload.target);
    return { statusCode: 201, body: "private provider response" };
  } });
  assert.deepEqual(calls, ["windows-edge", "android-chrome"]);
  assert.deepEqual(result.targets.map(row => row.transportStatus), ["accepted", "accepted"]);
  assert.ok(result.targets.every(row => row.workerReceipt === "unobserved" && row.visibleReceipt === "unobserved"));
  const ledger = await readFile(join(run.runDirectory, "attempted.json"), "utf8");
  for (const text of [JSON.stringify(result), ledger]) {
    assert.doesNotMatch(text, /\.invalid|fixture-key|provider response/);
  }
});

test("concurrent or later invocation cannot resend, including after uncertain delivery", async t => {
  const run = await fixture(t);
  let calls = 0;
  const sendNotification = async () => {
    calls++;
    if (calls === 1) throw Error("private subscription URL");
    throw Object.assign(Error("private provider rejection"), { statusCode: 410 });
  };
  const results = await Promise.allSettled([1, 2].map(() => dispatchOnce({ ...run, sendNotification })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const report = results.find(r => r.status === "fulfilled").value;
  assert.deepEqual(report.targets.map(row => [row.transportStatus, row.providerStatus]), [["unknown", null], ["rejected", 410]]);
  assert.doesNotMatch(JSON.stringify(report), /private/);
  await assert.rejects(dispatchOnce({ ...run, sendNotification }), /claimed/);
  assert.equal(calls, 2);
});

test("preflight rejects unexpected, duplicate or non-provider destinations before either attempt", async t => {
  const run = await fixture(t);
  let calls = 0;
  const sendNotification = async () => { calls++; };
  const attempt = (input, rehearsal = true) => dispatchOnce({ ...run, input, rehearsal, sendNotification });
  const input = run.input;
  await assert.rejects(attempt(input, false), /endpoint/);
  const other = structuredClone(input);
  other.subscriptions["android-chrome"].endpoint = "https://unselected.invalid/";
  await assert.rejects(attempt(other), /endpoint/);
  other.subscriptions["android-chrome"] = other.subscriptions["windows-edge"];
  await assert.rejects(attempt(other), /endpoint/);
  other.subscriptions.extra = other.subscriptions["windows-edge"];
  await assert.rejects(attempt(other), /two target/);
  await assert.rejects(readFile(join(run.runDirectory, "attempted.json")), { code: "ENOENT" });
  assert.equal(calls, 0);
});

test("a malformed second wire request leaves both attempts unclaimed and reports no private detail", async t => {
  const run = await fixture(t);
  run.rehearsal = false;
  const subs = Object.values(run.input.subscriptions);
  subs[0].endpoint = "https://fixture.notify.windows.com/test";
  subs[1].endpoint = "https://fcm.googleapis.com/test-fixture";
  let prepared = 0, sent = 0;
  const prepareNotification = () => {
    if (++prepared === 2) throw Error("secret provider detail");
  };
  await assert.rejects(dispatchOnce({ ...run, prepareNotification, sendNotification: () => sent++ }),
    error => error.message === "Cannot prepare both selected subscription requests");
  assert.equal(prepared, 2);
  assert.equal(sent, 0);
  await assert.rejects(readFile(join(run.runDirectory, "attempted.json")), { code: "ENOENT" });
  run.input.occurrenceId = [run.input.occurrenceId];
  await assert.rejects(dispatchOnce({ ...run, prepareNotification, sendNotification: () => sent++ }), /UUID/);
  assert.equal(prepared, 2);
});
