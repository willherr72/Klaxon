import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { version } from "convex";
import { androidSubscriptionPort } from "../../build-policy.mjs";
import { readFixtureFile } from "../packaged-session/adb-file.mjs";
import { withPreflightReverse } from "./android-preflight.mjs";
import { withScriptedAndroidProvider } from "./scripted-android-provider.mjs";
import { verifyHostedPage } from "./check.mjs";

const inputPath = "cache/p0-local-input.json";
const slot = "no_backup/localprovider.bin";

export async function withAndroidTarget({ withActivity, adb, adbBytes, appId, primaryUser = false }, input, exercise, origin,
  { expectedProcesses = 3 } = {}) {
  const slotName = origin ? "localprovider-hosted-" + createHash("sha256").update(origin).digest("hex") : "localprovider";
  const recordPath = "no_backup/" + slotName + ".bin";
  const pids = new Set();
  const list = path => adb("shell", "run-as", appId, "ls", "-1", path).split(/\r?\n/);
  const verifyPage = page => verifyHostedPage(page, origin, { requireRetirableProbe: primaryUser });
  function readPrivateFile(path) {
    let encoded;
    try {
      return readFixtureFile(args => {
        encoded = adbBytes(args);
        return encoded;
      }, appId, path);
    } finally { encoded?.fill(0); }
  }
  async function coldLaunch(action) {
    adb("shell", "am", "force-stop", ...(primaryUser ? ["--user", "0"] : []), appId);
    assert.equal(adb("shell", "sh", "-c", "'pidof " + appId + " || true'"), "");
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "Expected a fresh Android app process");
      pids.add(pid);
      if (origin) await verifyPage(page);
      else await page.waitForFunction(() => location.origin === "http://tauri.localhost" &&
          !!document.querySelector('meta[name="p0-android-provider-preflight"][content="loopback-only"]') &&
          !!window.p0LocalProvider && typeof window.__TAURI__?.core?.invoke === "function");
      await action(page);
      if (pids.size === 1) {
        assert.ok(!list("cache").includes("p0-local-input.json"), "One-use input should be consumed");
        const sealed = readPrivateFile(recordPath);
        try { assert.ok(sealed.length > 0 && !sealed.includes(input.owner), "Expected a protected owner record"); }
        finally { sealed.fill(0); }
      }
    });
  }
  function verifySlotCleared() {
    assert.ok(!list("no_backup").some(name => name.startsWith(slotName + ".")), "Provider slot should be cleared");
  }
  if (origin) await withActivity(verifyPage);
  // Stdin keeps the one-use input out of process arguments and the WebView.
  const bytes = Buffer.from(JSON.stringify(input));
  try {
    let staged;
    try {
      adbBytes(["shell", "-T", "run-as", appId, "sh", "-c", "'umask 077; cat > " + inputPath + "'"], bytes);
      staged = readPrivateFile(inputPath);
      assert.ok(staged.equals(bytes), "One-use input was not staged intact");
    } finally {
      staged?.fill(0);
      bytes.fill(0);
    }
    const result = await exercise(coldLaunch, verifySlotCleared);
    if (origin && result.status !== "passed") console.error("Android hosted observation", {
      status: result.status, stage: result.stage ?? "subscription result",
    });
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
    assert.equal(pids.size, expectedProcesses);
    return { ...result, appProcesses: pids.size, inputConsumed: true, coldLogout: true };
  } catch (error) {
    // A failed ADB command can still have landed. Retry removal if its acknowledgment was lost.
    const removeInput = () => adb("shell", "run-as", appId, "rm", "-f", inputPath);
    try { removeInput(); }
    catch {
      try { removeInput(); }
      catch { throw Error("Android one-use input cleanup unconfirmed"); }
    }
    throw error;
  }
}

