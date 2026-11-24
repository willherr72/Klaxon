import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { version } from "convex";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Stand-ins for native grants. The packaged browser verifier contains only digests.
const fixtureAccess = {
  a1: "p0-inert-access-a",
  // The fresh-token path needs parseable iat and exp. These fixed claims have a fake signature.
  a2: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.cDAtbm90LWEtc2lnbmF0dXJl",
  b1: "p0-inert-access-b",
};

let browser, script;
before(async () => {
  const bundle = await build({
    stdin: {
      contents: 'export * from "./sdk-task-session.mjs"; export * from "./sdk-test-transport.mjs";',
      resolveDir: fileURLToPath(new URL("./native/packaged-session/", import.meta.url)),
    },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "sdkFixture",
  });
  script = bundle.outputFiles[0].text;
  const executablePath = process.env.P0_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } :
    process.platform === "win32" ? { channel: "msedge" } : {});
});
after(async () => { await browser?.close(); });

async function openFixture(t) {
  const context = await browser.newContext({ offline: true, serviceWorkers: "block" });
  const unexpected = [];
  const documentUrl = "https://offline-page.invalid/";
  await context.route(/^https?:/i, route => {
    if (route.request().isNavigationRequest() && route.request().url() === documentUrl) {
      return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>P0 SDK test</title>" });
    }
    unexpected.push("HTTP");
    return route.abort();
  });
  await context.routeWebSocket(/.*/, socket => { unexpected.push("WebSocket"); socket.close(); });
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, [], "the fixture tried to use a browser network transport");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", () => unexpected.push("page error"));
  await page.goto(documentUrl);
  await page.addScriptTag({ content: script });
  await page.evaluate(grants => {
    const { createSdkTaskSession, createSdkTransport, sdkFixtureUrl } = sdkFixture;
    const transport = createSdkTransport();
    const run = window.run = {
      transport, owner: null, rotated: false, rows: [], renders: 0, holding: false, held: {}, applied: [], accessRequests: [],
    };
    run.tasks = createSdkTaskSession({
      origin: sdkFixtureUrl, webSocketConstructor: transport.webSocketConstructor,
      async fetch(url, init) {
        const response = await transport.fetch(url, init);
        if (run.responseGate) await run.responseGate();
        return response;
      },
      native: {
        async access(options) {
          run.accessRequests.push(options.forceRefreshToken);
          const ownerAGrant = grants[run.rotated ? "a2" : "a1"];
          const token = { A: ownerAGrant, B: grants.b1 }[run.owner] ?? null;
          if (run.accessGate) await run.accessGate(options);
          return token;
        },
        signOut: () => { run.owner = null; },
      },
      accessDenied: denial => { run.denial = denial; },
      render: rows => { run.rows = rows; run.renders++; },
      deliver(kind, callback) {
        // Capture only after the real SDK has decoded the result or invoked onUpdate.
        const deliver = () => { run.applied.push(kind); callback(); };
        if (run.holding) {
          if (run.held[kind]) throw Error("unexpected duplicate queued delivery");
          run.held[kind] = deliver;
        } else deliver();
      },
    });
  }, fixtureAccess);
  return page;
}

