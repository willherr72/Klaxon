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

const bundle = await build({
  entryPoints: ["browser.js"], bundle: true, write: false, conditions: ["browser"],
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
const android = process.argv.includes("--android-chrome");
const mappings = [];
let androidBrowser;
const native = process.argv.includes("--webview2");
const hosts = [];
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
  if (android) androidBrowser = await (await import("./android-chrome.mjs")).androidChrome(server.address().port, mappings);
  if (!native) browser = await chromium.launch({ channel: "msedge" });
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const credentials = () => ({ username: "probe" + randomUUID().replaceAll("-", ""), password: randomUUID() });
  const shared = credentials();
  async function client(identity, signup, onAndroid = false) {
    const page = native ? await webviewPage(endpoint) : onAndroid ? await androidBrowser.contexts()[0].newPage() : await browser.newPage();
    page.setDefaultTimeout(15000);
    if (native) await page.waitForURL(endpoint + "/");
    else await page.goto(endpoint);
    await page.waitForFunction(() => Boolean(window.probe));
    assert.equal(await page.evaluate(([identity, signup]) => window.probe.login(identity, signup), [identity, signup]), true);
    return page;
  }
  const first = await client(shared, true);
  const second = await client(shared, false, android);
  const stranger = await client(credentials(), true);
  assert.equal(await second.evaluate(() => window.probe.refresh()), true);
  const id = await first.evaluate(() => window.probe.create("Synthetic reminder"));
  async function observes(page, title) {
    await page.waitForFunction(([id, title]) =>
      Array.from(document.querySelectorAll("[data-task-id]")).some(row =>
        row.dataset.taskId === id && row.textContent === title), [id, title]);
  }
  await observes(second, "Synthetic reminder");
  await second.evaluate(id => window.probe.rename(id, "Updated synthetic reminder"), id);
  await observes(first, "Updated synthetic reminder");
  await assert.rejects(stranger.evaluate(id => window.probe.rename(id, "Unauthorized"), id), /Task unavailable/);
  assert.deepEqual(await stranger.evaluate(() => window.probe.list()), []);
  for (const page of [first, second, stranger]) {
    assert.equal(await page.evaluate(() => window.probe.logout()), true);
  }
  console.log("PASS", native ? "WebView2 " + hosts[0].connection.version() : (android ? "Android Chrome " + androidBrowser.version() + " / Edge " : "Edge ") + browser.version(),
    "signup, login, rotated refresh, live create/rename, ownership check, logout and revoked refresh.");
}
let timer;
try {
  await Promise.race([run(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Probe exceeded four minutes")), 240000);
  })]);
} finally {
  clearTimeout(timer);
  server.close();
  const results = await Promise.allSettled([browser?.close(), androidBrowser?.close(), ...hosts.map(async ({ host, exited, userData, connection }) => {
    try {
      await connection?.close();
    } finally {
      host.kill();
      await exited;
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  })]);
  for (const remove of mappings.reverse()) remove();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
}
