import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { WebSocketServer } from "ws";

const loopback = "127.0.0.1";
const productOrigin = "http://tauri.localhost";
const devicePort = 3210;
const deviceSocket = "tcp:" + devicePort;
const deviceOrigin = `http://${loopback}:${devicePort}`;
const mutation = {
  path: "auth:refreshSession",
  format: "convex_encoded_json",
  args: [{ refreshToken: "klaxon-p0-inert-android-preflight" }],
};

function reverseDestinations(adb) {
  return adb("reverse", "--list").split(/\r?\n/)
    .map(line => line.trim().split(/\s+/).slice(-2))
    .filter(([source]) => source === deviceSocket)
    .map(([, target]) => target);
}

function removeOwnedReverse(adb, destination) {
  const current = reverseDestinations(adb);
  if (!current.includes(destination)) return;
  assert.equal(current.length, 1);
  try {
    adb("reverse", "--remove", deviceSocket);
  } catch {
    // A lost acknowledgment can also occur on removal. Confirm device state below.
  }
  assert.ok(!reverseDestinations(adb).includes(destination));
}

// hostPort must belong to the caller's already listening IPv4 loopback server.
export async function withPreflightReverse(deviceAdb, hostPort, action) {
  try {
    assert.ok(Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535);
    assert.equal(reverseDestinations(deviceAdb).length, 0);
  } catch {
    throw new Error("Android provider preflight failed during reverse mapping admission.");
  }

  // A failed setup can be reconciled by its ephemeral destination. The fixed backend port
  // is shared by live acceptance runs, so its route requires a successful setup acknowledgment.
  const destination = "tcp:" + hostPort;
  let acknowledged = false;
  try {
    try {
      deviceAdb("reverse", "--no-rebind", deviceSocket, destination);
      acknowledged = true;
      assert.ok(isDeepStrictEqual(reverseDestinations(deviceAdb), [destination]));
    } catch {
      throw new Error("Android provider preflight failed during reverse mapping setup.");
    }
    return await action();
  } finally {
    if (acknowledged || hostPort !== devicePort) {
      try {
        removeOwnedReverse(deviceAdb, destination);
      } catch {
        throw new Error("Android provider preflight could not confirm reverse mapping cleanup.");
      }
    }
  }
}

async function matchesMutation(req) {
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024) return false;
      chunks.push(chunk);
    }
    return isDeepStrictEqual(JSON.parse(Buffer.concat(chunks)), mutation);
  } catch {
    return false;
  }
}