test("the SDK reauthenticates after A rotates and the verifier rejects A's revoked grant", { timeout: 20_000 }, async t => {
  const page = await openFixture(t);
  await resume(page, "A");
  await page.evaluate(() => run.tasks.read());
  assert.deepEqual(await page.evaluate(() => run.transport.evidence.httpReadGenerations), ["a1"]);
  assert.deepEqual(await page.evaluate(() => run.transport.evidence.socketAuthGenerations), ["a1"]);

  const cutover = await page.evaluate(() => {
    run.rotated = true;
    return { start: run.accessRequests.length, expired: run.transport.rotate() };
  });
  assert.equal(cutover.expired, 1);
  await page.waitForFunction(() => run.transport.evidence.queryAddGenerations.at(-1) === "a2");
  assert.deepEqual(await page.evaluate(start => run.accessRequests.slice(start), cutover.start), [true]);
  assert.deepEqual(await page.evaluate(() => {
    const e = run.transport.evidence;
    return { opened: e.socketsOpened, closed: e.socketsClosed, auth: e.socketAuthGenerations, queries: e.queryAddGenerations };
  }), { opened: 2, closed: 1, auth: ["a1", "a2"], queries: ["a1", "a2"] });

  await page.evaluate(() => run.tasks.read());
  assert.deepEqual(await page.evaluate(() => run.transport.evidence.httpReadGenerations), ["a1", "a2"]);
  assert.equal(await page.evaluate(() => run.transport.update("A")), 1);
  await page.waitForFunction(() => run.rows[0]?.title === "Owner A updated");

  // Probe the same rotated verifier directly with the old grant. This does not reuse
  // the SDK session's updated HTTP client or its restarted WebSocket.
  const rejected = await page.evaluate(async ({ access, socketUrl }) => {
    const { sdkFixtureUrl } = sdkFixture;
    const { fetch, webSocketConstructor } = run.transport;
    const query = { path: "tasks:list", args: [{}], format: "convex_encoded_json" };
    const http = await fetch(sdkFixtureUrl + "/api/query", {
      method: "POST", headers: { Authorization: "Bearer " + access }, body: JSON.stringify(query),
    });
    const socket = new webSocketConstructor(socketUrl);
    const send = message => socket.send(JSON.stringify(message));
    try {
      const messages = await new Promise(resolve => {
        socket.onopen = () => {
          send({ type: "Connect", sessionId: "stale-grant-probe", connectionCount: 0, maxObservedTimestamp: null });
          send({ type: "Authenticate", tokenType: "User", value: access, baseVersion: 0 });
          send({ type: "ModifyQuerySet", baseVersion: 0, newVersion: 1, modifications: [
            { type: "Add", queryId: 0, udfPath: query.path, args: query.args },
          ] });
        };
        const received = [];
        socket.onmessage = ({ data }) => {
          received.push(JSON.parse(data));
          if (received.length === 2) resolve(received);
        };
      });
      return {
        http: http.status, httpMessage: await http.text(),
        socket: messages[0].type, socketError: messages[0].error,
        query: messages[1].modifications?.[0]?.type,
      };
    } finally {
      socket.close();
    }
  }, { access: fixtureAccess.a1, socketUrl: `wss://sdk-fixture.invalid/api/${version}/sync` });
  assert.deepEqual(rejected, {
    http: 401, httpMessage: "signed-out", socket: "AuthError", socketError: "signed-out", query: "QueryFailed",
  });
  await page.evaluate(() => run.tasks.signOut());
  await resume(page, "B");
  await page.evaluate(() => run.tasks.read());
  assert.deepEqual(await page.evaluate(() => {
    const e = run.transport.evidence;
    return { http: e.httpReadGenerations, auth: e.socketAuthGenerations, rows: run.rows };
  }), {
    http: ["a1", "a2", "b1"], auth: ["a1", "a2", "b1"], rows: [{ id: "task-b", title: "Owner B task" }],
  });
  assert.equal(await page.evaluate(() => run.transport.update("A")), 0);
  assert.equal(await page.evaluate(() => run.transport.update("B")), 1);
  await page.waitForFunction(() => run.rows[0]?.title === "Owner B updated");
  await page.evaluate(() => run.tasks.signOut());
});

test("a provider outage after a confirmed rotation clears the SDK session", async t => {
  const page = await openFixture(t);
  await resume(page, "A");
  assert.equal(await page.evaluate(() => {
    run.rotated = true;
    return run.transport.rotate();
  }), 1);
  await page.waitForFunction(() => run.transport.evidence.queryAddGenerations.at(-1) === "a2");
  assert.equal(await page.evaluate(() => run.transport.update("A")), 1);
  await page.waitForFunction(() => run.rows[0]?.title === "Owner A updated");

  const outage = await page.evaluate(() => {
    run.accessGate = () => { throw "retry-required"; };
    return { start: run.accessRequests.length, expired: run.transport.expire() };
  });
  assert.equal(outage.expired, 1);
  await page.waitForFunction(() => run.denial === "retry-required");
  assert.deepEqual(await page.evaluate(start => {
    const { socketsClosed, socketsOpened } = run.transport.evidence;
    return { access: run.accessRequests.slice(start), socketsClosed, socketsOpened, rows: run.rows };
  }, outage.start), { access: [true], socketsClosed: 2, socketsOpened: 2, rows: [] });
  await assert.rejects(page.evaluate(() => run.tasks.read()), /signed out/i);
});

async function resume(page, owner) {
  assert.equal(await page.evaluate(async owner => {
    run.owner = owner;
    return run.tasks.resume();
  }, owner), true);
  await page.waitForFunction(owner => run.rows[0]?.id === "task-" + owner.toLowerCase(), owner);
  assert.deepEqual(await page.evaluate(() => run.rows), [{ id: "task-" + owner.toLowerCase(), title: "Owner " + owner + " task" }]);
}

