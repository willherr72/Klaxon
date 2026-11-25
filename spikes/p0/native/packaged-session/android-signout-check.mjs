import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { containsMarker, containsSdkAccess } from "./web-check.mjs";

const refresh = "cache/p0-provider-refresh";
const offline = "cache/p0-provider-offline";
const expectSuccessor = "cache/p0-signout-expect-successor";
const dropReply = "cache/p0-signout-drop-reply";
const invalidReply = "cache/p0-signout-invalid-reply";
const issuerReceipt = "cache/p0-issuer-revoked-successor";
const issuerAck = "cache/p0-issuer-acknowledged-successor";
const pause = "cache/p0-signout-pause-before-cleanup";
const reached = pause + "-reached";
const journal = "no_backup/packaged.signout";
const unrelated = "no_backup/p0-signout-unrelated.bin";
const unrelatedContents = Buffer.from("keep this fixture file\n");

const taskRows = panel => panel.getByRole("list", { name: "SDK tasks" }).getByRole("listitem");

async function change(page, panel, name, expected, message = name) {
  const start = await page.evaluate(() => window.p0Replies.length);
  await panel.getByRole("button", { name, exact: true }).click();
  await page.waitForFunction(start => window.p0Replies.length > start &&
    !document.querySelector('[aria-label="SDK session fixture"] button').disabled, start);
  assert.equal(await panel.getByLabel("SDK session status").textContent(), expected, message);
  assert.equal(await page.evaluate(start => window.p0Replies[start], start), expected, message + " must reach native IPC");
}

async function nativeDenies(page) {
  assert.ok(await page.evaluate(() => window.__TAURI__.core.invoke("fixture_sdk_access")
    .then(() => false, error => error === "signed-out")), "native SDK access must be signed out");
}

async function expectColdDenial(page, panel) {
  assert.equal(await taskRows(panel).count(), 0, "a cold denial must clear SDK rows");
  await nativeDenies(page);
  assert.ok(await page.evaluate(() => {
    const { evidence, accessRequests } = window.p0SdkFixture;
    return evidence.socketsOpened === 0 && accessRequests.length === 0 &&
      !window.p0Replies.some(reply => String(reply).startsWith("sdk-access-"));
  }), "a cold denial opened an SDK socket, requested access or received access");
}

async function expectGrant(page, panel, owner, generation) {
  await change(page, panel, "Resume session", "authenticated");
  await page.waitForFunction(generation => window.p0Replies.includes("sdk-access-" + generation) &&
    window.p0SdkFixture.evidence.queryAddGenerations.includes(generation), generation);
  assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketAuthGenerations.at(-1)), generation);
  const rows = taskRows(panel);
  await rows.first().waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.getAttribute("data-task-id"), "task-" + owner.toLowerCase());
  assert.equal(await rows.textContent(), "Owner " + owner + " task");
}

