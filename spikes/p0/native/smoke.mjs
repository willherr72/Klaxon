import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { _android, chromium } from "playwright-core";

const nativeDir = fileURLToPath(new URL(".", import.meta.url));
const appId = "dev.klaxon.p0native";
const [platform, serial] = process.argv.slice(2);

async function exercise(page) {
  page.setDefaultTimeout(20000);
  await page.getByText("Local fixture", { exact: true }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.hostname, "tauri.localhost");
  assert.equal(await page.evaluate(() => !!window.__TAURI_INTERNALS__), true);
  assert.equal(await page.locator("header").evaluate(el => getComputedStyle(el).display), "flex");
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').first().getAttribute("content");
  assert.match(policy, /connect-src 'none'/);
  const title = "Native fixture " + randomUUID();
  const updated = title + " updated";
  await page.getByLabel("Task title").fill(title);
  await page.getByRole("button", { name: "Create task" }).click();
  const row = page.getByRole("listitem").filter({ hasText: title });
  await row.waitFor();
  const id = await row.getAttribute("data-task-id");
  assert.match(id, /^[0-9a-f-]{36}$/);
  await row.getByRole("button", { name: "Rename" }).click();
  await row.getByLabel("New title").fill(updated);
  await row.getByRole("button", { name: "Save title" }).click();
  await page.getByText(updated, { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Read tasks" }).click();
  await page.getByText(updated, { exact: true }).waitFor();
  assert.equal(await row.getAttribute("data-task-id"), id);
  return { id, title: updated };
}

async function verifyRestart(page, saved, artifact) {
  page.setDefaultTimeout(20000);
  const row = page.getByRole("listitem").filter({ hasText: saved.title });
  await row.waitFor();
  assert.equal(await row.getAttribute("data-task-id"), saved.id);
  assert.equal(await row.locator("strong").textContent(), saved.title);
  const digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  console.log("PASS", platform, new URL(page.url()).origin, await page.evaluate(() => navigator.userAgent),
    "fixture, CSS, create, rename, reload/read and native process restart with stable task ID; SHA-256", digest);
}

async function withWindowsHost(exe, profile, action) {
  const host = spawn(exe, [], { windowsHide: true, env: { ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1",
  } });
  const exited = new Promise(resolve => { host.once("exit", resolve); host.once("error", resolve); });
  let browser;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (host.exitCode !== null || !host.pid) throw new Error("Windows host exited before attachment");
      const data = await readFile(join(profile, "EBWebView", "DevToolsActivePort"), "utf8").catch(() => "");
      const [port, path] = data.trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) {
        browser = await chromium.connectOverCDP("ws://127.0.0.1:" + port + path, { timeout: 2000 }).catch(() => undefined);
        if (browser) break;
      }
      await delay(300);
    }
    assert.ok(browser, "WebView2 did not open its CDP socket");
    const context = browser.contexts()[0];
    return await action(context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 }));
  } finally {
    try { await browser?.close(); }
    finally {
      host.kill();
      await exited;
    }
  }
}

async function windows() {
  const exe = join(nativeDir, "src-tauri/target/debug/klaxon-p0-native.exe");
  await access(exe);
  const profile = await mkdtemp(join(tmpdir(), "klaxon-p0-native-webview-"));
  try {
    const saved = await withWindowsHost(exe, profile, exercise);
    await withWindowsHost(exe, profile, page => verifyRestart(page, saved, exe));
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
}

async function android() {
  assert.match(serial ?? "", /^emulator-\d+$/, "Pass a disposable AVD serial");
  const adb = (...args) => execFileSync(process.env.ADB ?? "adb", args, { encoding: "utf8", timeout: 30000 }).trim();
  // Playwright enumerates the local ADB server. Only attach when the selected AVD is its sole device.
  assert.deepEqual(adb("devices").split(/\r?\n/).slice(1), [serial + "\tdevice"]);
  const deviceAdb = (...args) => adb("-s", serial, ...args);
  assert.equal(deviceAdb("shell", "getprop", "ro.kernel.qemu"), "1");
  assert.equal(deviceAdb("shell", "getprop", "sys.boot_completed"), "1");
  assert.equal(deviceAdb("shell", "pm", "list", "packages", appId), "", "Use an AVD without a previous probe installation");
  const apk = join(nativeDir, ".run/klaxon-p0-x86_64-fixture.apk");
  deviceAdb("install", apk);
  let device;
  try {
    [device] = await _android.devices({ omitDriverInstall: true });
    assert.equal(device.serial(), serial);
    async function launch() {
      deviceAdb("shell", "am", "start", "-W", "-n", appId + "/.MainActivity");
      const pid = Number(deviceAdb("shell", "pidof", appId));
      const webview = await device.webView({ pkg: appId, socketName: "webview_devtools_remote_" + pid }, { timeout: 45000 });
      return webview.page();
    }
    const saved = await exercise(await launch());
    deviceAdb("shell", "am", "force-stop", appId);
    await verifyRestart(await launch(), saved, apk);
  } finally {
    try { await device?.close(); }
    finally { deviceAdb("uninstall", appId); }
  }
}

if (platform === "windows") await windows();
else if (platform === "android") await android();
else throw new Error("Run node smoke.mjs windows or node smoke.mjs android emulator-PORT");
