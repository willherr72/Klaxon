import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { compile } from "svelte/compiler";

const android = process.argv.includes("--android-chrome");
const native = process.argv.includes("--webview2");
if (android && native) throw new Error("Choose one platform per probe run");
const hostedUrl = process.env.P0_CONVEX_URL;
if (hostedUrl !== undefined && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud\/?$/.test(hostedUrl)) {
  throw new Error("P0_CONVEX_URL must be an HTTPS Convex cloud deployment origin");
}
const backendOrigin = hostedUrl ? new URL(hostedUrl).origin : "http://127.0.0.1:3210";
function fixtureAccount(suffix) {
  const username = process.env["P0_USER_" + suffix];
  const password = process.env["P0_PASS_" + suffix];
  if (!username || !password) throw new Error("Hosted mode requires both privately seeded fixture accounts");
  return { username, password };
}
const accounts = hostedUrl ? [fixtureAccount("A"), fixtureAccount("B")] : [];
if (hostedUrl && accounts[0].username === accounts[1].username) throw new Error("Use distinct fixture accounts");
// The runner retains fixture credentials in memory. Subprocesses only need their ordinary platform environment.
for (const name of Object.keys(process.env)) {
  if (/^(CONVEX_|P0_(USER|PASS)_)/i.test(name)) delete process.env[name];
}
const bundle = await build({
  entryPoints: ["browser.js"], bundle: true, write: false, conditions: ["browser"],
  define: { P0_BACKEND_ORIGIN: JSON.stringify(backendOrigin) },
  plugins: [{
    name: "svelte",
    setup(build) {
      build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
        contents: compile(await readFile(path, "utf8"), { filename: path }).js.code,
      }));
    },
  }],
});
const server = createServer((req, res) => {
  if (req.url === "/probe.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(bundle.outputFiles[0].contents);
  } else {
    res.end('<!doctype html><title>Klaxon P0</title><body><script src="/probe.js"></script></body>');
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
const mappings = [];
let androidBrowser;
const hosts = [];
const signedInPages = new Set();
async function webviewPage(url) {

  const userData = await mkdtemp(join(tmpdir(), "klaxon-p0-webview-"));
  const host = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
    "-File", "webview2.ps1", "-UserData", userData, "-Url", url],
    { windowsHide: true, stdio: "inherit" });
  const exited = new Promise(resolve => host.once("exit", resolve));
  hosts.push({ host, userData, exited });
  for (let attempt = 0; attempt < 240; attempt++) {
    if (host.exitCode !== null) throw new Error("WebView2 host exited");
    const metadata = await readFile(join(userData, "EBWebView", "DevToolsActivePort"), "utf8").catch(() => "");
    const [port, socketPath] = metadata.trim().split(/\r?\n/);
    if (/^\d+$/.test(port) && socketPath?.startsWith("/devtools/browser/")) {
      const connection = await chromium.connectOverCDP("ws://127.0.0.1:" + port + socketPath, { timeout: 15000 });
      hosts.at(-1).connection = connection;
      const context = connection.contexts()[0];
      return context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
    }
    await delay(250);
  }
  throw new Error("Timed out starting WebView2");
}
async function run() {
  if (android) androidBrowser = await (await import("./android-chrome.mjs")).androidChrome(server.address().port, mappings, !hostedUrl);
  if (!native) browser = await chromium.launch({ channel: "msedge" });
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const credentials = () => ({ username: "probe" + randomUUID().replaceAll("-", ""), password: randomUUID() });
  const shared = accounts[0] ?? credentials();
  async function client(identity, signup, onAndroid = false) {
    const page = native ? await webviewPage(endpoint) : onAndroid ? await androidBrowser.contexts()[0].newPage() : await browser.newPage();
    page.setDefaultTimeout(15000);
    if (native) await page.waitForURL(endpoint + "/");
    else await page.goto(endpoint);
    await page.waitForFunction(() => Boolean(window.probe));
    assert.equal(await page.evaluate(([identity, signup]) => window.probe.login(identity, signup), [identity, signup]), true);
    signedInPages.add(page);
    return page;
  }
  const first = await client(shared, !hostedUrl);
  if (hostedUrl) {
    assert.equal(await first.evaluate(identity => window.probe.anonymousSignupDenied(identity), credentials()), true);
  }
  const second = await client(shared, false, android);
  const stranger = await client(accounts[1] ?? credentials(), !hostedUrl);
  assert.equal(await second.evaluate(() => window.probe.refresh()), true);
  const id = await first.evaluate(() => window.probe.create("Synthetic reminder"));
  async function observes(page, title) {
    await page.waitForFunction(([id, title]) =>
      Array.from(document.querySelectorAll("[data-task-id]")).some(row =>
        row.dataset.taskId === id && row.textContent === title), [id, title]);
  }
  await observes(second, "Synthetic reminder");
  if (android && hostedUrl) await first.context().setOffline(true);
  try {
    await second.evaluate(id => window.probe.rename(id, "Updated synthetic reminder"), id);
    await observes(second, "Updated synthetic reminder");
  } finally {
    if (android && hostedUrl) await first.context().setOffline(false);
  }
  await observes(first, "Updated synthetic reminder");
  await assert.rejects(stranger.evaluate(id => window.probe.rename(id, "Unauthorized"), id), /Task unavailable/);
  assert.deepEqual(await stranger.evaluate(() => window.probe.list()), []);
  for (const page of [first, second, stranger]) {
    assert.equal(await page.evaluate(() => window.probe.logout()), true);
    signedInPages.delete(page);
  }
  console.log("PASS", native ? "WebView2 " + hosts[0].connection.version() : (android ? "Android Chrome " + androidBrowser.version() + " / Edge " : "Edge ") + browser.version(),
    hostedUrl ? "hosted signup denied," : "local signup,",
    "login, rotated refresh, live create/rename, ownership check, logout and revoked refresh.");
}
let timer;
try {
  await Promise.race([run(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Probe exceeded four minutes")), 240000);
  })]);
} finally {
  clearTimeout(timer);
  // Attempt revocation even when a later cross-client assertion fails.
  await Promise.race([
    Promise.allSettled([...signedInPages].map(page => page.evaluate(() => window.probe.logout()))),
    delay(5000, undefined, { ref: false }),
  ]);
  server.close();
  server.closeAllConnections();
  const results = await Promise.allSettled([browser?.close(), androidBrowser?.close(), ...hosts.map(async ({ host, exited, userData, connection }) => {
    try {
      await connection?.close();
    } finally {
      host.kill();
      await exited;
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })]);
  results.push(...await Promise.allSettled(mappings.reverse().map(async remove => remove())));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
