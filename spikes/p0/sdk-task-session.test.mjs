import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

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
  await page.evaluate(() => {
    const { createSdkTaskSession, createSdkTransport, sdkFixtureUrl, fixtureAccess } = sdkFixture;
    const transport = createSdkTransport();
    const run = window.run = {
      transport, owner: null, rows: [], renders: 0, holding: false, held: {}, applied: [],
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
          const token = run.owner ? fixtureAccess(run.owner) : null;
          if (run.accessGate) await run.accessGate(options);
          return token;
        },
        signOut: () => { run.owner = null; },
      },
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
  });
  return page;
}

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
