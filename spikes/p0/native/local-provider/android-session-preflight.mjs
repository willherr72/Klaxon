import assert from "node:assert/strict";
import { androidSubscriptionPort } from "../../build-policy.mjs";
import { readFixtureFile } from "../packaged-session/adb-file.mjs";
import { withPreflightReverse } from "./android-preflight.mjs";
import { withScriptedAndroidProvider } from "./scripted-android-provider.mjs";

const inputPath = "cache/p0-local-input.json";
const slot = "no_backup/localprovider.bin";

async function withAndroidTarget({ withActivity, adb, adbBytes, appId }, input, exercise) {
  const pids = new Set();
  const list = path => adb("shell", "run-as", appId, "ls", "-1", path).split(/\r?\n/);
  async function coldLaunch(action) {
    adb("shell", "am", "force-stop", appId);
    assert.equal(adb("shell", "sh", "-c", "'pidof " + appId + " || true'"), "");
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "Expected a fresh Android app process");
      pids.add(pid);
      await page.waitForFunction(() => location.origin === "http://tauri.localhost" &&
        !!document.querySelector('meta[name="p0-android-provider-preflight"][content="loopback-only"]') &&
        !!window.p0LocalProvider && typeof window.__TAURI__?.core?.invoke === "function");
      await action(page);
      if (pids.size === 1) {
        assert.ok(!list("cache").includes("p0-local-input.json"), "One-use input should be consumed");
        const sealed = readFixtureFile(adbBytes, appId, slot);
        assert.ok(sealed.length > 0 && !sealed.includes(input.owner), "Expected a protected owner record");
      }
    });
  }
  // Stdin keeps the one-use input out of process arguments and the WebView.
  const bytes = Buffer.from(JSON.stringify(input));
  try {
    adbBytes(["shell", "-T", "run-as", appId, "sh", "-c", "'umask 077; cat > " + inputPath + "'"], bytes);
    assert.ok(readFixtureFile(adbBytes, appId, inputPath).equals(bytes), "One-use input was not staged intact");
  } finally { bytes.fill(0); }
  function verifySlotCleared() {
    assert.ok(!list("no_backup").some(name => name.startsWith("localprovider.")), "Provider slot should be cleared");
  }
  const result = await exercise(coldLaunch, verifySlotCleared);
  assert.equal(result.status, "passed", "SDK lifecycle failed at " + (result.stage ?? "observation"));
  verifySlotCleared();
  await coldLaunch(async page => {
    assert.equal(await page.evaluate(() => window.__TAURI__.core.invoke("local_resume")), "signed-out");
    assert.ok(await page.evaluate(async () => {
      try { await window.__TAURI__.core.invoke("local_access", { forceRefresh: false }); }
      catch (error) { return error === "signed-out"; }
      return false;
    }), "SDK access should be denied after cold logout");
  });
  assert.equal(pids.size, 3);
  return { ...result, appProcesses: pids.size, inputConsumed: true, coldLogout: true };
}

export async function exerciseAndroidProviderSession(platform) {
  const { adb, adbBytes, appId } = platform;
  return withScriptedAndroidProvider(({ port, input, taskId, title, verify }) =>
    withPreflightReverse(adb, port, async () => {
      const result = await withAndroidTarget(platform, input, async launch => {
        await launch(async page => {
          await page.evaluate(() => window.p0LocalProvider.signIn());
          await page.waitForFunction(() => window.p0LocalProvider.signInResult !== undefined);
          assert.equal(await page.evaluate(() => window.p0LocalProvider.signInResult), "fixture-ready");
        });
        const sealed = readFixtureFile(adbBytes, appId, slot);
        let observation;
        await launch(async page => {
          const denied = await page.evaluate(async () => {
            try { await window.__TAURI__.core.invoke("local_resume"); }
            catch (error) { return error === "retry-required"; }
            return false;
          });
          assert.ok(denied, "A 202 noSession must deny access and preserve the slot for retry");
          assert.ok(readFixtureFile(adbBytes, appId, slot).equals(sealed), "Nondefinitive response changed the slot");
          await page.evaluate(expected => window.p0LocalProvider.observe(expected), { taskId, title });
          await page.waitForFunction(() => window.p0LocalProvider.result !== undefined, undefined, { timeout: 60_000 });
          observation = await page.evaluate(() => window.p0LocalProvider.result);
        });
        return observation;
      });
      verify();
      // Model a stop after key deletion but before acknowledged file cleanup.
      // No live key is present. Only this installed test package's slot is touched.
      adb("shell", "am", "force-stop", appId);
      adb("shell", "run-as", appId, "sh", "-c",
        "'printf inert-orphan > no_backup/localprovider.bin && printf acknowledged > no_backup/localprovider.signout'");
      await platform.withActivity(async page => {
        assert.equal(await page.evaluate(() => window.__TAURI__.core.invoke("local_resume")), "signed-out");
      });
      const files = adb("shell", "run-as", appId, "ls", "-1", "no_backup").split(/\r?\n/);
      assert.ok(!files.some(name => name.startsWith("localprovider.")), "Acknowledged cleanup left a slot file");
      verify();
      return { ...result, acknowledgedCleanupRecovered: true };
    }));
}

// Separate opt-in entry point. The default preflight never enters this function.
export async function exerciseAndroidProviderAcceptance(platform, { reconnect = false } = {}) {
  const { buildControlScript } = await import("./build.mjs");
  const { withLocalBackend } = await import("./backend.mjs");
  const { withLocalProviderScenario } = await import("./provider-controls.mjs");
  const { exerciseLocalProvider } = await import("./check.mjs");
  const { withSubscriptionRelay } = await import("./relay.mjs");
  await buildControlScript();
  try {
    return await withLocalBackend(({ url }) => withPreflightReverse(platform.adb, 3210, () => {
      const exercise = relay => withLocalProviderScenario(url, ({ input, ...controls }) =>
        withAndroidTarget(platform, input, (launch, verifySlotCleared) =>
          exerciseLocalProvider({ launch, ...controls, relay, verifySlotCleared })));
      if (!reconnect) return exercise();
      return withSubscriptionRelay(relay =>
        withPreflightReverse(platform.adb, relay.port,
          () => exercise({ ...relay, port: androidSubscriptionPort }), androidSubscriptionPort));
    }));
  } catch {
    // Provider and browser exceptions can include the session or task arguments.
    throw new Error("Disposable local Android provider acceptance or cleanup failed.");
  }
}
