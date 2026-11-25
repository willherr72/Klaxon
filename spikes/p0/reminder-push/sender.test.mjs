import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dispatchOnce, mockInput } from "./sender.mjs";

async function fixture(t, input = mockInput()) {
  const runDirectory = await mkdtemp(join(tmpdir(), "klaxon-p0-push-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  return { runDirectory, input, rehearsal: true };
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

function windowsOnlyInput() {
  return {
    targetMode: "windows-only",
    occurrenceId: "d05089f1-0473-44ca-8ade-ecdae15371ee",
    subscriptions: {
      "windows-edge": {
        endpoint: "https://fixture.notify.windows.com/test",
        keys: { p256dh: "fixture-key-public", auth: "fixture-key-auth" },
      },
    },
    vapidDetails: {
      subject: "mailto:operator@example.invalid", publicKey: "fixture-key-public", privateKey: "fixture-key-private",
    },
  };
}

test("explicit Windows-only mode prepares and claims one attempt before transport", async t => {
  const { runDirectory, input } = await fixture(t, windowsOnlyInput());
  const steps = [];
  const run = {
    input, runDirectory,
    prepareNotification(subscription, json) {
      steps.push(["prepare", subscription.endpoint, JSON.parse(json)]);
    },
    async sendNotification(subscription, json) {
      const ledger = JSON.parse(await readFile(join(runDirectory, "attempted.json"), "utf8"));
      steps.push(["send", subscription.endpoint, JSON.parse(json), ledger]);
      throw Error("simulated uncertain delivery");
    },
  };
  const report = await dispatchOnce(run);
  const payload = {
    occurrenceId: input.occurrenceId, revision: 1, target: "windows-edge",
    title: "Klaxon P0 test", body: "windows-edge " + input.occurrenceId,
  };
  assert.deepEqual(steps.map(step => step.slice(0, 3)), [
    ["prepare", "https://fixture.notify.windows.com/test", payload],
    ["send", "https://fixture.notify.windows.com/test", payload],
  ]);
  assert.equal(steps[1][3].occurrenceId, input.occurrenceId);
  assert.deepEqual(steps[1][3].targets, ["windows-edge"]);
  assert.deepEqual(report.targets.map(row => [row.target, row.transportStatus]), [["windows-edge", "unknown"]]);
  await assert.rejects(dispatchOnce(run), /claimed/);
  assert.equal(steps.filter(step => step[0] === "send").length, 1);
});

test("Windows-only mode rejects every subscription set except the single Windows target", async t => {
  const { runDirectory, input } = await fixture(t, windowsOnlyInput());
  const windows = input.subscriptions["windows-edge"];
  const android = { ...windows, endpoint: "https://fcm.googleapis.com/test-fixture" };
  let prepared = 0, sent = 0;
  const attempt = candidate => dispatchOnce({
    input: candidate, runDirectory,
    prepareNotification: () => prepared++, sendNotification: () => sent++,
  });
  for (const subscriptions of [
    {}, { "android-chrome": android },
    { "windows-edge": windows, "android-chrome": android },
    { "windows-edge": windows, extra: windows },
  ]) {
    await assert.rejects(attempt({ ...input, subscriptions }), /exactly the Windows Edge subscription/);
  }
  await assert.rejects(attempt({ ...input, targetMode: undefined }), /two target/);
  await assert.rejects(attempt({ ...input, targetMode: "linux-only" }), /target mode/);
  await assert.rejects(readFile(join(runDirectory, "attempted.json")), { code: "ENOENT" });
  assert.equal(prepared, 0);
  assert.equal(sent, 0);
});

test("Android-only mode claims exactly one Android attempt and keeps an uncertain send spent", async t => {
  const run = await fixture(t);
  const android = run.input.subscriptions["android-chrome"];
  android.endpoint = "https://fcm.googleapis.com/test-fixture";
  run.rehearsal = false;
  run.input.targetMode = "android-only";
  run.input.subscriptions = { "android-chrome": android };
  const calls = [];
  const attempt = () => dispatchOnce({
    ...run,
    prepareNotification: () => calls.push("prepared"),
    async sendNotification(subscription, json) {
      assert.equal(subscription, android);
      assert.equal(JSON.parse(json).target, "android-chrome");
      const ledger = JSON.parse(await readFile(join(run.runDirectory, "attempted.json"), "utf8"));
      assert.deepEqual(ledger.targets, ["android-chrome"]);
      calls.push("sent");
      throw Error("simulated lost response");
    },
  });
  const report = await attempt();
  assert.deepEqual(report.targets.map(row => [row.target, row.transportStatus]), [["android-chrome", "unknown"]]);
  await assert.rejects(attempt(), /claimed/);
  assert.deepEqual(calls, ["prepared", "sent", "prepared"]);
});

test("Android-only mode refuses a Windows export or endpoint before claiming", async t => {
  const run = await fixture(t);
  const android = run.input.subscriptions["android-chrome"];
  const noCall = () => assert.fail("ran before valid target admission");
  run.input.targetMode = "android-only";
  const attempt = () => dispatchOnce({ ...run, rehearsal: false, prepareNotification: noCall, sendNotification: noCall });
  await assert.rejects(attempt(), /exactly the Android Chrome subscription/);
  run.input.subscriptions = { "android-chrome": { ...android, endpoint: "https://fixture.notify.windows.com/test" } };
  await assert.rejects(attempt(), /endpoint/);
  await assert.rejects(readFile(join(run.runDirectory, "attempted.json")), { code: "ENOENT" });
});

test("a malformed Windows-only wire request leaves the run unclaimed", async t => {
  const { runDirectory, input } = await fixture(t, windowsOnlyInput());
  let sent = 0;
  await assert.rejects(dispatchOnce({
    input, runDirectory,
    prepareNotification() { throw Error("secret provider detail"); },
    sendNotification() { sent++; },
  }), error => /Cannot prepare/.test(error.message) && !/secret/.test(error.message));
  await assert.rejects(readFile(join(runDirectory, "attempted.json")), { code: "ENOENT" });
  assert.equal(sent, 0);
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
