import assert from "node:assert/strict";
import { once } from "node:events";

// The canary stays in this host process. Never inject it into the WebView or logcat.
const marker = "KLAXON-P0-INERT/";
const fixedMarker = Buffer.from(marker + "packaged/1");
const representations = [marker, fixedMarker.toString("base64"), fixedMarker.toString("hex")];
const containsMarker = value => representations.some(form => value.includes(form));
export async function exerciseSession(withActivity, adb, app) {
  const pids = new Set();
  let replies = 0;
  async function launch(actions) {
    adb("shell", "am", "force-stop", app);
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "expected a fresh app process");
      pids.add(pid);
      assert.equal(new URL(page.url()).origin, "http://tauri.localhost");
      await page.getByText("Local fixture", { exact: true }).waitFor();
      const panel = page.getByRole("region", { name: "Native session fixture" });
      await panel.waitFor();
      const cdp = await page.context().newCDPSession(page);
      let storageWrites = 0;
      cdp.on("DOMStorage.domStorageItemAdded", () => storageWrites++);
      cdp.on("DOMStorage.domStorageItemUpdated", () => storageWrites++);
      await cdp.send("DOMStorage.enable");
      // Confirm this WebView reports even a short-lived write before testing native actions.
      const control = once(cdp, "DOMStorage.domStorageItemAdded", { signal: AbortSignal.timeout(5000) });
      await page.evaluate(() => {
        sessionStorage.setItem("p0-storage-monitor", "control");
        sessionStorage.removeItem("p0-storage-monitor");
      });
      await control;
      assert.equal(storageWrites, 1);
      storageWrites = 0;
      const consoleChecks = [];
      let pageErrorLeak = false;
      page.on("console", msg => {
        consoleChecks.push(Promise.all(msg.args().map(arg => arg.jsonValue())).then(values =>
          ![msg.text(), JSON.stringify(values)].some(containsMarker), () => false));
      });
      page.on("pageerror", error => { if (containsMarker(error.message)) pageErrorLeak = true; });

      // Observe the actual Tauri callbacks before the Svelte component handles them.
      await page.evaluate(() => {
        const callbacks = window.__TAURI_INTERNALS__.callbacks;
        window.p0Replies = [];
        callbacks.set = function (id, callback) {
          return Map.prototype.set.call(this, id, data => {
            window.p0Replies.push(data);
            return callback(data);
          });
        };
      });
      for (const [button, expected] of actions) {
        await panel.getByRole("button", { name: button, exact: true }).click();
        await page.waitForFunction(() => window.p0Replies.length > 0 &&
          !document.querySelector('[aria-label="Native session fixture"] button').disabled);
        assert.ok(await panel.getByLabel("Native session status").textContent() === expected,
          `expected packaged UI status ${expected}`);
        assert.equal(await page.evaluate(status => {
          const raw = window.p0Replies.splice(0);
          return raw.length === 1 && raw[0] === status;
        }, expected), true, "bridge must return exactly one allowlisted scalar status");
        replies++;
        const store = await page.evaluate(async () => ({
          local: localStorage.length, session: sessionStorage.length, hasCookie: document.cookie !== "",
          databases: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
        }));
        assert.deepEqual(store, { local: 0, session: 0, hasCookie: false, databases: 0, caches: 0 });
        assert.equal((await cdp.send("Network.getCookies", { urls: [page.url()] })).cookies.length, 0);
        assert.ok(!containsMarker(await page.content()), "marker in WebView DOM");
      }
      assert.equal(storageWrites, 0, "unexpected Web Storage write during a native session action");
      assert.ok(!pageErrorLeak && (await Promise.all(consoleChecks)).every(Boolean), "WebView log check failed");
    });
  }

  await launch([["Resume session", "signed-out"], ["Start synthetic session", "fixture-ready"],
    ["Start synthetic session", "unavailable"]]); // Existing record: also inspect the rejection payload.
  const readRecord = () => Buffer.from(adb("shell", "run-as", app, "base64", "no_backup/packaged.bin"), "base64");
  const sealed = readRecord();
  assert.ok(sealed.length > 28 && !sealed.includes(Buffer.from(marker)), "expected protected native record");
  const outage = "cache/p0-provider-offline";
  adb("shell", "run-as", app, "touch", outage);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await launch([["Resume session", "retry-required"]]);
      assert.ok(readRecord().equals(sealed), "denied resume changed the protected record");
    }
  } finally {
    adb("shell", "run-as", app, "rm", "-f", outage);
  }
  await launch([["Resume session", "authenticated"]]);
  const expiry = "cache/p0-provider-expired";
  adb("shell", "run-as", app, "touch", expiry);
  try {
    await launch([["Resume session", "signed-out"]]);
    assert.equal(adb("shell", "run-as", app, "ls", "-A", "no_backup"), "",
      "definitive expiry must remove the protected record");
  } finally {
    adb("shell", "run-as", app, "rm", "-f", expiry);
  }
  // A new seed refuses to overwrite either a stale Keystore alias or a stale file.
  await launch([["Resume session", "signed-out"], ["Start synthetic session", "fixture-ready"]]);
  await launch([["Resume session", "authenticated"], ["Sign out", "signed-out"]]);
  await launch([["Resume session", "signed-out"]]);
  assert.equal(adb("shell", "run-as", app, "ls", "-A", "no_backup"), "");
  let logLines = 0;
  for (const pid of pids) {
    const log = adb("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash", "--pid=" + pid);
    const count = log.split("\n").filter(line => new RegExp("\\s" + pid + "\\s+\\d+\\s+[VDIWEF]\\s").test(line)).length;
    assert.ok(count > 0 && !containsMarker(log), "expected app logs without marker");
    logLines += count;
  }
  console.log("PASS packaged session:", pids.size, "app PIDs,", replies,
    "status-only replies,", logLines, "app log lines; outage preserved ciphertext, expiry cleared the native slot, only a fresh seed restored access, sign-out survived relaunch");
}
