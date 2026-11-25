import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection } from "node:net";
import test from "node:test";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import WebSocket from "ws";
import { withScriptedAndroidProvider } from "./scripted-android-provider.mjs";

const packagedOrigin = "http://tauri.localhost";

class PackagedOriginSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: packagedOrigin });
  }
}

function mutation(origin, path, args) {
  return fetch(origin + "/api/mutation", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, format: "convex_encoded_json", args: [args] }),
  });
}

async function verifyNativeLifecycle({ routeOutage }) {
  const port = await withScriptedAndroidProvider(async ({ port, input: { username, password, owner }, taskId, title,
    verify, providerRequests }) => {
    const origin = `http://127.0.0.1:${port}`;
    const post = async (path, args) => {
      const response = await mutation(origin, path, args);
      assert.equal(response.status, 200);
      const envelope = await response.json();
      assert.equal(envelope.status, "success");
      return envelope.value;
    };
    assert.equal(providerRequests(), 0);
    const signIn = await post("auth:signInWithUsernamePassword", { username, password });
    assert.equal(signIn.status, "complete");
    assert.equal(providerRequests(), 1);
    const initialRefresh = { refreshToken: signIn.tokens.refreshToken };
    if (!routeOutage) {
      const nonauthoritative = await mutation(origin, "auth:refreshSession", initialRefresh);
      assert.equal(nonauthoritative.status, 202);
      assert.deepEqual(await nonauthoritative.json(), { status: "success", value: { kind: "noSession" }, logLines: [] });
    }
    const rotated = await post("auth:refreshSession", initialRefresh);
    assert.equal(rotated.kind, "rotated");
    assert.equal(providerRequests(), routeOutage ? 2 : 3);
    assert.equal(rotated.tokens.userId, owner);
    assert.ok(rotated.tokens.accessToken !== signIn.tokens.accessToken);
    assert.ok(rotated.tokens.refreshToken !== signIn.tokens.refreshToken);
    const bearer = rotated.tokens.accessToken;
    const [header, claims, signature] = bearer.split(".");
    const decode = segment => JSON.parse(Buffer.from(segment, "base64url"));
    assert.equal(decode(header).alg, "RS256");
    assert.match(signature, /^[A-Za-z0-9_-]+$/);
    const { sub, iss, aud, iat, exp } = decode(claims);
    assert.notEqual(sub, owner);
    assert.equal(decode(signIn.tokens.accessToken.split(".")[1]).sub, sub);
    assert.equal(iss, "http://127.0.0.1:3210/components/auth");
    assert.equal(aud, "convex-auth");
    assert.ok(Math.abs(Date.now() / 1000 - iat) < 5 && exp > Date.now() / 1000 + 5);

    const preflight = await fetch(origin + "/api/query", { method: "OPTIONS", headers: {
      Origin: packagedOrigin, "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,convex-client",
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), packagedOrigin);
    assert.deepEqual(preflight.headers.get("access-control-allow-headers").split(", "),
      ["authorization", "content-type", "convex-client"]);
    const http = new ConvexHttpClient(origin, { auth: bearer, logger: false, fetch: async (url, init) => {
      const response = await fetch(url, { ...init, headers: { ...init.headers, Origin: packagedOrigin } });
      assert.equal(response.headers.get("access-control-allow-origin"), packagedOrigin);
      return response;
    } });
    const read = () => Promise.all([http.query(api.auth.isAuthenticated), http.query(api.tasks.list)]);
    const rows = [{ _id: taskId, title }];
    assert.deepEqual(await read(), [true, rows]);
    const beforeSocket = providerRequests();
    assert.equal(beforeSocket, routeOutage ? 5 : 6);

    const client = new ConvexClient(origin, { webSocketConstructor: PackagedOriginSocket, logger: false,
      expectAuth: true, initialAuthTokenReuse: true });
    let forcedRefreshes = 0;
    try {
      client.setAuth(async ({ forceRefreshToken }) => {
        if (forceRefreshToken) forcedRefreshes++;
        return bearer;
      });
      let markReady;
      let markCleared;
      const ready = new Promise(resolve => { markReady = resolve; });
      const cleared = new Promise(resolve => { markCleared = resolve; });
      client.onUpdate(api.tasks.list, {}, tasks => tasks.length ? markReady(tasks) : markCleared(tasks));
      assert.deepEqual(await ready, rows);
      assert.equal(providerRequests(), beforeSocket + 1);
      const before = client.connectionState().connectionCount;
      const args = { refreshToken: rotated.tokens.refreshToken };
      assert.equal(await post("auth:signOut", args), null);
      assert.deepEqual(await post("auth:refreshSession", args), { kind: "noSession" });
      assert.deepEqual(await cleared, []);
      assert.deepEqual(await read(), [false, []]);
      assert.equal(providerRequests(), beforeSocket + 5);
      assert.ok(client.connectionState().isWebSocketConnected);
      assert.equal(client.connectionState().connectionCount, before);
      assert.equal(forcedRefreshes, 0);
      verify();
    } finally {
      await client.close();
    }
    return port;
  }, routeOutage ? { routeOutage: true } : undefined);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/query`));
}

test("rotates the native grant and clears the real SDK's existing subscription on sign-out", { timeout: 10_000 },
  () => verifyNativeLifecycle({ routeOutage: false }));

test("rotates on the first refresh in route-outage mode and counts HTTP requests and the WebSocket upgrade",
  { timeout: 10_000 }, () => verifyNativeLifecycle({ routeOutage: true }));

test("renews through the live SDK and publishes through the original task subscription", { timeout: 10_000 },
  async () => withScriptedAndroidProvider(async ({ port, input, taskId, title, renewedTitle, phase, publishRenewedTask, verify }) => {
    const origin = `http://127.0.0.1:${port}`;
    async function native(path, args) {
      const response = await mutation(origin, path, args);
      assert.equal(response.status, 200);
      return (await response.json()).value;
    }
    const { username, password } = input;
    const { tokens: signedIn } = await native("auth:signInWithUsernamePassword", { username, password });
    const refresh = tokens => native("auth:refreshSession", { refreshToken: tokens.refreshToken });
    const { tokens: cold } = await refresh(signedIn);
    assert.ok(cold.refreshToken !== signedIn.refreshToken);

    const client = new ConvexClient(origin, { webSocketConstructor: PackagedOriginSocket, logger: false,
      expectAuth: true, initialAuthTokenReuse: true, authRefreshTokenLeewaySeconds: 19 });
    try {
      let renewed;
      let forcedRefreshes = 0;
      let initialRows;
      let updateRows;
      let revokedRows;
      const initial = new Promise(resolve => { initialRows = resolve; });
      const update = new Promise(resolve => { updateRows = resolve; });
      const revoked = new Promise(resolve => { revokedRows = resolve; });
      const received = [];
      client.setAuth(async ({ forceRefreshToken }) => {
        if (!forceRefreshToken) return cold.accessToken;
        forcedRefreshes++;
        const next = await refresh(cold);
        renewed = next.tokens;
        return renewed.accessToken;
      });
      client.onUpdate(api.tasks.list, {}, rows => {
        received.push(rows);
        if (rows[0]?.title === title) initialRows(rows);
        if (rows[0]?.title === renewedTitle) updateRows(rows);
        if (rows.length === 0) revokedRows(rows);
      });
      assert.deepEqual(await initial, [{ _id: taskId, title }]);
      const { connectionCount } = client.connectionState();
      assert.equal(forcedRefreshes, 0);
      assert.throws(publishRenewedTask, /awaiting successor authentication/);

      for (let attempt = 0; attempt < 80 && phase() !== "successor-authenticated"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      publishRenewedTask();
      assert.equal(forcedRefreshes, 1);
      assert.ok(renewed.refreshToken !== cold.refreshToken);
      assert.ok(renewed.accessToken !== cold.accessToken);
      const expected = [{ _id: taskId, title: renewedTitle }];
      assert.deepEqual(await update, expected);
      const http = new ConvexHttpClient(origin, { auth: renewed.accessToken, logger: false,
        fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, Origin: packagedOrigin } }) });
      assert.deepEqual(await Promise.all([http.query(api.auth.isAuthenticated), http.query(api.tasks.list)]), [true, expected]);
      assert.equal(await native("auth:signOut", { refreshToken: renewed.refreshToken }), null);
      assert.deepEqual(await refresh(renewed), { kind: "noSession" });
      assert.deepEqual(await revoked, []);
      assert.equal(received.length, 3);
      assert.equal(client.connectionState().connectionCount, connectionCount);
      assert.equal(forcedRefreshes, 1);
      verify();
    } finally { await client.close(); }
  }, { renewal: true }));

