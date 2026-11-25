import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { version } from "convex";
import { WebSocket, WebSocketServer } from "ws";

const loopback = "127.0.0.1";
const packagedOrigin = "http://tauri.localhost";
const syncPath = `/api/${version}/sync`;
const input = Object.freeze({
  username: "p0-inert-android-user",
  password: "p0-inert-android-password",
  owner: "p0-inert-android-owner",
});
const taskId = "p0-inert-android-task";
const title = "Scripted Android fixture task";
const taskPath = "tasks:list";
const authPath = "auth:isAuthenticated";
const format = "convex_encoded_json";
const maxPayload = 4096;
const refreshA1 = "p0-inert-android-refresh-a1";
const refreshA2 = "p0-inert-android-refresh-a2";
const noSession = { kind: "noSession" };
const queryHeaders = ["authorization", "content-type", "convex-client"];
const cors = { "Access-Control-Allow-Origin": packagedOrigin, Vary: "Origin" };

function grant(refreshToken, generation) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({ sub: "p0-inert-android-session", iss: "http://127.0.0.1:3210/components/auth", aud: "convex-auth",
    iat: now, exp: now + 900, jti: generation });
  // JWT shape for the SDK's auth state machine. There is no signing key.
  const signature = Buffer.from("p0-inert-android-signature").toString("base64url");
  return { accessToken: `${header}.${claims}.${signature}`, refreshToken,
    refreshTokenExpiresAt: (now + 3600) * 1000, userId: input.owner };
}

async function readCall(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxPayload) return;
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks));
}

function matchesCall(body, path, args) {
  return isDeepStrictEqual(body, { path, format, args: [args] });
}

// StateVersion.ts encodes a little-endian uint64 in the pinned SDK protocol.
function timestamp(tick) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(tick));
  return bytes.toString("base64");
}

