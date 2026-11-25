import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";

const expectedMutation = {
  path: "auth:signOut",
  format: "convex_encoded_json",
  args: [{ refreshToken: "KLAXON-P0-INERT/packaged/3" }],
};

export async function withSignOutLoopback(checkPending, action) {
  let nextReply = "drop";
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
    // HTTP retry cannot receive the acknowledgment intended for the next host.
    const reply = nextReply;
    nextReply = undefined;
    if (!reply) return reject("Unexpected sign-out mutation attempt");
    if (req.method !== "POST" || req.url !== "/api/mutation" ||
        req.headers["content-type"] !== "application/json") {
      return reject("Unexpected sign-out mutation method, target or content type");
    }

    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024) return reject("Unexpected sign-out mutation body size");
        chunks.push(chunk);
      }
      if (!isDeepStrictEqual(JSON.parse(Buffer.concat(chunks)), expectedMutation)) {
        return reject("Unexpected sign-out mutation body");
      }
    } catch {
      return reject("Unreadable sign-out mutation body");
    }

    try {
      await checkPending();
    } catch {
      return reject("Sign-out intent was missing at HTTP dispatch");
    }
    attempts++;
    if (reply === "drop") {
      req.socket.destroy();
    } else {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end('{"status":"success","value":null,"logLines":[]}');
    }
  });

  function assertAttempts(expected) {
    assert.ok(!failure, failure);
    assert.equal(attempts, expected, "Unexpected number of accepted sign-out mutations");
  }

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    await action({
      port: server.address().port,
      assertAttempts,
      allowRetry() {
        assertAttempts(1);
        assert.equal(nextReply, undefined, "Sign-out retry is already enabled");
        nextReply = "acknowledge";
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
