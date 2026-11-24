import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { containsMarker, containsSdkAccess } from "./web-check.mjs";

const record = "packaged.bin";
const staging = record + ".new";
const change = (page, operation) => page.evaluate(operation =>
  window.__TAURI__.core.invoke("fixture_session", { operation }), operation);
const sdkAccess = page => page.evaluate(() =>
  window.__TAURI__.core.invoke("fixture_sdk_access").then(() => "issued", status => status));

async function resume(page, generation) {
  assert.equal(await sdkAccess(page), "signed-out", "fresh process issued access before explicit resume");
  assert.equal(await change(page, "resume"), "authenticated");
  assert.equal(await sdkAccess(page), "issued");
  await page.waitForFunction(generation => window.p0Replies.at(-1) === "sdk-access-" + generation, generation);
}

async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  do {
    const result = check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

export async function exerciseAndroidRefreshProcessDeath(launch, slot, readStaging, adb, app) {
  const flag = "cache/p0-provider-refresh";
  const successorOnly = "cache/p0-require-successor";
  const unrelated = "no_backup/unrelated.bin";
  const runAs = (...args) => adb("shell", "run-as", app, ...args);
  const assertFiles = (...files) => assert.deepEqual(runAs("ls", "-A", "no_backup").split(/\r?\n/), files);
  const processes = () => new Map(adb("shell", "ps", "-A", "-o", "PID,NAME").split(/\r?\n/).slice(1)
    .map(line => line.trim().split(/\s+/, 2)));
  const assertPending = async page => assert.equal(await page.evaluate(() => window.p0Replies.length), 0,
    "the paused writer sent an IPC callback");

  async function killWriter(boundary, checkFiles) {
    const pause = "cache/p0-refresh-pause-" + boundary;
    const reached = pause + "-reached";
    let checkpointPid;
    let invocation;
    let outcome = "pending";
    try {
      const deadPid = await launch([page => resume(page, "a1"), async page => {
        runAs("touch", flag, pause);
        // Keep the real invoke in flight. Neither a fulfilled nor a denied command is expected.
        invocation = page.evaluate(() => window.__TAURI__.core.invoke("fixture_sdk_access")
          .then(() => "issued", () => "denied"))
          .then(status => { outcome = status; }, () => { outcome = "interrupted"; });
        checkpointPid = await waitFor(() => {
          if (!runAs("ls", "-A", "cache").split(/\r?\n/).includes(reached.slice("cache/".length))) return;
          const pid = runAs("cat", reached);
          if (/^\d+$/.test(pid)) return pid;
        }, "Android writer did not reach " + boundary);
        await assertPending(page);
        checkFiles();
      }], async (page, pid) => {
        assert.equal(checkpointPid, pid, "checkpoint belongs to a different Android process");
        assert.equal(processes().get(pid), app, "checkpoint writer must still be alive");
        await assertPending(page);
        assert.equal(outcome, "pending", "refresh invoke must still be in flight");
        // This is the same isolated app the smoke harness installed, and its writer is still blocked.
        adb("shell", "am", "force-stop", app);
        await waitFor(() => {
          const table = processes();
          return !table.has(pid) && ![...table.values()].includes(app);
        }, "Android writer PID " + pid + " survived force-stop");
        const browser = page.context().browser();
        await waitFor(() => !browser.isConnected(), "Android writer WebView remained connected after process death");
      });
      await invocation;
      assert.equal(outcome, "interrupted", "the killed rotation must lose its IPC without a reply");
      return deadPid;
    } finally {
      runAs("rm", "-f", flag, pause, reached);
    }
  }

  await launch([async page => assert.equal(await change(page, "seed"), "fixture-ready")]);
  const predecessor = slot.read();
  let staged;
  const beforePid = await killWriter("before-publish", () => {
    assertFiles(record, staging);
    assert.ok(slot.read().equals(predecessor), "the predecessor changed before publish");
    staged = readStaging();
    assert.ok(staged.length === predecessor.length && !staged.equals(predecessor), "expected a complete staged replacement");
    assertSealed(staged);
  });
  assert.ok(slot.read().equals(predecessor), "the predecessor did not survive the pre-publish process death");
  assert.ok(readStaging().equals(staged), "staging did not survive the pre-publish process death");
  const oldRecoveryPid = await launch([async page => {
    await resume(page, "a1");
    assertFiles(record);
    assert.ok(slot.read().equals(predecessor), "cold recovery did not preserve the predecessor");
  }]);

  let successor;
  const afterPid = await killWriter("after-publish", () => {
    assertFiles(record);
    successor = slot.read();
    assert.ok(!successor.equals(predecessor), "publish did not replace the predecessor");
    assertSealed(successor);
  });
  assert.ok(slot.read().equals(successor), "published successor did not survive process death");

  runAs("touch", successorOnly, unrelated);
  let newRecoveryPid;
  try {
    newRecoveryPid = await launch([async page => {
      await resume(page, "a2");
      assert.ok(slot.read().equals(successor), "cold recovery rewrote the published successor");
      assert.equal(await change(page, "sign-out"), "signed-out");
      assert.equal(await sdkAccess(page), "signed-out");
      assertFiles("unrelated.bin");
    }]);
  } finally {
    runAs("rm", "-f", successorOnly, unrelated);
  }
  await launch([async page => {
    assert.equal(await change(page, "resume"), "signed-out");
    // A fresh seed requires the previous alias and slot to both be absent.
    assert.equal(await change(page, "seed"), "fixture-ready");
    assert.equal(await change(page, "sign-out"), "signed-out");
  }]);
  slot.assertEmpty();
  console.log(`PASS Android refresh process death. Before publish PID ${beforePid} recovered a1 in PID ${oldRecoveryPid}. ` +
    `After publish PID ${afterPid} recovered a2 in PID ${newRecoveryPid}. Both in-flight invokes ended without a reply.`);
}

function assertSealed(bytes) {
  for (const encoding of ["latin1", "utf16le"]) {
    assert.ok(!containsMarker(bytes.toString(encoding)) && !containsSdkAccess(bytes.toString(encoding)),
      "expected only protected bytes during refresh");
  }
}
