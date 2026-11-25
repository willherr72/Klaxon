import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import WebSocket from "ws";
import { exerciseAndroidProviderPreflight, withPreflightReverse } from "./android-preflight.mjs";

const app = "dev.klaxon.p0native";
const productOrigin = "http://tauri.localhost";
const deviceOrigin = "http://127.0.0.1:3210";
const inertMutation = {
  path: "auth:refreshSession", format: "convex_encoded_json",
  args: [{ refreshToken: "klaxon-p0-inert-android-preflight" }],
};

function adapters({ existing, competing, lostAck, missingMarker, staleReceipt, duplicate,
  invalidMutation, browserMutation, leavePeerOpen } = {}) {
  let mapping = existing;
  let hostOrigin;
  let mapped = 0;
  let removed = 0;
  let launches = 0;
  let fetched = 0;
  let invoked = 0;
  let peerClosed;

  function adb(...args) {
    if (args[0] === "reverse") {
      if (args[1] === "--list") return mapping ? `host-1 tcp:3210 ${mapping}\nhost-1 tcp:9988 tcp:9989` : "host-1 tcp:9988 tcp:9989";
      if (args[1] === "--no-rebind") {
        assert.equal(args[2], "tcp:3210");
        assert.match(args[3], /^tcp:\d+$/);
        assert.equal(mapping, undefined);
        mapped++;
        hostOrigin = "http://127.0.0.1:" + args[3].slice(4);
        mapping = competing ?? args[3];
        if (competing) throw Error("device port was claimed during setup");
        if (lostAck) throw Error("unstable transport with private diagnostic");
        return "";
      }
      assert.deepEqual(args, ["reverse", "--remove", "tcp:3210"]);
      assert.ok(mapping && mapping !== existing);
      removed++;
      mapping = undefined;
      return "";
    }
    assert.deepEqual(args, ["shell", "pidof", app]);
    return "2468";
  }

  async function withActivity(action) {
    launches++;
    const globals = {
      location: { origin: productOrigin },
      document: { head: { querySelectorAll(selector) {
        assert.equal(selector, 'meta[name="p0-android-provider-preflight"]');
        return missingMarker ? [] : [{ content: "loopback-only" }];
      } } },
      AbortSignal, setTimeout, clearTimeout,
      async fetch(target, options) {
        fetched++;
        const url = new URL(target);
        assert.equal(url.origin, deviceOrigin);
        assert.equal(options.credentials, "omit");
        assert.equal(options.cache, "no-store");
        const response = await fetch(hostOrigin + url.pathname + url.search,
          { ...options, headers: { Origin: productOrigin } });
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), productOrigin);
        if (!staleReceipt) return response;
        await response.text();
        return new Response("cached private diagnostic");
      },
      WebSocket: function (target) {
        const url = new URL(target);
        assert.equal(url.origin, deviceOrigin.replace(/^http/, "ws"));
        const peer = new WebSocket(hostOrigin.replace(/^http/, "ws") + url.pathname + url.search, { origin: productOrigin });
        peerClosed = new Promise(resolve => peer.once("close", resolve));
        if (leavePeerOpen) peer.close = () => {};
        return peer;
      },
      window: { __TAURI__: { core: { async invoke(command) {
        assert.equal(command, "android_provider_preflight");
        invoked++;
        const request = () => fetch(hostOrigin + "/api/mutation", {
          method: "POST", headers: { "Content-Type": "application/json",
            ...(browserMutation && { Origin: productOrigin }) },
          body: JSON.stringify(invalidMutation ? { ...inertMutation, extra: "private diagnostic" } : inertMutation),
        });
        const response = await request();
        if (duplicate) assert.equal((await request()).status, 400);
        if (!response.ok) throw Error("private diagnostic from native command");
        assert.deepEqual(await response.json(), { status: "success", value: { kind: "noSession" } });
        return "no-session";
      } } } },
    };
    return await action({
      waitForLoadState: async () => {},
      evaluate: (evaluate, input) => runInNewContext(`(${evaluate}) (input)`, { ...globals, input }),
    }, "2468");
  }

  return {
    adb,
    run: () => exerciseAndroidProviderPreflight(withActivity, adb, app),
    counts: () => ({ mapped, removed, launches, fetched, invoked }),
    mapping: () => mapping,
    async assertClosed() {
      assert.equal(mapping, undefined);
      assert.equal(removed, 1);
      await assert.rejects(fetch(hostOrigin, { signal: AbortSignal.timeout(2000) }));
      if (peerClosed) await peerClosed;
    },
  };
}