// Call inside the disposable install guard. withActivity supplies the verified app's CDP page and PID.
export async function exerciseAndroidProviderPreflight(withActivity, deviceAdb, appId) {
  const challenge = randomUUID();
  const httpPath = "/p0-android-provider/http?challenge=" + challenge;
  const webSocketPath = "/p0-android-provider/ws";
  const httpReceipt = randomUUID();
  const webSocketReceipt = randomUUID();
  const sockets = new Set();
  const peers = new WebSocketServer({ noServer: true, maxPayload: 128, perMessageDeflate: false });
  let allowance;
  let observed;
  let unexpected = false;
  function consume(kind) {
    if (allowance !== kind || unexpected) return false;
    allowance = undefined;
    return true;
  }

  const server = createServer(async (req, res) => {
    function reject() {
      unexpected = true;
      if (res.destroyed) return;
      res.writeHead(400, { Connection: "close", "Cache-Control": "no-store" });
      res.end();
    }

    if (req.headers.authorization || req.headers.cookie) return reject();
    if (req.method === "GET" && req.url === httpPath && req.headers.origin === productOrigin && consume("http")) {
      observed = "http";
      res.writeHead(200, { "Access-Control-Allow-Origin": productOrigin, "Cache-Control": "no-store",
        "Content-Type": "text/plain", Connection: "close" });
      res.end(httpReceipt);
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/mutation" || req.headers.origin !== undefined ||
        req.headers["content-type"] !== "application/json" || !consume("native") || !await matchesMutation(req)) {
      return reject();
    }

    observed = "native";
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" });
    res.end(JSON.stringify({ status: "success", value: { kind: "noSession" } }));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", () => { unexpected = true; });
  function rejectSocket(socket) {
    unexpected = true;
    socket.destroy();
  }
  server.on("clientError", (_error, socket) => rejectSocket(socket));
  server.on("connect", (_req, socket) => rejectSocket(socket));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== webSocketPath || req.headers.origin !== productOrigin || req.headers.authorization ||
        req.headers.cookie || !consume("websocket")) return rejectSocket(socket);
    peers.handleUpgrade(req, socket, head, peer => {
      peer.on("error", () => { unexpected = true; });
      peer.on("message", (data, isBinary) => {
        if (observed !== "http" || isBinary || data.toString() !== challenge) {
          unexpected = true;
          peer.terminate();
          return;
        }
        observed = "websocket";
        peer.send(webSocketReceipt);
      });
    });
  });

  let stage = "WebView activity launch";
  async function checkPage(page, pid) {
    stage = "packaged WebView verification";
    assert.ok(/^\d+$/.test(pid) && deviceAdb("shell", "pidof", appId) === pid);
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    assert.ok(await page.evaluate(origin => {
      const markers = document.head.querySelectorAll('meta[name="p0-android-provider-preflight"]');
      return location.origin === origin && markers.length === 1 && markers[0].content === "loopback-only" &&
        typeof window.__TAURI__?.core?.invoke === "function";
    }, productOrigin));

    stage = "WebView HTTP round trip";
    allowance = "http";
    const httpReply = await page.evaluate(async url => {
      const response = await fetch(url, { cache: "no-store", credentials: "omit", redirect: "error",
        signal: AbortSignal.timeout(10_000) });
      return response.ok ? await response.text() : null;
    }, deviceOrigin + httpPath);
    assert.ok(!unexpected && observed === "http" && httpReply === httpReceipt);

    stage = "WebView WebSocket round trip";
    allowance = "websocket";
    const wsReply = await page.evaluate(({ url, challenge }) => new Promise(resolve => {
      const socket = new WebSocket(url);
      function finish(reply) {
        clearTimeout(timer);
        socket.close();
        resolve(reply);
      }
      const timer = setTimeout(() => finish(null), 10_000);
      socket.addEventListener("open", () => socket.send(challenge), { once: true });
      socket.addEventListener("message", event => finish(typeof event.data === "string" ? event.data : null), { once: true });
      socket.addEventListener("error", () => finish(null), { once: true });
      socket.addEventListener("close", () => finish(null), { once: true });
    }), { url: deviceOrigin.replace(/^http/, "ws") + webSocketPath, challenge });
    assert.ok(!unexpected && observed === "websocket" && wsReply === webSocketReceipt);

    stage = "native refresh verification";
    allowance = "native";
    const noSession = await page.evaluate(async () => {
      let timer;
      try {
        return await Promise.race([
          window.__TAURI__.core.invoke("android_provider_preflight").then(value => value === "no-session"),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 15_000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    });
    assert.ok(!unexpected && observed === "native" && noSession);
    stage = "WebView activity cleanup";
  }

  try {
    try {
      const listening = once(server, "listening");
      server.listen({ host: loopback, port: 0, exclusive: true });
      await listening;
    } catch {
      throw new Error("Android provider preflight failed during loopback listener setup.");
    }
    return await withPreflightReverse(deviceAdb, server.address().port, async () => {
      try {
        await withActivity(checkPage);
        assert.ok(!unexpected && observed === "native");
        return { webviewHttp: true, webviewWebSocket: true, nativeRefresh: "no-session" };
      } catch {
        throw new Error("Android provider preflight failed during " + stage +
          (unexpected ? " (unexpected loopback request)." : "."));
      }
    });
  } finally {
    for (const peer of peers.clients) peer.terminate();
    for (const socket of sockets) socket.destroy();
    const peersClosed = new Promise(resolve => peers.close(resolve));
    const listenerClosed = server.listening ? new Promise(resolve => server.close(resolve)) : undefined;
    await Promise.all([peersClosed, listenerClosed]);
  }
}