async function waitFor(check, message) {
  const deadline = Date.now() + 15000;
  do {
    if (check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

export async function exerciseAndroidSignOut(launch, slot, { adb, app, record, runAs, read, write }) {
  const set = (...paths) => runAs("touch", ...paths);
  const remove = (...paths) => runAs("rm", "-f", ...paths);
  const exists = path => {
    const slash = path.lastIndexOf("/");
    return runAs("ls", "-A", path.slice(0, slash)).split(/\r?\n/).includes(path.slice(slash + 1));
  };
  const processes = () => new Map(adb("shell", "ps", "-A", "-o", "PID,NAME").split(/\r?\n/).slice(1)
    .map(line => line.trim().split(/\s+/, 2)));
  const forceStop = () => adb("shell", "am", "force-stop", app);
  let successor;
  const assertPreserved = message => assert.ok(slot.read().equals(successor), message);

  try {
    const lossPid = await launch([async (page, panel) => {
      await change(page, panel, "Start synthetic session", "fixture-ready");
      const predecessor = slot.read();
      write(unrelated, unrelatedContents);
      set(refresh);
      // Advance the SDK's separate wire fixture before the native issuer supplies a2.
      await page.evaluate(() => window.p0SdkFixture.rotate());
      await expectGrant(page, panel, "A", "a2");
      remove(refresh);
      successor = slot.read();
      assert.ok(!successor.equals(predecessor), "rotated access must replace the protected record");
      for (const encoding of ["latin1", "utf16le"]) {
        const encoded = successor.toString(encoding);
        assert.ok(!containsMarker(encoded) && !containsSdkAccess(encoded), "expected only protected successor bytes");
      }

      assert.ok(!exists(issuerReceipt), "issuer already recorded a revocation");
      set(expectSuccessor, dropReply);
      await change(page, panel, "Sign out", "retry-required",
        "sign-out must require retry when the issuer revokes the successor and drops its reply");
      assert.equal(read(issuerReceipt).length, 0, "the issuer must leave an empty revocation receipt");
      assert.equal(read(journal).toString("ascii"), "pending");
      assert.ok(!exists(issuerAck), "the issuer acknowledged a dropped reply");
      assert.equal(await taskRows(panel).count(), 0, "sign-out must clear SDK rows before revocation is acknowledged");
      assert.ok(await page.evaluate(() => {
        const { socketsOpened, socketsClosed } = window.p0SdkFixture.evidence;
        return socketsOpened > 0 && socketsOpened === socketsClosed;
      }), "unacknowledged sign-out must close the SDK socket");
      await nativeDenies(page);
      assertPreserved("lost reply changed the protected successor");
    }]);

    const retryPid = await launch([async (page, panel) => {
      await change(page, panel, "Resume session", "retry-required", "cold resume must respect pending sign-out");
      await change(page, panel, "Start synthetic session", "retry-required");
      await change(page, panel, "Start peer session", "retry-required");
      await expectColdDenial(page, panel);
      assertPreserved("cold resume changed the protected successor");

      await change(page, panel, "Sign out", "retry-required", "repeated reply loss must require retry");
      await expectColdDenial(page, panel);
      assertPreserved("repeated reply loss changed the protected successor");

      remove(dropReply);
      set(offline);
      await change(page, panel, "Sign out", "retry-required", "offline sign-out must require retry");
      await expectColdDenial(page, panel);
      assertPreserved("offline retry changed the protected successor");
      remove(offline);

      set(invalidReply);
      await change(page, panel, "Sign out", "retry-required", "a malformed issuer acknowledgment must require retry");
      await expectColdDenial(page, panel);
      assertPreserved("malformed acknowledgment changed the protected successor");
      assert.ok(!exists(issuerAck), "the issuer recorded a valid acknowledgment before returning one");
      remove(invalidReply);
    }]);

    const writerPid = await launch([async (page, panel) => {
      await change(page, panel, "Resume session", "retry-required", "malformed acknowledgment must leave sign-out pending");
      await expectColdDenial(page, panel);
      assertPreserved("relaunch after the malformed acknowledgment changed the protected successor");
    }], async (page, pid) => {
      set(pause);
      // Keep a real native invocation outstanding while the acknowledged writer is parked.
      let outcome = "pending";
      const invocation = page.evaluate(() => window.__TAURI__.core.invoke("fixture_session", { operation: "sign-out" })
        .then(() => "replied", () => "replied"))
        .then(result => { outcome = result; }, () => { outcome = "disconnected"; });
      await waitFor(() => exists(reached) && runAs("cat", reached) === pid,
        "sign-out writer did not reach its pre-cleanup checkpoint in PID " + pid);
      assert.equal(processes().get(pid), app, "the acknowledged writer must still be alive");
      assert.equal(await page.evaluate(() => window.p0Replies.length), 0, "the paused writer sent an IPC callback");
      assert.equal(outcome, "pending", "sign-out IPC replied before acknowledged cleanup");
      assert.equal(read(journal).toString("ascii"), "acknowledged");
      assertPreserved("acknowledged writer removed or rewrote the protected successor before cleanup");
      assert.equal(read(issuerAck).length, 0, "the issuer must leave an empty acknowledgment receipt");

      forceStop();
      await waitFor(() => {
        const table = processes();
        return !table.has(pid) && ![...table.values()].includes(app);
      }, "sign-out writer PID " + pid + " survived force-stop");
      const browser = page.context().browser();
      await waitFor(() => !browser.isConnected(), "sign-out writer WebView remained connected after force-stop");
      await invocation;
      assert.equal(outcome, "disconnected", "the killed sign-out must lose its IPC without a reply");
    });
    assertPreserved("the protected successor did not survive force-stop before cleanup");

    // Require recovery to complete locally. A second issuer exchange cannot succeed offline.
    remove(pause, reached);
    set(offline);
    const recoveryPid = await launch([async (page, panel) => {
      await change(page, panel, "Resume session", "retry-required", "cold resume must deny an acknowledged sign-out awaiting cleanup");
      await expectColdDenial(page, panel);
      assertPreserved("cold denial changed the acknowledged successor before cleanup");
      await change(page, panel, "Sign out", "signed-out", "a fresh process must finish acknowledged cleanup offline");
      await expectColdDenial(page, panel);
      assert.ok(!exists(record), "acknowledged cleanup left the protected record behind");
      assert.ok(!exists(journal) && !exists(journal + ".new"), "sign-out left its journal behind");
      assert.ok(read(unrelated).equals(unrelatedContents), "acknowledged cleanup changed an unrelated file");
    }]);

    // Replay before another grant can overwrite the key and with the issuer denial controls removed.
    remove(offline, expectSuccessor, issuerReceipt, issuerAck);
    slot.write(successor);
    const replayPid = await launch([async (page, panel) => {
      await change(page, panel, "Resume session", "unavailable", "restored ciphertext still decrypts after sign-out");
      await expectColdDenial(page, panel);
      assertPreserved("replaying the prior ciphertext did not exercise its original bytes");
      remove(record);
      await change(page, panel, "Start peer session", "fixture-ready", "acknowledged cleanup must allow a new grant");
      await expectGrant(page, panel, "B", "b1");
      await change(page, panel, "Sign out", "signed-out");
      assert.equal(await taskRows(panel).count(), 0);
      await nativeDenies(page);
      assert.ok(read(unrelated).equals(unrelatedContents), "signing out the new grant changed an unrelated file");
    }]);
    console.log(`PASS Android acknowledged sign-out. Reply loss PID ${lossPid}, retries PID ${retryPid}, ` +
      `force-stopped writer PID ${writerPid}, offline recovery PID ${recoveryPid}, ciphertext replay and new grant PID ${replayPid}.`);
  } finally {
    forceStop();
    remove(refresh, offline, expectSuccessor, dropReply, invalidReply, issuerReceipt, issuerAck, pause, reached, unrelated);
  }
  slot.assertEmpty();
}
