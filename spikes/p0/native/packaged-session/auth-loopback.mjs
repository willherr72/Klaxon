import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";

const predecessor = "KLAXON-P0-INERT/packaged/1";
const successor = "KLAXON-P0-INERT/packaged/3";
const noSession = { kind: "noSession" };
const rotated = { kind: "rotated", tokens: {
  accessToken: "p0-inert-access-a",
  refreshToken: successor,
  refreshTokenExpiresAt: 4102444800000,
  userId: "p0-fixture-owner-a",
} };

// Convex 1.51.0 mutation transport with the pinned Auth 2.1.0 arguments.
async function withMutationLoopback({ label, path, checkFailure }, action) {
  let nextReply;
  let attempts = 0;
  let failure;
  const server = createServer(async (req, res) => {
    function reject(message) {
      failure ??= message;
      if (!res.destroyed) {
        res.writeHead(400, { "Content-Type": "application/json", Connection: "close" });
        res.end("{}");
      }
    }

    // Consume one allowance at arrival, so a concurrent request or automatic
    // HTTP retry cannot receive the response intended for the next host.
    const reply = nextReply;
    nextReply = undefined;
    if (!reply) return reject("Unexpected " + label + " mutation attempt");
    if (req.method !== "POST" || req.url !== "/api/mutation" ||
        req.headers["content-type"] !== "application/json") {
      return reject("Unexpected " + label + " mutation method, target or content type");
    }

    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) return reject("Unexpected " + label + " mutation body size");
        chunks.push(chunk);
      }
      const expected = { path, format: "convex_encoded_json", args: [reply.args ?? { refreshToken: reply.token }] };
      if (!isDeepStrictEqual(JSON.parse(Buffer.concat(chunks)), expected)) {
        return reject("Unexpected " + label + " mutation body");
      }
    } catch {
      return reject("Unreadable " + label + " mutation body");
    }

    try {
      await reply.checkDispatch?.();
    } catch {
      return reject(checkFailure);
    }
    if (req.socket.destroyed) return reject("Client disconnected before the " + label + " dispatch check finished");
    attempts++;
    if (reply.status === undefined) {
      req.socket.destroy();
    } else {
      res.writeHead(reply.status, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ status: "success", value: reply.value, logLines: [] }));
    }
  });

  function assertAttempts(expected) {
    assert.ok(!failure, failure);
    assert.equal(attempts, expected, "Unexpected number of accepted " + label + " mutations");
  }

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    await action({
      port: server.address().port,
      assertAttempts,
      allow(reply) {
        assert.equal(nextReply, undefined, label + " mutation is already enabled");
        nextReply = reply;
      },
    });
  } finally {
    const closed = new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  }
}

export async function withSignOutLoopback(checkDispatch, action) {
  await withMutationLoopback({
    label: "sign-out", path: "auth:signOut", checkFailure: "Pending sign-out check failed at HTTP dispatch",
  }, async ({ port, assertAttempts, allow }) => {
    allow({ token: successor, checkDispatch });
    await action({
      port, assertAttempts,
      allowRetry() {
        assertAttempts(1);
        allow({ token: successor, status: 200, value: null, checkDispatch });
      },
    });
  });
}

export async function withRefreshLoopback(action) {
  const replies = [
    // HTTP failure must preserve the slot even when the body looks definitive.
    { token: predecessor, status: 503, value: noSession },
    { token: predecessor, status: 200, value: rotated },
    { token: successor, status: 200, value: noSession },
  ];
  await withMutationLoopback({
    label: "refresh", path: "auth:refreshSession", checkFailure: "Cold refresh check failed at HTTP dispatch",
  }, async ({ port, assertAttempts, allow }) => {
    let next = 0;
    await action({
      port, assertAttempts,
      allowNext(checkDispatch) {
        assertAttempts(next);
        const reply = replies[next];
        assert.ok(reply, "No further refresh attempt is expected");
        allow({ ...reply, checkDispatch });
        next++;
      },
    });
  });
}

export async function withSignInLoopback(action) {
  const args = { username: "p0-local-user", password: "p0-inert-input" };
  await withMutationLoopback({
    label: "sign-in", path: "auth:signInWithUsernamePassword", checkFailure: "Sign-in dispatch check failed",
  }, async ({ port, assertAttempts, allow }) => {
    allow({ args, status: 200, value: { status: "error", userError: { error: "USER_NOT_FOUND" } } });
    await action({
      port, assertAttempts,
      allowSuccess() {
        assertAttempts(1);
        allow({ args, status: 200, value: {
          status: "complete", tokens: { ...rotated.tokens, refreshToken: predecessor },
        } });
      },
    });
    assertAttempts(2);
  });
}
