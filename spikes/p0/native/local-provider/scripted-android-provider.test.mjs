import assert from "node:assert/strict";
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

test("rotates the native grant and clears the real SDK's existing subscription on sign-out", { timeout: 10_000 }, async () => {
  const port = await withScriptedAndroidProvider(async ({ port, input: { username, password, owner }, taskId, title, verify }) => {
    const origin = `http://127.0.0.1:${port}`;
    const post = async (path, args) => {
      const response = await mutation(origin, path, args);
      assert.equal(response.status, 200);
      const envelope = await response.json();
      assert.equal(envelope.status, "success");
      return envelope.value;
    };
    const signIn = await post("auth:signInWithUsernamePassword", { username, password });
    assert.equal(signIn.status, "complete");
    const initialRefresh = { refreshToken: signIn.tokens.refreshToken };
    const nonauthoritative = await mutation(origin, "auth:refreshSession", initialRefresh);
    assert.equal(nonauthoritative.status, 202);
    assert.deepEqual(await nonauthoritative.json(), { status: "success", value: { kind: "noSession" }, logLines: [] });
    const rotated = await post("auth:refreshSession", initialRefresh);
    assert.equal(rotated.kind, "rotated");
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
      const before = client.connectionState().connectionCount;
      const args = { refreshToken: rotated.tokens.refreshToken };
      assert.equal(await post("auth:signOut", args), null);
      assert.deepEqual(await post("auth:refreshSession", args), { kind: "noSession" });
      assert.deepEqual(await cleared, []);
      assert.deepEqual(await read(), [false, []]);
      assert.ok(client.connectionState().isWebSocketConnected);
      assert.equal(client.connectionState().connectionCount, before);
      assert.equal(forcedRefreshes, 0);
      verify();
    } finally {
      await client.close();
    }
    return port;
  });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/query`));
});

test("rejects out-of-order native requests, oversized bodies, and other browser origins", async () => {
  await withScriptedAndroidProvider(async ({ port, input, verify }) => {
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
    assert.throws(verify, /unexpected/i);
  });
});