export async function verifyOfflineWebView(page) {
  const httpUrl = "http://127.0.0.1:3210/api/query";
  const socketUrl = `ws://127.0.0.1:3210/api/${version}/sync`;
  let httpError;
  let socketError;
  const onRequestFailed = request => {
    if (request.url() === httpUrl) httpError = request.failure()?.errorText;
  };
  const onSocket = socket => {
    if (socket.url() === socketUrl) socket.once("socketerror", error => { socketError = error; });
  };
  page.on("requestfailed", onRequestFailed);
  page.on("websocket", onSocket);
  try {
    const probe = await page.evaluate(async ({ httpUrl, socketUrl }) => {
      const httpFailure = fetch(httpUrl, {
        cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(5000),
      }).then(() => false, error => error instanceof TypeError);
      const socketFailure = new Promise(resolve => {
        const socket = new WebSocket(socketUrl);
        const finish = result => {
          clearTimeout(timeout);
          socket.onopen = socket.onclose = socket.onerror = null;
          socket.close();
          resolve(result);
        };
        const timeout = setTimeout(() => finish(false), 5000);
        socket.onerror = () => finish(true);
        socket.onopen = socket.onclose = () => finish(false);
      });
      const [http, webSocket] = await Promise.all([httpFailure, socketFailure]);
      return { http, webSocket };
    }, { httpUrl, socketUrl });
    assert.deepEqual(probe, { http: true, webSocket: true });
    assert.match(httpError ?? "", /^net::ERR_CONNECTION_REFUSED$/, "Expected Chromium HTTP connection refusal");
    assert.match(socketError ?? "", /\bnet::ERR_CONNECTION_REFUSED\b/, "Expected Chromium WebSocket connection refusal");
  } finally {
    page.off("requestfailed", onRequestFailed);
    page.off("websocket", onSocket);
  }
}

export async function exerciseAndroidRouteOutage(platform) {
  const { adb, adbBytes, appId } = platform;
  function requireDisconnected() {
    assert.equal(adb("shell", "settings", "get", "global", "airplane_mode_on"), "1");
    assert.equal(adb("shell", "settings", "get", "global", "wifi_on"), "0");
    assert.match(adb("shell", "dumpsys", "connectivity"), /^Active default network:[ \t]*none[ \t]*\r?$/m);
    assert.equal(adb("reverse", "--list"), "", "Provider reverse routes must be absent during the cut");
  }
  return withScriptedAndroidProvider(async ({ port, input, taskId, title, providerRequests, providerConnections, verify }) => {
    const route = action => withPreflightReverse(adb, port, action);
    const trafficCounts = () => [providerRequests(), providerConnections()];
    const result = await withAndroidTarget(platform, input, async launch => {
      const before = await route(async () => {
        await launch(async page => {
          await page.evaluate(() => window.p0LocalProvider.signIn());
          await page.waitForFunction(() => window.p0LocalProvider.signInResult !== undefined);
          assert.equal(await page.evaluate(() => window.p0LocalProvider.signInResult), "fixture-ready");
        });
        return trafficCounts();
      });
      const sealed = readFixtureFile(adbBytes, appId, slot);
      try {
        requireDisconnected();
        await launch(async page => {
          requireDisconnected();
          assert.equal(await page.evaluate(() => window.p0LocalProvider.origin), "http://127.0.0.1:3210");
          const denial = await page.evaluate(async () => {
            const rejectsAs = async (command, expected, args) => {
              try { await window.__TAURI__.core.invoke(command, args); }
              catch (error) { return error === expected; }
              return false;
            };
            return {
              resume: await rejectsAs("local_resume", "retry-required"),
              access: await rejectsAs("local_access", "signed-out", { forceRefresh: false }),
            };
          });
          assert.deepEqual(denial, { resume: true, access: true }, "Cut must deny resume and SDK access");
          assert.equal(await page.getByRole("list", { name: "Local provider tasks" }).getByRole("listitem").count(), 0);
          await verifyOfflineWebView(page);
        });
        requireDisconnected();
        assert.deepEqual(trafficCounts(), before, "Issuer received traffic during the route cut");
        const after = readFixtureFile(adbBytes, appId, slot);
        try { assert.ok(after.equals(sealed), "Disconnected resume changed the sealed slot"); }
        finally { after.fill(0); }
      } finally { sealed.fill(0); }
      let observation;
      await route(() => launch(async page => {
        await page.evaluate(expected => window.p0LocalProvider.observe(expected), { taskId, title });
        await page.waitForFunction(() => window.p0LocalProvider.result !== undefined, undefined, { timeout: 60_000 });
        observation = await page.evaluate(() => window.p0LocalProvider.result);
      }));
      return observation;
    }, undefined, { expectedProcesses: 4 });
    requireDisconnected();
    verify();
    return { ...result, providerRouteRemoved: true, nativeResumeDenied: true, offlineTransportsFailed: true,
      sealedSlotPreserved: true, providerConnectionsDuringCut: 0, providerRequestsDuringCut: 0 };
  }, { routeOutage: true });
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
