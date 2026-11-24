import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { exerciseSession } from "./packaged-session/check.mjs";
import { checkSessionPage, containsMarker } from "./packaged-session/web-check.mjs";

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
  const input = await readFile(join(nativeDir, ".frontend/index.html"), "utf8");
  const expectedPolicy = input.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(expectedPolicy, "Portable bundle must carry its script and style hashes");
  assert.equal(policy, expectedPolicy[1], "Packaged script and style hashes must match the current portable build");
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

async function withWindowsHost(exe, profile, action, session) {
  const host = spawn(exe, [], { windowsHide: true, env: { ...process.env,
    ...(session && { KLAXON_P0_SESSION_RUN: session.runName }),
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1",
  } });
  host.stdout.on("data", chunk => session?.stdout.push(chunk));
  host.stderr.on("data", chunk => session?.stderr.push(chunk));
  let spawnError;
  host.once("error", error => { spawnError = error; });
  const closed = new Promise(resolve => host.once("close", resolve));
  let browser;
  let attachedEndpoint;
  const portFiles = ["EBWebView/DevToolsActivePort", "DevToolsActivePort"];
  const observed = new Set();
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (host.exitCode !== null || !host.pid) throw new Error("Windows host exited before attachment (exit " + host.exitCode + ")");
      for (const file of portFiles) {
        const data = await readFile(join(profile, file), "utf8").catch(() => "");
        if (!data) continue;
        observed.add(file);
        const [port, path] = data.trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && path?.startsWith("/devtools/browser/")) {
          const endpoint = "ws://127.0.0.1:" + port + path;
          if (session?.endpoints.has(endpoint)) continue;
          browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 }).catch(() => undefined);
          if (browser) {
            session?.endpoints.add(endpoint);
            attachedEndpoint = endpoint;
            break;
          }
        }
      }
      if (browser) break;
      await delay(300);
    }
    assert.ok(browser, "WebView2 attach timed out, host PID " + host.pid + ", exit " + host.exitCode +
      ", observed port files: " + ([...observed].join(", ") || "none"));
    const context = browser.contexts()[0];
    return await action(context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 }), host.pid);
  } finally {
    try { await browser?.close(); }
    finally {
      host.kill();
      await closed;
      if (session && attachedEndpoint) {
        // The WebView2 browser may outlive its native host and be reused if we reopen too soon.
        const address = new URL(attachedEndpoint);
        let active = true;
        for (let attempt = 0; active && attempt < 100; attempt++) {
          try {
            const response = await fetch("http://" + address.host + "/json/version", { signal: AbortSignal.timeout(600) });
            const info = await response.json();
            // Chromium may advertise localhost even though we connected to 127.0.0.1.
            active = new URL(info.webSocketDebuggerUrl).pathname === address.pathname;
          } catch (error) {
            // A timeout or unreadable response alone does not establish retirement.
            active = error.cause?.code !== "ECONNREFUSED";
          }
          if (active) await delay(200);
        }
        assert.ok(!active, "prior WebView2 endpoint remained active after its host exited");
      }
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

async function windowsSession() {
  const exe = join(nativeDir, "src-tauri/target/debug/windows_session.exe");
  await access(exe);
  const html = await readFile(join(nativeDir, ".run/windows-session-frontend/index.html"), "utf8");
  const expectedPolicy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.match(expectedPolicy, /connect-src 'none'/);
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-session-"));
  const profile = join(root, "webview");
  const record = join(root, "packaged.bin");
  const capture = { runName: basename(root), endpoints: new Set(), stdout: [], stderr: [] };
  const pids = new Set();
  let replies = 0;
  let webviewVersion;
  async function launch(actions) {
    await withWindowsHost(exe, profile, async (page, pid) => {
      assert.ok(!pids.has(pid), "expected a new native Windows host PID");
      pids.add(pid);
      await page.waitForURL("http://tauri.localhost/**");
      const policy = page.locator('meta[http-equiv="Content-Security-Policy"]').first();
      assert.equal(await policy.getAttribute("content"), expectedPolicy);
      assert.equal(await page.evaluate(() => window.p0Replies === undefined), true, "expected a fresh WebView");
      webviewVersion = page.context().browser().version();
      await checkSessionPage(page, actions);
      replies += actions.length;
    }, capture);
  }
  try {
    await launch([["Resume session", "signed-out"], ["Start synthetic session", "fixture-ready"],
      ["Start synthetic session", "unavailable"]]);
    const sealed = await readFile(record);
    assert.ok(sealed.length > 0 && !containsMarker(sealed.toString("latin1")) &&
      !containsMarker(sealed.toString("utf16le")), "expected only a protected record");
    const corrupt = Buffer.from(sealed);
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(record, corrupt);
    await launch([["Resume session", "unavailable"]]);
    assert.ok((await readFile(record)).equals(corrupt), "unreadable record should remain available for recovery");
    await writeFile(record, sealed);
    await launch([["Resume session", "authenticated"], ["Sign out", "signed-out"]]);
    assert.deepEqual(await readdir(root), ["webview"], "logout should remove the native slot");
    await launch([["Resume session", "signed-out"]]);
    assert.deepEqual(await readdir(root), ["webview"], "cold resume recreated a native slot");
    for (const chunks of [capture.stdout, capture.stderr]) {
      const log = Buffer.concat(chunks);
      assert.ok(!containsMarker(log.toString("utf8")) && !containsMarker(log.toString("utf16le")), "marker in native host output");
    }
    assert.equal(Buffer.concat(capture.stdout).toString("utf8").split("P0 Windows session fixture ready").length - 1, pids.size);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
  await assert.rejects(access(root), { code: "ENOENT" });
  console.log("PASS packaged Windows session:", pids.size, "host PIDs and fresh WebViews,", replies,
    "status-only replies; native and WebView output checked, signed out after relaunch, temporary profile and record removed; WebView2", webviewVersion);
}

async function android() {
  assert.match(serial ?? "", /^emulator-\d+$/, "Pass a disposable AVD serial");
  const deviceAdb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-s", serial, ...args],
    { encoding: "utf8", timeout: 30000 }).trim();
  assert.equal(deviceAdb("shell", "getprop", "ro.kernel.qemu"), "1");
  const session = platform === "android-session";
  if (session) assert.match(deviceAdb("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonSessionP0_[A-Za-z0-9]+$/);
  assert.equal(deviceAdb("shell", "getprop", "sys.boot_completed"), "1");
  assert.equal(deviceAdb("shell", "settings", "get", "global", "airplane_mode_on"), "1", "Enable airplane mode on the AVD");
  assert.match(deviceAdb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
  assert.equal(deviceAdb("shell", "pm", "list", "packages", appId), "", "Use an AVD without a previous probe installation");
  const apk = join(nativeDir, session ? ".run/klaxon-p0-x86_64-session.apk" : ".run/klaxon-p0-x86_64-fixture.apk");
  deviceAdb("install", apk);
  try {
    async function withActivity(action) {
      deviceAdb("shell", "am", "start", "-W", "-n", appId + "/.MainActivity");
      const pid = deviceAdb("shell", "pidof", appId);
      assert.match(pid, /^\d+$/);
      const socket = "webview_devtools_remote_" + pid;
      const port = deviceAdb("forward", "tcp:0", "localabstract:" + socket);
      let browser;
      try {
        const endpoint = "http://127.0.0.1:" + port;
        for (let attempt = 0; attempt < 100; attempt++) {
          const targets = await fetch(endpoint + "/json/list", { signal: AbortSignal.timeout(1500) })
            .then(response => response.json()).catch(() => []);
          if (targets.some(target => target.type === "page" && target.url === "http://tauri.localhost/")) break;
          await delay(300);
        }
        browser = await chromium.connectOverCDP("ws://127.0.0.1:" + port + "/devtools/browser",
          { noDefaults: true, timeout: 15000 });
        const context = browser.contexts()[0];
        return await action(context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 }), pid);
      } finally {
        try { await browser?.close(); }
        finally { deviceAdb("forward", "--remove", "tcp:" + port); }
      }
    }
    if (session) return await exerciseSession(withActivity, deviceAdb, appId);
    const saved = await withActivity(exercise);
    deviceAdb("shell", "am", "force-stop", appId);
    await withActivity(page => verifyRestart(page, saved, apk));
  } finally {
    deviceAdb("uninstall", appId);
    assert.equal(deviceAdb("shell", "pm", "list", "packages", appId), "");
  }
}

if (platform === "windows") await windows();
else if (platform === "windows-session") await windowsSession();
else if (platform === "android" || platform === "android-session") await android();
else throw new Error("Choose windows, windows-session, android or android-session. Android requires a disposable emulator serial.");
