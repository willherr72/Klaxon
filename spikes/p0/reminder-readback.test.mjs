import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright-core";
import { receiptCache } from "./reminder-push/receiver/fixture.mjs";

async function receiverAssets() {
  const assets = new Map();
  for (const name of ["index.html", "page.mjs", "fixture.mjs", "public-key.mjs"]) {
    const source = await readFile(new URL(`./reminder-push/receiver/${name}`, import.meta.url));
    assets.set(`/receiver/${name}`, [name.endsWith(".html") ? "text/html" : "text/javascript", source]);
  }
  return assets;
}

async function launchBrowser(t) {
  const executablePath = process.env.P0_CHROMIUM_EXECUTABLE;
  const browser = await chromium.launch(executablePath ? { executablePath } :
    process.platform === "win32" ? { channel: "msedge" } : {});
  t.after(() => browser.close());
  return browser;
}

test("the reopened receiver reads pre-staged duplicate receipts and clears only its own cache", async t => {
  const assets = await receiverAssets();
  assets.set("/seed.html", ["text/html", "<!doctype html><title>Receipt seed</title>"]);
  const server = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    const [type, body] = asset;
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  const scope = new URL(`http://127.0.0.1:${server.address().port}/receiver/`);
  const entry = new URL("index.html", scope).href;
  const ownCache = receiptCache(scope.href);
  const siblingScope = new URL("../sibling/", scope);
  const otherCache = receiptCache(siblingScope.href);
  const sentinelURL = new URL("sentinel", siblingScope).href;

  const browser = await launchBrowser(t);
  const context = await browser.newContext({ serviceWorkers: "block" });
  context.setDefaultTimeout(10_000);

  const emptyText = "No worker receipts recorded.";
  const firstPage = await context.newPage();
  await firstPage.goto(entry);
  await firstPage.getByText(emptyText, { exact: true }).waitFor();
  await firstPage.close();

  const receipt = {
    target: "windows-edge",
    occurrenceId: "6f80fd1b-6542-42fe-81ba-f5bffdb56a3c",
    receivedAt: "2026-11-25T16:32:00.000Z",
    displayRequest: "resolved",
  };
  const seed = await context.newPage();
  await seed.goto(new URL("/seed.html", scope).href);
  assert.equal(context.pages().length, 1);
  // Pre-stage identical rows under distinct keys while the receiver page is closed.
  await seed.evaluate(async ({ scope, ownCache, otherCache, sentinelURL, receipt }) => {
    const cache = await caches.open(ownCache);
    await cache.put(new URL("receipt/first", scope), Response.json(receipt));
    await cache.put(new URL("receipt/second", scope), Response.json(receipt));
    const unrelated = await caches.open(otherCache);
    await unrelated.put(sentinelURL, new Response("keep this entry"));
  }, { scope: scope.href, ownCache, otherCache, sentinelURL, receipt });
  await seed.close();
  assert.equal(context.pages().length, 0);

  const page = await context.newPage();
  await page.goto(entry);
  const rows = page.locator("#receipts li");
  await rows.nth(1).waitFor();
  await page.getByRole("button", { name: "Read worker receipt", exact: true }).click();
  await page.getByText("Worker receipts refreshed.", { exact: true }).waitFor();
  const expected = `${receipt.target} · ${receipt.occurrenceId} · Worker received ${receipt.receivedAt} · Display request ${receipt.displayRequest}`;
  assert.deepEqual(await rows.allTextContents(), [expected, expected]);

  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  await page.getByRole("button", { name: "Remove test subscription", exact: true }).click();
  await page.getByText(/^Subscription, fixture worker and local receipts cleared\./).waitFor();
  assert.deepEqual(await rows.allTextContents(), [emptyText]);
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(entry);
  await reopened.getByText(emptyText, { exact: true }).waitFor();
  assert.deepEqual(await reopened.locator("#receipts li").allTextContents(), [emptyText]);
  const remaining = await reopened.evaluate(async ({ ownCache, otherCache, sentinelURL }) => {
    const sentinel = await caches.match(sentinelURL, { cacheName: otherCache });
    return { ownCacheExists: await caches.has(ownCache), sentinel: await sentinel?.text() };
  }, { ownCache, otherCache, sentinelURL });
  assert.deepEqual(remaining, { ownCacheExists: false, sentinel: "keep this entry" });
});

test("the receiver refuses enrollment and export when browser notification permission is denied", async t => {
  const assets = await receiverAssets();
  // This passes the fixture's shape check without providing a usable VAPID key.
  const inertKey = Buffer.from([4, ...Array(64).fill(0)]).toString("base64url");
  assets.set("/receiver/public-key.mjs", ["text/javascript",
    `export const applicationServerKey = ${JSON.stringify(inertKey)};`]);

  const entry = new URL("https://klaxon-reminder.invalid/receiver/index.html");
  const browser = await launchBrowser(t);
  const context = await browser.newContext({ offline: true });
  context.setDefaultTimeout(10_000);
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const asset = url.origin === entry.origin && assets.get(url.pathname);
    if (!asset) return route.abort();
    const [contentType, body] = asset;
    return route.fulfill({ contentType, body });
  });

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { targetInfo: { browserContextId } } = await cdp.send("Target.getTargetInfo");
  assert.ok(browserContextId);
  await cdp.send("Browser.setPermission", {
    browserContextId,
    origin: entry.origin,
    permission: { name: "notifications" },
    setting: "denied",
  });
  const downloads = [];
  page.on("download", download => downloads.push(download.suggestedFilename()));

  await page.goto(entry.href);
  await page.getByText("No worker receipts recorded.", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(async () => ({
    secure: isSecureContext,
    notification: Notification.permission,
    permission: (await navigator.permissions.query({ name: "notifications" })).state,
  })), { secure: true, notification: "denied", permission: "denied" });

  await page.getByRole("combobox").selectOption("windows-edge");
  await page.getByRole("button", { name: "Enable test reminders", exact: true }).click();
  await page.getByText("Permission was not granted. Stop this test.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);

  await page.getByRole("button", { name: "Save private subscription", exact: true }).click();
  await page.getByText("Enable test reminders for this device first.", { exact: true }).waitFor();
  assert.deepEqual(downloads, []);
});
