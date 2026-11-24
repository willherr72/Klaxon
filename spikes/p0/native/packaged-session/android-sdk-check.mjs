import assert from "node:assert/strict";
import { checkSessionPage, containsMarker, containsSdkAccess } from "./web-check.mjs";
import { exerciseSdkHandoff } from "./sdk-check.mjs";

export async function exerciseAndroidSdkHandoff(withActivity, adb, adbBytes, app) {
  const pids = new Set();
  let webview;
  async function launch(actions) {
    adb("shell", "am", "force-stop", app);
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "expected a fresh Android app process");
      pids.add(pid);
      page.setDefaultTimeout(20000);
      await page.goto("http://tauri.localhost/#sdk");
      await page.reload();
      assert.equal(await page.evaluate(() => window.p0Replies === undefined), true, "expected a fresh WebView");
      const policy = page.locator('meta[http-equiv="Content-Security-Policy"]').first();
      assert.match(await policy.getAttribute("content"), /connect-src 'none'/);
      webview = await page.evaluate(() => navigator.userAgent);
      await checkSessionPage(page, actions, "android");
    });
  }

  const record = "no_backup/packaged.bin";
  const outage = "cache/p0-provider-offline";
  const runAs = (...args) => adb("shell", "run-as", app, ...args);
  const write = (path, bytes) => adbBytes(["shell", "-T", "run-as", app, "sh", "-c", "'base64 -d > " + path + "'"],
    bytes.toString("base64"));
  const slot = {
    read: () => {
      const bytes = adbBytes(["shell", "-T", "run-as", app, "cat", record]);
      assert.ok(bytes.length > 28, "expected an IV, ciphertext and GCM tag");
      return bytes;
    },
    write: bytes => write(record, bytes),
    outage: offline => offline ? runAs("touch", outage) : runAs("rm", outage),
    rotate: rotated => runAs(rotated ? "touch" : "rm", "cache/p0-provider-rotated"),
    expiry: expired => runAs(expired ? "touch" : "rm", "cache/p0-provider-expired"),
    assertEmpty: () => assert.equal(runAs("ls", "-A", "no_backup"), "", "expected an empty Keystore record directory"),
  };
  await exerciseSdkHandoff(launch, slot, { verifyAndroidKeystore: true });
  await exerciseDurableRefresh(launch, slot, runAs, bytes => write(record + ".new", bytes));
  adb("shell", "am", "force-stop", app);

  let logLines = 0;
  for (const pid of pids) {
    const log = adb("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash", "--pid=" + pid);
    const appLine = new RegExp("\\s" + pid + "\\s+\\d+\\s+[VDIWEF]\\s");
    const count = log.split("\n").filter(line => appLine.test(line)).length;
    assert.ok(count > 0 && !containsMarker(log) && !containsSdkAccess(log), "expected app logs without session material");
    logLines += count;
  }
  console.log("PASS packaged Android Keystore-to-SDK", pids.size, "fresh app processes and WebViews,", logLines,
    "app log lines; SDK handoff, interrupted refresh recovery, successor-only cold resume and scoped cleanup checked;", webview);
}

async function exerciseDurableRefresh(launch, slot, runAs, stage) {
  const change = (page, operation) => page.evaluate(operation =>
    window.__TAURI__.core.invoke("fixture_session", { operation }), operation);
  const access = (page, expected) => page.evaluate(() =>
    window.__TAURI__.core.invoke("fixture_sdk_access").then(() => "issued", status => status))
    .then(status => assert.equal(status, expected));
  const generation = (page, label) => page.waitForFunction(label => window.p0Replies.at(-1) === label, "sdk-access-" + label);
  const flag = (name, enabled) => runAs(enabled ? "touch" : "rm", "cache/p0-" + name);
  const assertSealed = bytes => assert.ok(["latin1", "utf16le"].every(encoding =>
    !containsMarker(bytes.toString(encoding)) && !containsSdkAccess(bytes.toString(encoding))), "expected protected successor");

  await launch([async page => assert.equal(await change(page, "seed"), "fixture-ready")]);
  const predecessor = slot.read();
  // Recreate the files a killed writer leaves before AtomicFile publishes its staging file.
  stage(predecessor.subarray(0, 16));
  let successor;
  await launch([async page => {
    await access(page, "signed-out");
    assert.equal(await change(page, "resume"), "authenticated");
    await access(page, "issued");
    await generation(page, "a1");
    assert.equal(runAs("ls", "-A", "no_backup"), "packaged.bin", "cold resume left a partial write");
    assert.ok(slot.read().equals(predecessor), "recovering from a partial write changed the active record");

    flag("provider-refresh", true);
    for (const [name, status] of [["provider-offline", "retry-required"],
      ["provider-refresh-invalid", "unavailable"], ["provider-refresh-wrong-owner", "unavailable"]]) {
      flag(name, true);
      await access(page, status);
      await access(page, "signed-out");
      assert.ok(slot.read().equals(predecessor), name + " changed the active record");
      flag(name, false);
      flag("provider-refresh", false);
      assert.equal(await change(page, "resume"), "authenticated");
      flag("provider-refresh", true);
    }

    // A nonempty staging directory causes a real AtomicFile write failure.
    const blocker = "no_backup/packaged.bin.new";
    runAs("mkdir", blocker);
    runAs("touch", blocker + "/blocker");
    await access(page, "unavailable");
    await access(page, "signed-out");
    assert.ok(slot.read().equals(predecessor), "failed write changed the active record");
    runAs("rm", blocker + "/blocker");
    runAs("rmdir", blocker);
    flag("provider-refresh", false);
    assert.equal(await change(page, "resume"), "authenticated");
    flag("provider-refresh", true);

    await access(page, "issued");
    successor = slot.read();
    assert.ok(!successor.equals(predecessor), "access was granted without replacing the active record");
    assertSealed(successor);
    await generation(page, "a2");
  }]);
  flag("provider-refresh", false);
  flag("require-successor", true);
  await launch([async page => {
    await access(page, "signed-out");
    assert.equal(await change(page, "resume"), "authenticated");
    await access(page, "issued");
    await generation(page, "a2");
    assert.ok(slot.read().equals(successor), "cold resume rewrote the accepted successor");
  }]);

  slot.write(predecessor);
  runAs("touch", "no_backup/unrelated.bin");
  await launch([async page => {
    assert.equal(await change(page, "resume"), "signed-out", "provider accepted a retired predecessor");
    await access(page, "signed-out");
    assert.equal(runAs("ls", "-A", "no_backup"), "unrelated.bin", "expiry removed data outside the session slot");
  }]);
  flag("require-successor", false);
  runAs("rm", "no_backup/unrelated.bin");
  await launch([async page => {
    assert.equal(await change(page, "resume"), "signed-out");
    // Seeding refuses to replace an existing alias as well as an existing file.
    assert.equal(await change(page, "seed"), "fixture-ready");
    assert.equal(await change(page, "sign-out"), "signed-out");
  }]);
  slot.assertEmpty();
}