export async function withScriptedAndroidProvider(action) {
  const rows = [{ _id: taskId, title }];
  const sockets = new Set();
  const peers = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  const initialReads = new Set();
  const revokedReads = new Set();
  let phase = "sign-in";
  let accessA2;
  let subscription;
  let unexpected = false;

  function rejectRequest(res) {
    unexpected = true;
    if (res.destroyed) return;
    res.writeHead(400, { Connection: "close", "Cache-Control": "no-store" });
    res.end();
  }

  function reply(res, status, value, headers) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify({ status: "success", value, logLines: [] }));
  }

  function mutate(res, body) {
    if (phase === "sign-in" && matchesCall(body, "auth:signInWithUsernamePassword",
      { username: input.username, password: input.password })) {
      phase = "first-refresh";
      return reply(res, 200, { status: "complete", tokens: grant(refreshA1, "a1") });
    }
    if (matchesCall(body, "auth:refreshSession", { refreshToken: refreshA1 })) {
      // A non-200 response cannot authoritatively clear the protected record.
      if (phase === "first-refresh") {
        phase = "retry-refresh";
        return reply(res, 202, noSession);
      }
      if (phase === "retry-refresh") {
        const tokens = grant(refreshA2, "a2");
        accessA2 = tokens.accessToken;
        phase = "rotated";
        return reply(res, 200, { kind: "rotated", tokens });
      }
    }
    if (phase === "rotated" && subscription?.peer.readyState === WebSocket.OPEN &&
        subscription.authenticated && subscription.queryId !== undefined &&
        matchesCall(body, "auth:signOut", { refreshToken: refreshA2 })) {
      phase = "revoked";
      // Publish on the existing query without advancing the socket's identity version.
      subscription.transition([subscription.result([])]);
      return reply(res, 200, null);
    }
    if (phase === "revoked" && matchesCall(body, "auth:refreshSession", { refreshToken: refreshA2 })) {
      phase = "confirmed-revoked";
      return reply(res, 200, noSession);
    }
    return rejectRequest(res);
  }

  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000 }, async (req, res) => {
    const { origin, authorization, cookie, "content-length": contentLength } = req.headers;
    if (!cookie && origin === packagedOrigin && req.url === "/api/query" && req.method === "OPTIONS" &&
        !authorization && req.headers["access-control-request-method"] === "POST") {
      if (req.headers["transfer-encoding"] || Number(contentLength ?? 0) !== 0) return rejectRequest(res);
      const requestedHeaders = req.headers["access-control-request-headers"]?.split(",").map(header => header.trim());
      if (!requestedHeaders?.every(header => queryHeaders.includes(header.toLowerCase()))) return rejectRequest(res);
      res.writeHead(204, { ...cors, "Cache-Control": "no-store", "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": queryHeaders.join(", "),
        ...(req.headers["access-control-request-private-network"] === "true" &&
          { "Access-Control-Allow-Private-Network": "true" }) });
      return res.end();
    }

    const native = req.url === "/api/mutation" && origin === undefined && authorization === undefined;
    const query = req.url === "/api/query" && origin === packagedOrigin && accessA2 &&
      authorization === `Bearer ${accessA2}`;
    if (cookie || req.method !== "POST" || req.headers["content-type"] !== "application/json" ||
        Number(contentLength) > maxPayload || (!native && !query)) {
      return rejectRequest(res);
    }
    try {
      const body = await readCall(req);
      if (native) return mutate(res, body);
      const path = body?.path;
      const authenticated = phase === "rotated";
      const reads = authenticated ? initialReads : revokedReads;
      if ((!authenticated && phase !== "confirmed-revoked") || (path !== authPath && path !== taskPath) ||
          !matchesCall(body, path, {}) || reads.has(path)) return rejectRequest(res);
      reads.add(path);
      const queryRows = authenticated ? rows : [];
      return reply(res, 200, path === authPath ? authenticated : queryRows, cors);
    } catch {
      return rejectRequest(res);
    }
  });

  function rejectSocket(socket) {
    unexpected = true;
    socket.destroy();
  }

  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("error", () => { unexpected = true; });
  server.on("clientError", (_error, socket) => rejectSocket(socket));
  server.on("connect", (_req, socket) => rejectSocket(socket));
  peers.on("wsClientError", (_error, socket) => rejectSocket(socket));
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== syncPath || req.headers.origin !== packagedOrigin || req.headers.authorization || req.headers.cookie ||
        subscription || phase !== "rotated" || initialReads.size !== 2) return rejectSocket(socket);
    peers.handleUpgrade(req, socket, head, peer => {
      let connected = false;
      let tick = 0;
      let state = { querySet: 0, identity: 0, ts: timestamp(0) };
      let added = false;
      subscription = {
        peer, authenticated: false, queryId: undefined,
        initialRowsSent: false, emptyRowsSent: false,
        result(value) {
          if (value.length) this.initialRowsSent = true;
          else this.emptyRowsSent = true;
          return { type: "QueryUpdated", queryId: this.queryId, value, logLines: [], journal: null };
        },
        transition(modifications, changes) {
          const startVersion = state;
          state = { ...state, ...changes, ts: timestamp(++tick) };
          peer.send(JSON.stringify({ type: "Transition", startVersion, endVersion: state, modifications }));
        },
      };
      peer.on("error", () => { unexpected = true; });
      peer.on("message", (data, binary) => {
        const reject = () => { unexpected = true; peer.terminate(); };
        let message;
        try {
          if (binary) return reject();
          message = JSON.parse(data.toString());
        } catch {
          return reject();
        }
        if (message?.type === "Connect" && !connected) {
          connected = true;
          return;
        }
        if (!connected) return reject();
        if (message?.type === "Event" && message.eventType === "ClientConnect") return;
        if (message?.type === "Authenticate" && !subscription.authenticated && phase === "rotated" &&
            message.baseVersion === state.identity && message.tokenType === "User" && message.value === accessA2) {
          subscription.authenticated = true;
          const modifications = added ? [subscription.result(rows)] : [];
          subscription.transition(modifications, { identity: state.identity + 1 });
          return;
        }
        if (message?.type !== "ModifyQuerySet" || message.baseVersion !== state.querySet ||
            message.newVersion !== state.querySet + 1 || !Array.isArray(message.modifications) ||
            message.modifications.length > 1) return reject();
        const [mod] = message.modifications;
        const modifications = [];
        if (message.modifications.length) {
          if (!added && mod?.type === "Add" && phase === "rotated" && Number.isSafeInteger(mod.queryId) &&
              mod.queryId >= 0 && !mod.componentPath && mod.udfPath === taskPath && isDeepStrictEqual(mod.args, [{}])) {
            added = true;
            subscription.queryId = mod.queryId;
            if (subscription.authenticated) modifications.push(subscription.result(rows));
          } else if (phase === "confirmed-revoked" && mod?.type === "Remove" &&
              subscription.queryId !== undefined && mod.queryId === subscription.queryId) {
            modifications.push({ type: "QueryRemoved", queryId: mod.queryId });
            subscription.queryId = undefined;
          } else return reject();
        }
        subscription.transition(modifications, { querySet: message.newVersion });
      });
    });
  });

  function verify() {
    assert.ok(!unexpected, "Unexpected scripted Android provider request or transport failure");
    assert.equal(phase, "confirmed-revoked", "Expected sign-in, nonauthoritative refresh, rotation, sign-out and refresh denial");
    assert.equal(initialReads.size, 2, "Expected authenticated HTTP reads");
    assert.equal(revokedReads.size, 2, "Expected HTTP reads with the revoked bearer");
    assert.ok(subscription?.authenticated && subscription.initialRowsSent && subscription.emptyRowsSent,
      "Expected initial rows and an empty update on the same authenticated socket");
  }

  try {
    const listening = once(server, "listening");
    server.listen({ host: loopback, port: 0, exclusive: true });
    await listening;
    return await action({ port: server.address().port, input, taskId, title, verify, phase: () => phase });
  } finally {
    for (const peer of peers.clients) peer.terminate();
    for (const socket of sockets) socket.destroy();
    const peersClosed = new Promise(resolve => peers.close(resolve));
    const listenerClosed = server.listening ? new Promise(resolve => server.close(resolve)) : undefined;
    await Promise.all([peersClosed, listenerClosed]);
  }
}