test("requires a live HTTP receipt, WebSocket exchange and exactly one inert native refresh", async () => {
  const fixture = adapters();
  assert.deepEqual(await fixture.run(), { webviewHttp: true, webviewWebSocket: true, nativeRefresh: "no-session" });
  assert.deepEqual(fixture.counts(), { mapped: 1, removed: 1, launches: 1, fetched: 1, invoked: 1 });
  await fixture.assertClosed();
});

test("refuses a preexisting device route without changing it or opening the WebView", async () => {
  const fixture = adapters({ existing: "tcp:45678" });
  await assert.rejects(fixture.run(), /reverse mapping admission/);
  assert.equal(fixture.mapping(), "tcp:45678");
  assert.deepEqual(fixture.counts(), { mapped: 0, removed: 0, launches: 0, fetched: 0, invoked: 0 });
});

test("reconciles an installed reverse mapping after a lost acknowledgment", async () => {
  const fixture = adapters({ lostAck: true });
  await assert.rejects(fixture.run(), { message: "Android provider preflight failed during reverse mapping setup." });
  assert.equal(fixture.counts().launches, 0);
  await fixture.assertClosed();
});

test("preserves a foreign route claimed between admission and creation", async () => {
  const fixture = adapters({ competing: "tcp:45678" });
  await assert.rejects(fixture.run(), /reverse mapping setup/);
  assert.equal(fixture.mapping(), "tcp:45678");
  assert.deepEqual(fixture.counts(), { mapped: 1, removed: 0, launches: 0, fetched: 0, invoked: 0 });
});

test("preserves a competing reverse route to the fixed backend after setup fails", async () => {
  const fixture = adapters({ competing: "tcp:3210" });
  await assert.rejects(withPreflightReverse(fixture.adb, 3210, () => assert.fail("action should not run")),
    /reverse mapping setup/);
  assert.equal(fixture.mapping(), "tcp:3210");
  assert.equal(fixture.counts().removed, 0);
});

test("checks the packaged marker before network traffic", async () => {
  const fixture = adapters({ missingMarker: true });
  await assert.rejects(fixture.run(), /packaged WebView verification/);
  assert.equal(fixture.counts().fetched, 0);
  await fixture.assertClosed();
});

test("rejects a stale HTTP receipt and skips native invocation", async () => {
  const fixture = adapters({ staleReceipt: true });
  await assert.rejects(fixture.run(), { message: "Android provider preflight failed during WebView HTTP round trip." });
  assert.equal(fixture.counts().invoked, 0);
  await fixture.assertClosed();
});

test("rejects extra native mutations and terminates an open WebSocket on failure", { timeout: 5000 }, async () => {
  const fixture = adapters({ duplicate: true, leavePeerOpen: true });
  await assert.rejects(fixture.run(), /native refresh verification.*unexpected loopback request/);
  await fixture.assertClosed();
});

test("rejects a mutation body with extra data and reports only the failed stage", async () => {
  const fixture = adapters({ invalidMutation: true });
  await assert.rejects(fixture.run(), {
    message: "Android provider preflight failed during native refresh verification (unexpected loopback request).",
  });
  await fixture.assertClosed();
});

test("does not accept a WebView request as the native mutation", async () => {
  const fixture = adapters({ browserMutation: true });
  await assert.rejects(fixture.run(), /native refresh verification.*unexpected loopback request/);
  await fixture.assertClosed();
});

test("an acknowledged fixed backend reverse route is removed on success and callback failure", async () => {
  let route = "";
  function adb(...args) {
    switch (args[1]) {
      case "--list": return route;
      case "--no-rebind":
        assert.deepEqual(args, ["reverse", "--no-rebind", "tcp:3210", "tcp:3210"]);
        route = "host-1 tcp:3210 tcp:3210";
        return "";
      case "--remove":
        assert.deepEqual(args, ["reverse", "--remove", "tcp:3210"]);
        route = "";
        return "";
      default: assert.fail("Unexpected fake ADB command");
    }
  }

  assert.equal(await withPreflightReverse(adb, 3210, () => {
    assert.ok(route);
    return "evidence";
  }), "evidence");
  assert.equal(route, "");
  await assert.rejects(withPreflightReverse(adb, 3210, async () => {
    assert.ok(route);
    throw Error("callback failure");
  }), /callback failure/);
  assert.equal(route, "");
});