test("counts a TCP connection before any provider request is sent", { timeout: 10_000 }, async () => {
  await withScriptedAndroidProvider(async ({ port, providerConnections, providerRequests }) => {
    assert.equal(providerConnections(), 0);
    const socket = createConnection({ host: "127.0.0.1", port });
    const closed = once(socket, "close");
    socket.end();
    await closed;
    assert.equal(providerConnections(), 1);
    assert.equal(providerRequests(), 0);
  }, { routeOutage: true });
});

test("counts rejected HTTP requests and WebSocket upgrades", async () => {
  await withScriptedAndroidProvider(async ({ port, input, verify, providerRequests }) => {
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetch(origin + "/api/query", { method: "OPTIONS", headers: {
      Origin: "http://other.localhost", "Access-Control-Request-Method": "POST",
    } });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal((await mutation(origin, "auth:refreshSession", { refreshToken: "unknown" })).status, 400);
    // A request that otherwise matches still fails when padded past the body limit.
    const padded = JSON.stringify({ path: "auth:signInWithUsernamePassword", format: "convex_encoded_json",
      args: [{ username: input.username, password: input.password }] }).padEnd(5000);
    assert.equal((await fetch(origin + "/api/mutation", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: padded })).status, 400);
    assert.equal(providerRequests(), 3);
    const peer = new PackagedOriginSocket(`ws://127.0.0.1:${port}/unexpected`);
    await once(peer, "error");
    assert.equal(providerRequests(), 4);
    assert.throws(verify, /unexpected/i);
  });
});