for (const destination of ["signed out", "owner B active"]) {
  test("SDK read and subscription deliveries from A are discarded with " + destination, async t => {
    const page = await openFixture(t);
    assert.equal(await page.evaluate(() => run.tasks.resume()), false);
    await resume(page, "A");
    await page.evaluate(() => run.tasks.read());
    assert.deepEqual(await page.evaluate(() => run.applied), ["update", "read"]);
    assert.equal(await page.evaluate(() => run.transport.update("A")), 1);
    await page.waitForFunction(() => run.rows[0]?.title === "Owner A updated");
    assert.deepEqual(await page.evaluate(() => run.transport.evidence.httpReads), ["A"]);

    await page.evaluate(async () => {
      run.holding = true;
      await run.tasks.read();
      run.transport.update("A");
    });
    await page.waitForFunction(() => run.held.read && run.held.update);
    await page.evaluate(async () => {
      run.holding = false;
      const signingOut = run.tasks.signOut();
      if (run.rows.length) throw Error("sign-out must immediately clear the view");
      await signingOut;
    });
    // A queued callback and an active server subscription are independent.
    assert.equal(await page.evaluate(() => run.transport.update("A")), 0);
    assert.deepEqual(await page.evaluate(() => {
      const e = run.transport.evidence;
      return { closed: e.socketsClosed, opened: e.socketsOpened, reads: e.httpReads, adds: e.queryAdds, auth: e.socketAuth };
    }), { closed: 1, opened: 1, reads: ["A", "A"], adds: ["A"], auth: ["A"] });
    await assert.rejects(page.evaluate(() => run.tasks.read()), /signed out/i);
    assert.equal(await page.evaluate(() => run.transport.evidence.httpRequests), 2);

    if (destination === "owner B active") {
      await resume(page, "B");
      await page.evaluate(() => run.tasks.read());
      assert.deepEqual(await page.evaluate(() => run.transport.evidence.httpReads), ["A", "A", "B"]);
    }
    const expected = destination === "signed out" ? [] : [{ id: "task-b", title: "Owner B task" }];
    for (const kind of ["read", "update"]) {
      const delivered = await page.evaluate(kind => {
        const beforeRenders = run.renders;
        const beforeApplied = run.applied.length;
        run.held[kind]();
        return { calls: run.applied.slice(beforeApplied), renders: run.renders - beforeRenders, rows: run.rows };
      }, kind);
      assert.deepEqual(delivered, { calls: [kind], renders: 0, rows: expected });
    }
    if (destination === "owner B active") {
      assert.equal(await page.evaluate(() => run.transport.update("B")), 1);
      await page.waitForFunction(() => run.rows[0]?.title === "Owner B updated");
      assert.deepEqual(await page.evaluate(() => run.transport.evidence.socketAuth), ["A", "B"]);
      await page.evaluate(() => run.tasks.signOut());
      assert.equal(await page.evaluate(() => run.transport.update("B")), 0);
    }
    assert.deepEqual(await page.evaluate(async () => ({
      local: localStorage.length, session: sessionStorage.length,
      databases: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
    })), { local: 0, session: 0, databases: 0, caches: 0 });
    assert.deepEqual(await page.context().cookies(), []);
  });
}

test("a late native access result cannot open an SDK client for the signed-out owner", async t => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    run.owner = "A";
    run.accessGate = () => new Promise(resolve => { run.releaseAccess = resolve; });
    run.oldResume = run.tasks.resume();
  });
  await page.waitForFunction(() => typeof run.releaseAccess === "function");
  await page.evaluate(async () => { await run.tasks.signOut(); run.accessGate = null; });
  await resume(page, "B");
  assert.equal(await page.evaluate(() => { run.releaseAccess(); return run.oldResume; }), false);
  await page.evaluate(() => run.tasks.read());
  assert.deepEqual(await page.evaluate(() => run.rows), [{ id: "task-b", title: "Owner B task" }]);
  assert.deepEqual(await page.evaluate(() => {
    const { httpReads, socketAuth, socketsOpened } = run.transport.evidence;
    return { httpReads, socketAuth, socketsOpened };
  }), { httpReads: ["B"], socketAuth: ["B"], socketsOpened: 1 });
  await page.evaluate(() => run.tasks.signOut());
});

test("a delayed HTTP snapshot cannot replace a newer subscription update for the same owner", async t => {
  const page = await openFixture(t);
  await resume(page, "A");
  await page.evaluate(() => {
    run.responseGate = () => new Promise(resolve => { run.releaseHttp = resolve; });
    run.pendingRead = run.tasks.read();
  });
  await page.waitForFunction(() => typeof run.releaseHttp === "function");
  await page.evaluate(() => run.transport.update("A"));
  await page.waitForFunction(() => run.rows[0]?.title === "Owner A updated");
  await page.evaluate(async () => { run.releaseHttp(); await run.pendingRead; });
  assert.deepEqual(await page.evaluate(() => run.rows), [{ id: "task-a", title: "Owner A updated" }]);
  await page.evaluate(() => run.tasks.signOut());
});

test("a delayed HTTP response is decoded by the SDK after B resumes and cannot replace B's tasks", async t => {
  const page = await openFixture(t);
  await resume(page, "A");
  await page.evaluate(() => {
    run.responseGate = () => new Promise(resolve => { run.releaseHttp = resolve; });
    run.pendingRead = run.tasks.read();
  });
  await page.waitForFunction(() => typeof run.releaseHttp === "function");
  await page.evaluate(async () => { run.responseGate = null; await run.tasks.signOut(); });
  await resume(page, "B");
  const result = await page.evaluate(async () => {
    const before = run.renders;
    const applied = run.applied.length;
    run.releaseHttp();
    await run.pendingRead;
    return { rows: run.rows, renders: run.renders - before, callbacks: run.applied.slice(applied) };
  });
  assert.deepEqual(result, { rows: [{ id: "task-b", title: "Owner B task" }], renders: 0, callbacks: ["read"] });
  await page.evaluate(() => run.tasks.signOut());
});
