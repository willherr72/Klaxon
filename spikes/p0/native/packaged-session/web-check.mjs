import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";

// Build the expected canary in the test runner. Never inject it into the WebView or logs.
const marker = "KLAXON-P0-INERT/";
const representations = [marker, ...[1, 2].flatMap(owner => {
  const bytes = Buffer.from(marker + "packaged/" + owner);
  return [bytes.toString("base64"), bytes.toString("hex")];
})];
export const containsMarker = value => representations.some(form => value.includes(form));
const rotatedAccess = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.cDAtbm90LWEtc2lnbmF0dXJl";
const rotatedAccessDigest = createHash("sha256").update(rotatedAccess).digest("hex");
const accessForms = ["p0-inert-access-a", rotatedAccess, "p0-inert-access-b"].flatMap(access =>
  [access, Buffer.from(access).toString("base64"), Buffer.from(access).toString("hex")]);
export const containsSdkAccess = value => accessForms.some(form => value.includes(form));
// The longest form may be stored as UTF-16LE and split at any byte.
export const canaryOverlap = 2 * Math.max(...[...representations, ...accessForms].map(form => form.length)) - 1;

export async function checkSessionPage(page, actions, sdkPlatform) {
  const sdk = sdkPlatform !== undefined;
  if (sdk) assert.ok(["android", "windows"].includes(sdkPlatform), "unknown SDK fixture platform");
  assert.equal(new URL(page.url()).origin, "http://tauri.localhost");
  await page.getByText("Local fixture", { exact: true }).waitFor();
  const panel = page.getByRole("region", { name: sdk ? "SDK session fixture" : "Native session fixture" });
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
  const leaks = text => containsMarker(text) || (sdk && containsSdkAccess(text));
  let externalRequests = 0;
  const observeUrl = url => {
    const { protocol, hostname } = new URL(url);
    if (["http:", "https:", "ws:", "wss:"].includes(protocol) &&
        !["tauri.localhost", "ipc.localhost"].includes(hostname)) externalRequests++;
  };
  if (sdk) {
    page.on("request", req => observeUrl(req.url()));
    page.on("websocket", socket => observeUrl(socket.url()));
  }
  page.on("console", msg => {
    consoleChecks.push(Promise.all(msg.args().map(arg => arg.jsonValue())).then(values =>
      ![msg.text(), JSON.stringify(values)].some(leaks), () => false));
  });
  page.on("pageerror", error => { if (leaks(error.message)) pageErrorLeak = true; });

  // Observe the actual Tauri callbacks before the Svelte component handles them.
  await page.evaluate(({ sdk, android, rotatedAccessDigest, rotatedAccessLength }) => {
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    window.p0Replies = [];
    // Attribute a reply to the actual SDK command before recording its access generation.
    const accessCallbacks = new Set();
    const accessErrors = new Set();
    if (sdk) {
      const bridge = android ? window.ipc : window.chrome.webview;
      const nativePost = bridge.postMessage.bind(bridge);
      const postMessage = function (data) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.cmd === "fixture_sdk_access") {
            accessCallbacks.add(frame.callback);
            accessErrors.add(frame.error);
          }
        }
        return nativePost(data);
      };
      if (android) {
        // Wry's JavaScript interface can expose a read-only method on Android.
        window.ipc = { postMessage };
        if (window.ipc.postMessage !== postMessage) throw new Error("Could not observe Android IPC");
      } else {
        bridge.postMessage = postMessage;
        const originalFetch = window.fetch;
        window.fetch = function (input, init) {
          if (String(input) === "http://ipc.localhost/fixture_sdk_access") {
            accessCallbacks.add(Number(init.headers.get("Tauri-Callback")));
            accessErrors.add(Number(init.headers.get("Tauri-Error")));
          }
          return originalFetch.call(this, input, init);
        };
      }
    }
    callbacks.set = function (id, callback) {
      return Map.prototype.set.call(this, id, data => {
        let observed = data;
        if (accessCallbacks.delete(id)) {
          const access = typeof data === "string" && /^p0-inert-access-([ab])$/.exec(data);
          observed = access ? "sdk-access-" + access[1] + "1" : "unexpected-sdk-reply";
          if (typeof data === "string" && data.length === rotatedAccessLength) {
            const replies = window.p0Replies;
            const index = replies.length;
            void crypto.subtle.digest("SHA-256", new TextEncoder().encode(data)).then(bytes => {
              const digest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
              if (digest === rotatedAccessDigest) replies[index] = "sdk-access-a2";
            });
          }
        } else if (accessErrors.delete(id)) {
          observed = ["signed-out", "retry-required", "unavailable"].includes(data)
            ? "sdk-denial-" + data : "unexpected-sdk-reply";
        }
        window.p0Replies.push(observed);
        return callback(data);
      });
    };
  }, { sdk, android: sdkPlatform === "android", rotatedAccessDigest, rotatedAccessLength: rotatedAccess.length });
  async function checkPageState() {
    const store = await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length, hasCookie: document.cookie !== "",
      databases: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
    }));
    assert.deepEqual(store, { local: 0, session: 0, hasCookie: false, databases: 0, caches: 0 });
    assert.equal((await cdp.send("Network.getCookies", { urls: [page.url()] })).cookies.length, 0);
    assert.ok(!leaks(await page.content()), "session material in WebView DOM or inline bundle");
    if (sdk) {
      const evidence = await page.evaluate(() => {
        const { evidence, accessRequests } = window.p0SdkFixture;
        return JSON.stringify({ evidence, accessRequests });
      });
      assert.ok(!leaks(evidence), "session material in WebView fixture evidence");
    }
  }

  for (const action of actions) {
    if (typeof action === "function") {
      await action(page, panel, checkPageState);
      if (sdk) {
        const clean = await page.evaluate(() => window.p0Replies.every(reply =>
          ["authenticated", "signed-out", "fixture-ready", "unavailable", "retry-required", "sdk-access-a1", "sdk-access-a2", "sdk-access-b1",
            "sdk-denial-signed-out", "sdk-denial-retry-required", "sdk-denial-unavailable"].includes(reply)));
        assert.ok(clean, "unexpected reply from packaged SDK bridge");
      }
      assert.ok(!leaks(await page.evaluate(() => JSON.stringify(window.p0Replies))), "unexpected session material in bridge");
      await page.evaluate(() => { window.p0Replies.length = 0; });
    } else {
      const [button, expected] = action;
      await panel.getByRole("button", { name: button, exact: true }).click();
      await page.waitForFunction(() => window.p0Replies.length > 0 &&
        !document.querySelector('[aria-label="Native session fixture"] button').disabled);
      assert.ok(await panel.getByLabel("Native session status").textContent() === expected,
        `expected packaged UI status ${expected}`);
      assert.equal(await page.evaluate(status => {
        const raw = window.p0Replies.splice(0);
        return raw.length === 1 && raw[0] === status;
      }, expected), true, "bridge must return exactly one allowlisted scalar status");
    }
    await checkPageState();
  }
  assert.equal(storageWrites, 0, "unexpected Web Storage write during a native session action");
  assert.ok(!pageErrorLeak && (await Promise.all(consoleChecks)).every(Boolean), "WebView log check failed");
  assert.equal(externalRequests, 0, "external requests from the SDK fixture");
}
