import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { exerciseSession } from "./packaged-session/check.mjs";
import { checkProfileBytes, checkSessionPage, containsMarker, containsSdkAccess } from "./packaged-session/web-check.mjs";
import { checkTaskDenial, checkTaskSwitch } from "./packaged-session/task-check.mjs";
import { exerciseWindowsSdkHandoff } from "./packaged-session/sdk-check.mjs";
import { exerciseAndroidSdkHandoff } from "./packaged-session/android-sdk-check.mjs";
import { readFixtureFile } from "./packaged-session/adb-file.mjs";

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

function windowsLoopbackListeners() {
  const sockets = execFileSync("netstat.exe", ["-ano", "-p", "tcp"],
    { encoding: "utf8", timeout: 5000, windowsHide: true });
  const listeners = [];
  for (const line of sockets.split(/\r?\n/)) {
    const [protocol, local, remote, , owner] = line.trim().split(/\s+/);
    const port = /^127\.0\.0\.1:([1-9]\d*)$/.exec(local)?.[1];
    const pid = Number(owner);
    if (protocol === "TCP" && port && remote === "0.0.0.0:0" && Number.isSafeInteger(pid) && pid > 0) {
      listeners.push({ port, pid });
    }
  }
  return listeners;
}

function windowsListenerPid(port) {
  const listeners = windowsLoopbackListeners().filter(listener => listener.port === port);
  return listeners.length === 1 ? listeners[0].pid : undefined;
}

function windowsProfilePids(hostPid, profile) {
  // Query only WebView2 children of the fixture host. Return PIDs for this profile
  // without exposing their command lines.
  const script = String.raw`
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $fixtureProfile = [IO.Path]::GetFullPath($env:KLAXON_P0_WEBVIEW_PROFILE)
    $browserProfile = Join-Path $fixtureProfile 'EBWebView'
    Get-CimInstance Win32_Process -Filter "ParentProcessId = ${hostPid} AND Name = 'msedgewebview2.exe'" | ForEach-Object {
      if ($_.CommandLine -match '(?i)(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^"\s]+))(?=\s|$)') {
        $path = [IO.Path]::GetFullPath($Matches[1] + $Matches[2] + $Matches[3])
        if ($path -eq $fixtureProfile -or $path -eq $browserProfile) { $_.ProcessId }
      }
    }
  `;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
    env: { ...process.env, KLAXON_P0_WEBVIEW_PROFILE: profile },
  });
  return output.trim().split(/\r?\n/).map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

function windowsPidIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function withWindowsHost(exe, profile, action, capture) {
  const portFiles = ["EBWebView/DevToolsActivePort", "DevToolsActivePort"];
  const removed = [];
  // Chromium can leave the debugger files after exit. Keep the profile and its
  // data, but require this launch to create its own debugger advertisement.
  for (const file of portFiles) {
    try {
      await unlink(join(profile, file));
      removed.push(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const started = Date.now();
  const host = spawn(exe, [], { windowsHide: true, env: { ...process.env,
    ...(capture.runName && { KLAXON_P0_SESSION_RUN: capture.runName }),
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1",
  } });
  host.stdout.on("data", chunk => capture.stdout?.push(chunk));
  host.stderr.on("data", chunk => capture.stderr?.push(chunk));
  let spawnError;
  host.once("error", error => { spawnError = error; });
  const closed = new Promise(resolve => host.once("close", resolve));
  const observations = new Map(portFiles.map(file => [file, "missing"]));
  const ownedPids = new Set();
  function assertHostRunning() {
    if (spawnError) throw spawnError;
    assert.ok(host.pid && host.exitCode === null && host.signalCode === null,
      "Windows fixture host exited (PID " + host.pid + ", exit " + host.exitCode + ", signal " + host.signalCode + ")");
  }
  function observeOwnedPids() {
    const pids = windowsProfilePids(host.pid, profile);
    for (const pid of pids) ownedPids.add(pid);
    return pids;
  }

  let browser;
  let browserPid;
  let attachedPort;
  try {
    assertHostRunning();
    assert.ok(!capture.hostPids.has(host.pid), "expected a new native Windows host PID");
    capture.hostPids.add(host.pid);
    for (let attempt = 0; attempt < 150 && !browser; attempt++) {
      assertHostRunning();
      for (const file of portFiles) {
        let data;
        try {
          data = await readFile(join(profile, file), "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") observations.set(file, "read failed (" + error.code + ")");
          continue;
        }
        const [port, path, ...extra] = data.trim().split(/\r?\n/);
        if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || extra.length ||
            !/^\/devtools\/browser\/[a-z0-9_-]+$/i.test(path ?? "")) {
          observations.set(file, "invalid debugger advertisement");
          continue;
        }

        const pid = windowsListenerPid(port);
        if (!pid) {
          observations.set(file, "port " + port + " has no unique IPv4 loopback listener");
          continue;
        }
        if (!observeOwnedPids().includes(pid)) {
          observations.set(file, "port " + port + " listener PID " + pid + " is outside the fixture host/profile");
          continue;
        }
        assert.ok(!capture.browserPids.has(pid), "expected a new WebView2 browser PID, got " + pid);
        assertHostRunning();
        const currentPid = windowsListenerPid(port);
        if (currentPid !== pid) {
          observations.set(file, "port " + port + " changed from PID " + pid + " to " + (currentPid ?? "no listener"));
          continue;
        }
        const endpoint = "ws://127.0.0.1:" + port + path;
        try {
          browser = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
          browserPid = pid;
          attachedPort = port;
          break;
        } catch (error) {
          const reason = error.message.split(/\r?\n/)[0].replaceAll(endpoint, "<fixture endpoint>");
          observations.set(file, "CDP connection failed for verified PID " + pid + " on port " + port + " (" + reason + ")");
        }
      }
      if (!browser) await delay(300);
    }
    if (!browser) {
      assertHostRunning();
      const current = observeOwnedPids();
      const listeners = windowsLoopbackListeners().filter(listener => current.includes(listener.pid));
      const details = [...observations].map(([file, status]) => file + ": " + status).join(", ");
      throw new Error("WebView2 attach timed out after " + (Date.now() - started) + "ms, host PID " + host.pid +
        ", profile browser PIDs: " + (current.join(", ") || "none") +
        ", profile listeners: " + (listeners.map(({ port, pid }) => port + " (PID " + pid + ")").join(", ") || "none") +
        ", retired files removed: " + (removed.join(", ") || "none") + ", " + details);
    }

    const debuggerSession = await browser.newBrowserCDPSession();
    try {
      const { processInfo } = await debuggerSession.send("SystemInfo.getProcessInfo");
      assert.equal(processInfo.find(process => process.type === "browser")?.id, browserPid,
        "CDP browser PID differs from the verified WebView2 listener PID");
    } finally {
      await debuggerSession.detach();
    }
    assertHostRunning();
    assert.equal(windowsListenerPid(attachedPort), browserPid, "WebView2 listener changed during CDP attachment");
    capture.browserPids.add(browserPid);

    const context = browser.contexts()[0];
    assert.ok(context, "WebView2 reported no fixture browser context");
    const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
    await page.waitForURL("http://tauri.localhost/**");
    assertHostRunning();
    return await action(page);
  } finally {
    try { await browser?.close(); }
    finally {
      host.kill();
      await closed;
      // Closing the debugger connection can precede WebView2 exit. Wait for
      // the verified profile processes before clearing their debugger files.
      let running = [...ownedPids].filter(windowsPidIsRunning);
      for (let attempt = 0; attempt < 100 && running.length; attempt++) {
        await delay(200);
        running = running.filter(windowsPidIsRunning);
      }
      assert.equal(running.length, 0, "fixture WebView2 browser PIDs still active after host exit: " + running.join(", "));
    }
  }
}

async function windows() {
  const exe = join(nativeDir, "src-tauri/target/debug/klaxon-p0-native.exe");
  await access(exe);
  const profile = await mkdtemp(join(tmpdir(), "klaxon-p0-native-webview-"));
  const capture = { hostPids: new Set(), browserPids: new Set() };
  try {
    const saved = await withWindowsHost(exe, profile, exercise, capture);
    await withWindowsHost(exe, profile, page => verifyRestart(page, saved, exe), capture);
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
}

async function exerciseNativeTasks(launch, root, record) {
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
  const outage = join(root, "p0-provider-offline");
  await writeFile(outage, "", { flag: "wx" });
  await launch([["Resume session", "unavailable"]]);
  assert.ok((await readFile(record)).equals(corrupt), "provider outage must not hide a storage failure");
  await writeFile(record, sealed);
  await launch([["Resume session", "retry-required"], checkTaskDenial]);
  assert.ok((await readFile(record)).equals(sealed), "provider outage must preserve the valid protected record");
  await rm(outage);
  await launch([checkTaskDenial, ["Resume session", "authenticated"], checkTaskSwitch]);
  assert.deepEqual(await readdir(root), ["webview"], "logout should remove the native slot");
  await launch([["Resume session", "signed-out"], checkTaskDenial]);
  assert.deepEqual(await readdir(root), ["webview"], "cold resume recreated a native slot");
}

async function windowsSession(sdk = false) {
  const exe = join(nativeDir, "src-tauri/target/debug/windows_session.exe");
  await access(exe);
  const html = await readFile(join(nativeDir, ".run/windows-session-frontend/index.html"), "utf8");
  const expectedPolicy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.match(expectedPolicy, /connect-src 'none'/);
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-session-"));
  const profile = join(root, "webview");
  const record = join(root, "packaged.bin");
  const pids = new Set();
  const capture = { runName: basename(root), hostPids: pids, browserPids: new Set(), stdout: [], stderr: [] };
  let replies = 0;
  let webviewVersion;
  async function launch(actions) {
    await withWindowsHost(exe, profile, async page => {
      if (sdk) {
        await page.goto("http://tauri.localhost/#sdk");
        await page.reload();
      }
      const policy = page.locator('meta[http-equiv="Content-Security-Policy"]').first();
      assert.equal(await policy.getAttribute("content"), expectedPolicy);
      assert.equal(await page.evaluate(() => window.p0Replies === undefined), true, "expected a fresh WebView");
      webviewVersion = page.context().browser().version();
      await checkSessionPage(page, actions, sdk ? "windows" : undefined);
      replies += actions.filter(Array.isArray).length;
    }, capture);
  }
  try {
    if (sdk) await exerciseWindowsSdkHandoff(launch, root, record);
    else await exerciseNativeTasks(launch, root, record);
    for (const chunks of [capture.stdout, capture.stderr]) {
      const log = Buffer.concat(chunks);
      for (const encoding of ["utf8", "utf16le"]) {
        assert.ok(!containsMarker(log.toString(encoding)) && !containsSdkAccess(log.toString(encoding)),
          "session material in native host output");
      }
    }
    assert.equal(Buffer.concat(capture.stdout).toString("utf8").split("P0 Windows session fixture ready").length - 1, pids.size);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
  await assert.rejects(access(root), { code: "ENOENT" });
  if (sdk) {
    console.log("PASS packaged Windows DPAPI-to-SDK:", pids.size,
      "fresh hosts and WebViews; SDK read, subscription, simulated access cutover and sign-out checked; fixture removed; WebView2", webviewVersion);
    return;
  }
  console.log("PASS packaged Windows session:", pids.size, "host PIDs and fresh WebViews,", replies,
    "isolated session replies plus owner-filtered native reads, live channel updates and late delivery across sign-out/owner switch;",
    "native and WebView output checked, signed out after relaunch, temporary profile and record removed; WebView2", webviewVersion);
}

async function android() {
  assert.match(serial ?? "", /^emulator-\d+$/, "Pass a disposable AVD serial");
  const sdk = platform === "android-sdk";
  const deviceAdbBytes = (args, input) => execFileSync(process.env.ADB ?? "adb", [
    ...(sdk ? ["-H", "127.0.0.1"] : []), "-s", serial, ...args,
  ], { input, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  const deviceAdb = (...args) => deviceAdbBytes(args).toString("utf8").trim();
  assert.equal(deviceAdb("shell", "getprop", "ro.kernel.qemu"), "1");
  const session = platform === "android-session" || sdk;
  if (session) assert.match(deviceAdb("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonSessionP0_[A-Za-z0-9]+$/);
  assert.equal(deviceAdb("shell", "getprop", "sys.boot_completed"), "1");
  assert.equal(deviceAdb("shell", "settings", "get", "global", "airplane_mode_on"), "1", "Enable airplane mode on the AVD");
  assert.match(deviceAdb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
  assert.equal(deviceAdb("shell", "pm", "list", "packages", appId), "", "Use an AVD without a previous probe installation");
  function assertNoMappings() {
    assert.ok(!deviceAdb("forward", "--list").split(/\r?\n/).some(line => line.split(/\s+/)[0] === serial),
      "Require an AVD without ADB forwards");
    assert.equal(deviceAdb("reverse", "--list"), "", "Require an AVD without ADB reverse routes");
  }
  if (sdk) {
    assert.equal(deviceAdb("shell", "getprop", "ro.product.cpu.abi"), "x86_64");
    assert.equal(deviceAdb("shell", "settings", "get", "global", "wifi_on"), "0", "Disable Wi-Fi on the AVD");
    assertNoMappings();
  }
  const apk = join(nativeDir, session ? ".run/klaxon-p0-x86_64-session.apk" : ".run/klaxon-p0-x86_64-fixture.apk");
  await access(apk);
  assert.match(deviceAdb("install", apk), /Success/);
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
    if (sdk) {
      const control = "cache/p0-binary-control";
      deviceAdb("shell", "run-as", appId, "sh", "-c", "'printf \"\\000\\012\\015\\377\" > " + control + "'");
      assert.deepEqual(readFixtureFile(deviceAdbBytes, appId, control), Buffer.from([0, 10, 13, 255]));
      deviceAdb("shell", "run-as", appId, "rm", control);
      await exerciseAndroidSdkHandoff(withActivity, deviceAdb, deviceAdbBytes, appId);
      deviceAdb("shell", "am", "force-stop", appId);
      // Android WebView can keep its HTTP cache outside the profile. Inspect each regular file separately.
      const paths = deviceAdb("shell", "run-as", appId, "find", "app_webview", "cache", "-type", "f", "-print0")
        .split("\0").filter(Boolean);
      assert.ok(paths.some(path => path.startsWith("app_webview/")), "expected a populated Android WebView profile");
      let bytes = 0;
      for (const path of paths) {
        assert.match(path, /^(app_webview|cache)\//);
        bytes += await checkProfileBytes([readFixtureFile(deviceAdbBytes, appId, path)]);
      }
      console.log("Inspected", bytes, "bytes from", paths.length, "retired Android WebView profile and app cache files");
      return;
    }
    if (session) return await exerciseSession(withActivity, deviceAdb, appId);
    const saved = await withActivity(exercise);
    deviceAdb("shell", "am", "force-stop", appId);
    await withActivity(page => verifyRestart(page, saved, apk));
  } finally {
    assert.match(deviceAdb("uninstall", appId), /Success/);
    assert.equal(deviceAdb("shell", "pm", "list", "packages", appId), "");
    if (sdk) {
      assertNoMappings();
      console.log("Android fixture APK uninstalled. ADB forwards and reverse routes are empty.");
    }
  }
}

if (platform === "windows") await windows();
else if (platform === "windows-session" || platform === "windows-sdk") await windowsSession(platform === "windows-sdk");
else if (platform === "android" || platform === "android-session" || platform === "android-sdk") await android();
else throw new Error("Choose windows, windows-session, windows-sdk, android, android-session or android-sdk. Android requires a disposable emulator serial.");
