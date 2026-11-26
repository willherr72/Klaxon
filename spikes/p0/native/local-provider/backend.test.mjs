import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { withLocalBackend } from "./backend.mjs";

async function listen(port, host = "127.0.0.1") {
  const server = createServer();
  server.listen({ host, port, exclusive: true });
  await once(server, "listening");
  return server;
}

test("uses an anonymous local backend and releases both ports", async () => {
  const inheritedDeployment = process.env.CONVEX_DEPLOYMENT;
  process.env.CONVEX_DEPLOYMENT = "invalid-local-fixture-deployment";
  try {
    const result = await withLocalBackend(async urls => {
      assert.deepEqual(urls, {
        url: "http://127.0.0.1:3210",
        siteUrl: "http://127.0.0.1:3211",
      });
      const response = await fetch(`${urls.url}/api/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "tasks:list", args: {}, format: "json" }),
      });
      const { status, value } = await response.json();
      assert.equal(status, "success");
      assert.deepEqual(value, []);
      return "callback result";
    });
    assert.equal(result, "callback result");
    assert.equal(process.env.CONVEX_DEPLOYMENT, "invalid-local-fixture-deployment");
  } finally {
    if (inheritedDeployment === undefined) delete process.env.CONVEX_DEPLOYMENT;
    else process.env.CONVEX_DEPLOYMENT = inheritedDeployment;
  }

  const api = await listen(3210);
  try {
    const site = await listen(3211);
    try {
      await assert.rejects(withLocalBackend(() => assert.fail("callback ran")), /already in use/);
      assert.ok(api.listening);
      assert.ok(site.listening);
    } finally {
      await new Promise(resolve => site.close(resolve));
    }
  } finally {
    await new Promise(resolve => api.close(resolve));
  }
});

test("preserves a callback failure and still releases both ports", async () => {
  const failure = new Error("fixture callback failed");
  await assert.rejects(withLocalBackend(() => { throw failure; }), error => error === failure);

  for (const port of [3210, 3211]) {
    const server = await listen(port);
    await new Promise(resolve => server.close(resolve));
  }
});

test("rejects a fixture port already listening on IPv6", async () => {
  const server = await listen(3211, "::1");
  try {
    await assert.rejects(withLocalBackend(() => assert.fail("callback ran")), /already in use/);
    assert.ok(server.listening);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
