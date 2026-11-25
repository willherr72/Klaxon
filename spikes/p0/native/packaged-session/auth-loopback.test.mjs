import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { withRefreshLoopback, withSignOutLoopback } from "./auth-loopback.mjs";

const mutation = {
  path: "auth:signOut",
  format: "convex_encoded_json",
  args: [{ refreshToken: "KLAXON-P0-INERT/packaged/3" }],
};
const refresh = generation => ({
  ...mutation,
  path: "auth:refreshSession",
  args: [{ refreshToken: "KLAXON-P0-INERT/packaged/" + generation }],
});

function post(port, body = mutation) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, method: "POST", path: "/api/mutation",
      headers: { "Content-Type": "application/json" }, agent: false, timeout: 2_000,
    }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) });
      } catch (error) {
        reject(error);
      }
    });
    req.on("timeout", () => req.destroy(new Error("loopback test timed out")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("drops the first complete mutation and returns explicit null on the enabled retry", async () => {
  let pendingChecks = 0;
  await withSignOutLoopback(() => { pendingChecks++; }, async fixture => {
    await assert.rejects(post(fixture.port), { code: "ECONNRESET" });
    fixture.assertAttempts(1);
    assert.equal(pendingChecks, 1);

    fixture.allowRetry();
    assert.deepEqual(await post(fixture.port), {
      status: 200, body: { status: "success", value: null, logLines: [] },
    });
    fixture.assertAttempts(2);
    assert.equal(pendingChecks, 2);
  });
});

test("rejects extra JSON fields without exposing request data", async () => {
  await withSignOutLoopback(() => assert.fail("unexpected pending check"), async fixture => {
    const body = { ...mutation, unexpected: "request-canary" };
    assert.equal((await post(fixture.port, body)).status, 400);
    assert.throws(() => fixture.assertAttempts(0), {
      message: "Unexpected sign-out mutation body",
    });
  });
});

test("an immediate second mutation cannot consume the cold retry acknowledgment", async () => {
  await withSignOutLoopback(() => {}, async fixture => {
    await assert.rejects(post(fixture.port), { code: "ECONNRESET" });
    assert.equal((await post(fixture.port)).status, 400);
    assert.throws(() => fixture.allowRetry(), { message: "Unexpected sign-out mutation attempt" });
  });
});

test("requires the pending journal at receipt before counting a mutation", async () => {
  await withSignOutLoopback(() => { throw new Error("journal unavailable"); }, async fixture => {
    assert.equal((await post(fixture.port)).status, 400);
    assert.throws(() => fixture.assertAttempts(0), { message: "Pending sign-out check failed at HTTP dispatch" });
  });
});

test("closes the listener and an incomplete connection if the smoke fails", async () => {
  const failure = new Error("synthetic smoke failure");
  let port;
  let closed;
  let socketError;
  await assert.rejects(withSignOutLoopback(() => {}, async fixture => {
    port = fixture.port;
    const socket = connect(port, "127.0.0.1");
    socket.on("error", error => { socketError = error; });
    closed = new Promise(resolve => socket.once("close", resolve));
    await once(socket, "connect");
    socket.write("POST /api/mutation HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 20\r\n\r\n{");
    throw failure;
  }), error => error === failure);
  await closed;
  assert.ok(!socketError || socketError.code === "ECONNRESET");
  await assert.rejects(post(port), { code: "ECONNREFUSED" });
});

test("models HTTP 503, rotation and definitive expiry in separate refresh attempts", async () => {
  const missing = { status: "success", value: { kind: "noSession" }, logLines: [] };
  let dispatches = 0;
  const checkDispatch = () => { dispatches++; };
  await withRefreshLoopback(async fixture => {
    fixture.allowNext(checkDispatch);
    assert.deepEqual(await post(fixture.port, refresh(1)), { status: 503, body: missing });
    fixture.assertAttempts(1);

    fixture.allowNext(checkDispatch);
    assert.deepEqual(await post(fixture.port, refresh(1)), {
      status: 200,
      body: {
        status: "success",
        value: { kind: "rotated", tokens: {
          accessToken: "p0-inert-access-a",
          refreshToken: "KLAXON-P0-INERT/packaged/3",
          refreshTokenExpiresAt: 4102444800000,
          userId: "p0-fixture-owner-a",
        } },
        logLines: [],
      },
    });
    fixture.assertAttempts(2);

    fixture.allowNext(checkDispatch);
    assert.deepEqual(await post(fixture.port, refresh(3)), { status: 200, body: missing });
    fixture.assertAttempts(3);
    assert.equal(dispatches, 3);
  });
});

test("rejects automatic refresh retries before the following cold launch", async () => {
  await withRefreshLoopback(async fixture => {
    fixture.allowNext();
    assert.equal((await post(fixture.port, refresh(1))).status, 503);
    assert.equal((await post(fixture.port, refresh(1))).status, 400);
    assert.throws(() => fixture.assertAttempts(1), { message: "Unexpected refresh mutation attempt" });
  });
});

test("rejects a retired predecessor at the successor-only refresh step", async () => {
  await withRefreshLoopback(async fixture => {
    fixture.allowNext();
    assert.equal((await post(fixture.port, refresh(1))).status, 503);
    fixture.allowNext();
    assert.equal((await post(fixture.port, refresh(1))).status, 200);
    fixture.allowNext(() => assert.fail("unexpected dispatch"));
    assert.equal((await post(fixture.port, refresh(1))).status, 400);
    assert.throws(() => fixture.assertAttempts(2), { message: "Unexpected refresh mutation body" });
  });
});
