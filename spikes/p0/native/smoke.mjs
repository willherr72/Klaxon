import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { openTaskLink } from "../task-link-check.mjs";
import { withAndroidFixture } from "./android-install.mjs";
import { exerciseSession } from "./packaged-session/check.mjs";
import { checkProfileBytes, checkSessionPage, containsMarker, containsSdkAccess } from "./packaged-session/web-check.mjs";
import { checkTaskDenial, checkTaskSwitch } from "./packaged-session/task-check.mjs";
import {
  exerciseWindowsLoopbackRefresh, exerciseWindowsLoopbackSignOut, exerciseWindowsSdkHandoff,
} from "./packaged-session/sdk-check.mjs";
import { exerciseAndroidSdkHandoff } from "./packaged-session/android-sdk-check.mjs";
import { readFixtureFile } from "./packaged-session/adb-file.mjs";
import { observeWindowsBrowsers, windowsFixtureProcesses, windowsProcessIdentity } from "./windows-process.mjs";

const nativeDir = fileURLToPath(new URL(".", import.meta.url));
const appId = "dev.klaxon.p0native";
const [platform, platformArgument] = process.argv.slice(2);
const windowsLoopbackCases = {
  "windows-sdk-signout-loopback": {
    exercise: exerciseWindowsLoopbackSignOut,
    name: "sign-out",
    result: "Lost reply retained pending intent and ciphertext. Explicit null cleared the slot.",
  },
  "windows-sdk-refresh-loopback": {
    exercise: exerciseWindowsLoopbackRefresh,
    name: "cold refresh",
    result: "Sign-in denial left the slot empty; an accepted grant seeded it. HTTP 503 preserved ciphertext. Rotation persisted the successor and expiry cleared the slot.",
  },
};

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
  if (platform === "windows") {
    const entry = page.url();
    await openTaskLink(page, entry, saved);
    const history = new URL("tasks/" + encodeURIComponent(saved.id), entry);
    await page.goto(history.href);
    await page.reload();
    assert.equal(page.url(), history.href);
    assert.equal(await page.evaluate(() => !!window.__TAURI_INTERNALS__), true);
    await row.waitFor();
    assert.equal(await row.getAttribute("data-task-id"), saved.id);
    console.log("PASS Windows task fragment and Tauri history-path asset fallback");
  }
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

export async function withWindowsHost(exe, profile, action, capture, env) {
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
  const host = spawn(exe, [], { windowsHide: true, env: { ...process.env, ...env,
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
  const ownedBrowsers = new Map();
  let hostCreated;
  function assertHostRunning() {
    if (spawnError) throw spawnError;
    assert.ok(host.pid && host.exitCode === null && host.signalCode === null,
      "Windows fixture host exited (PID " + host.pid + ", exit " + host.exitCode + ", signal " + host.signalCode + ")");
  }
  function observeRunningHost() {
    assertHostRunning();
    const processes = windowsFixtureProcesses(host.pid, profile);
    assertHostRunning();
    const created = processes.get(host.pid)?.created;
    assert.ok(created, "could not verify the running Windows fixture host");
    if (hostCreated === undefined) {
      const identity = windowsProcessIdentity(host.pid, created);
      assert.ok(!capture.hosts.has(identity), "expected a new native Windows host process");
      capture.hosts.add(identity);
      hostCreated = created;
    }
    assert.equal(created, hostCreated, "the Windows fixture host changed during attachment");
    return observeWindowsBrowsers(processes, { pid: host.pid, created: hostCreated }, ownedBrowsers);
  }
  function runningOwnedBrowsers() {
    if (!host.pid) return [];
    const processes = windowsFixtureProcesses(host.pid, profile);
    if (hostCreated === undefined && host.exitCode === null && host.signalCode === null) {
      hostCreated = processes.get(host.pid)?.created;
    }
    return [...observeWindowsBrowsers(processes, { pid: host.pid, created: hostCreated }, ownedBrowsers, true).keys()];
  }

  let browser;
  let browserPid;
  let browserCreated;
  let attachedPort;
  try {
    assertHostRunning();
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
        const created = observeRunningHost().get(pid);
        if (!created) {
          observations.set(file, "port " + port + " listener PID " + pid + " is outside the fixture host/profile");
          continue;
        }
        assert.ok(!capture.browsers.has(windowsProcessIdentity(pid, created)),
          "expected a new WebView2 browser process, got PID " + pid);
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
          browserCreated = created;
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
      const current = observeRunningHost();
      const listeners = windowsLoopbackListeners().filter(listener => current.has(listener.pid));
      const details = [...observations].map(([file, status]) => file + ": " + status).join(", ");
      throw new Error("WebView2 attach timed out after " + (Date.now() - started) + "ms, host PID " + host.pid +
        ", profile browser PIDs: " + ([...current.keys()].join(", ") || "none") +
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
    assert.equal(observeRunningHost().get(browserPid), browserCreated,
      "WebView2 browser process changed during CDP attachment");
    assert.equal(windowsListenerPid(attachedPort), browserPid, "WebView2 listener changed during CDP attachment");
    capture.browsers.add(windowsProcessIdentity(browserPid, browserCreated));

    const context = browser.contexts()[0];
    assert.ok(context, "WebView2 reported no fixture browser context");
    const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
    await page.waitForURL("http://tauri.localhost/**");
    assertHostRunning();
    return await action(page);
  } finally {
    try { await browser?.close(); }
    finally {
      try {
        // Discover profile children created after the last successful attachment check.
        runningOwnedBrowsers();
      } finally {
        host.kill();
        await closed;
        // A previously verified child may outlive the host and lose readable command-line details.
        const deadline = Date.now() + 20_000;
        let running = runningOwnedBrowsers();
        while (running.length && Date.now() < deadline) {
          await delay(200);
          running = runningOwnedBrowsers();
        }
        assert.equal(running.length, 0, "fixture WebView2 browser PIDs still active after host exit: " + running.join(", "));
      }
    }
  }
}

async function windows() {
  const exe = join(nativeDir, "src-tauri/target/debug/klaxon-p0-native.exe");
  await access(exe);
  const profile = await mkdtemp(join(tmpdir(), "klaxon-p0-native-webview-"));
  const capture = { hosts: new Set(), browsers: new Set() };
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

async function windowsSession(sdk, loopback) {
  const exe = loopback?.exe ?? join(nativeDir, "src-tauri/target/debug/windows_session.exe");
  await access(exe);
  const html = await readFile(join(nativeDir, ".run/windows-session-frontend/index.html"), "utf8");
  const expectedPolicy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
  assert.match(expectedPolicy, /connect-src 'none'/);
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-session-"));
  const profile = join(root, "webview");
  const record = join(root, "packaged.bin");
  const capture = { runName: basename(root), hosts: new Set(), browsers: new Set(), stdout: [], stderr: [] };
  let replies = 0;
  let webviewVersion;
  async function launch(actions, env) {
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
    }, capture, env);
  }
  try {
    if (loopback) await loopback.exercise(launch, root, record);
    else if (sdk) await exerciseWindowsSdkHandoff(launch, root, record);
    else await exerciseNativeTasks(launch, root, record);
    for (const chunks of [capture.stdout, capture.stderr]) {
      const log = Buffer.concat(chunks);
      for (const encoding of ["utf8", "utf16le"]) {
        assert.ok(!containsMarker(log.toString(encoding)) && !containsSdkAccess(log.toString(encoding)),
          "session material in native host output");
      }
    }
    assert.equal(Buffer.concat(capture.stdout).toString("utf8").split("P0 Windows session fixture ready").length - 1,
      capture.hosts.size);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
  await assert.rejects(access(root), { code: "ENOENT" });
  if (loopback) {
    console.log("PASS packaged Windows SDK", loopback.name, "over loopback HTTP.", capture.hosts.size,
      "fresh hosts and WebViews.", loopback.result,
      "Cold access denied and fixture removed. WebView2", webviewVersion);
    return;
  }
  if (sdk) {
    console.log("PASS packaged Windows DPAPI-to-SDK:", capture.hosts.size,
      "fresh hosts and WebViews; SDK read, subscription, simulated access cutover and sign-out checked; fixture removed; WebView2", webviewVersion);
    return;
  }
  console.log("PASS packaged Windows session:", capture.hosts.size, "fresh hosts and WebViews,", replies,
    "isolated session replies plus owner-filtered native reads, live channel updates and late delivery across sign-out/owner switch;",
    "native and WebView output checked, signed out after relaunch, temporary profile and record removed; WebView2", webviewVersion);
}

export async function withWebViewForward(deviceAdb, serial, target, action) {
  // Without the allocated port, a forward to this socket could belong to another caller.
  const port = deviceAdb("forward", "tcp:0", target);
  assert.ok(/^[1-9]\d*$/.test(port) && Number(port) <= 65535, "ADB did not return a valid WebView forward port");
  const source = "tcp:" + port;
  const routesAtPort = () => deviceAdb("forward", "--list").split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(([, local]) => local === source);
  const owned = routes => routes.length === 1 && routes[0][0] === serial && routes[0][2] === target;
  try {
    assert.ok(owned(routesAtPort()), "ADB WebView forward ownership unconfirmed");
    return await action(port);
  } finally {
    if (owned(routesAtPort())) deviceAdb("forward", "--remove", source);
  }
}

export async function withAndroidActivity(deviceAdb, serial, appId, action, { primaryUser = false } = {}) {
  const user = primaryUser ? ["--user", "0"] : [];
  deviceAdb("shell", "am", "start", "-W", ...user, "-n", appId + "/.MainActivity");
  const pid = deviceAdb("shell", "pidof", appId);
  assert.match(pid, /^\d+$/);
  const target = "localabstract:webview_devtools_remote_" + pid;
  return await withWebViewForward(deviceAdb, serial, target, async port => {
    let browser;
    try {
      const url = "http://tauri.localhost/";
      const endpoint = "http://127.0.0.1:" + port;
      for (let attempt = 0; attempt < 100; attempt++) {
        const targets = await fetch(endpoint + "/json/list", { redirect: "error", signal: AbortSignal.timeout(1500) })
          .then(response => response.json()).catch(() => []);
        if (targets.some(target => target.type === "page" && target.url === url)) break;
        if (attempt === 99 && primaryUser) throw new Error("Expected the fixture WebView DevTools target");
        await delay(300);
      }
      browser = await chromium.connectOverCDP("ws://127.0.0.1:" + port + "/devtools/browser",
        { noDefaults: true, timeout: 15000 });
      if (!primaryUser) {
        const context = browser.contexts()[0];
        return await action(context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 }), pid);
      }
      const pages = browser.contexts().flatMap(context => context.pages()).filter(page => page.url() === url);
      assert.equal(pages.length, 1, "Expected one fixture WebView page");
      return await action(pages[0], pid);
    } finally {
      await browser?.close();
    }
  });
}

export async function android(serial, hosted, { requireNetwork = true } = {}) {
  assert.match(serial ?? "", /^emulator-\d+$/, "Pass a disposable AVD serial");
  const sdk = platform === "android-sdk";
  const acceptance = platform === "android-provider-acceptance";
  const provider = platform === "android-provider-preflight" || acceptance || !!hosted;
  const extra = process.argv.slice(4);
  const reconnect = acceptance && extra.length === 1 && extra[0] === "--reconnect";
  if (provider && !hosted) assert.ok(extra.length === 0 || reconnect, "Pass one disposable emulator serial and optional acceptance --reconnect");
  const guarded = sdk || provider;
  const deviceAdbBytes = (args, input) => execFileSync(process.env.ADB ?? "adb", [
    ...(guarded ? ["-H", "127.0.0.1", "-P", "5037"] : []), "-s", serial, ...args,
  ], { input, stdio: ["pipe", "pipe", "pipe"], timeout: args[0] === "push" ? 120000 : 30000, maxBuffer: 16 * 1024 * 1024 });
  const deviceAdb = (...args) => deviceAdbBytes(args).toString("utf8").trim();
  assert.equal(deviceAdb("shell", "getprop", "ro.kernel.qemu"), "1");
  const session = platform === "android-session" || guarded;
  if (session) assert.match(deviceAdb("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonSessionP0_[A-Za-z0-9]+$/);
  assert.equal(deviceAdb("shell", "getprop", "sys.boot_completed"), "1");
  if (hosted && requireNetwork) {
    assert.equal(deviceAdb("shell", "settings", "get", "global", "airplane_mode_on"), "0", "Disable airplane mode on the hosted AVD");
    assert.match(deviceAdb("shell", "dumpsys", "connectivity"), /Active default network:[ \t]*\d+/i);
  } else {
    assert.equal(deviceAdb("shell", "settings", "get", "global", "airplane_mode_on"), "1", "Enable airplane mode on the AVD");
    assert.match(deviceAdb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
  }
  function assertNoMappings() {
    assert.ok(!deviceAdb("forward", "--list").split(/\r?\n/).some(line => line.split(/\s+/)[0] === serial),
      "Require an AVD without ADB forwards");
    assert.equal(deviceAdb("reverse", "--list"), "", "Require an AVD without ADB reverse routes");
  }
  if (guarded) {
    assert.equal(deviceAdb("shell", "getprop", "ro.product.cpu.abi"), "x86_64");
    if (!hosted) assert.equal(deviceAdb("shell", "settings", "get", "global", "wifi_on"), "0", "Disable Wi-Fi on the AVD");
    assertNoMappings();
  }
  if (provider) assert.equal(deviceAdb("shell", "getprop", "ro.build.version.sdk"), "36");
  const variant = hosted ? "provider-hosted" : provider ? "provider-preflight" : session ? "session" : "fixture";
  const apk = join(nativeDir, ".run/klaxon-p0-x86_64-" + variant + ".apk");
  await access(apk);
  const exerciseInstalled = async () => {
    const withActivity = action => withAndroidActivity(deviceAdb, serial, appId, action);
    if (hosted) return hosted({ withActivity, adb: deviceAdb, adbBytes: deviceAdbBytes, appId });
    if (provider) {
      const { exerciseAndroidProviderPreflight } = await import("./local-provider/android-preflight.mjs");
      const { exerciseAndroidProviderSession, exerciseAndroidProviderAcceptance } =
        await import("./local-provider/android-session-preflight.mjs");
      const transport = await exerciseAndroidProviderPreflight(withActivity, deviceAdb, appId, { reconnect });
      const target = { withActivity, adb: deviceAdb, adbBytes: deviceAdbBytes, appId };
      const session = platform === "android-provider-preflight" ? await exerciseAndroidProviderSession(target) :
        await exerciseAndroidProviderAcceptance(target, { reconnect });
      return { transport, session };
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
  };
  let report;
  try { report = await withAndroidFixture(deviceAdb, apk, appId, exerciseInstalled); }
  finally { if (guarded) assertNoMappings(); }
  if (guarded) console.log("Android fixture package absent. ADB forwards and reverse routes are empty.");
  if (provider && !hosted) console.log(platform, report);
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (platform === "windows") await windows();
  else if (platform === "windows-session" || platform === "windows-sdk") await windowsSession(platform === "windows-sdk");
  else if (Object.hasOwn(windowsLoopbackCases, platform)) {
    assert.ok(platformArgument, "Pass the separately built Windows loopback fixture executable");
    await windowsSession(true, { ...windowsLoopbackCases[platform], exe: resolve(platformArgument) });
  } else if (platform === "android-provider-acceptance") {
    const { launchAndroidAcceptance } = await import("./local-provider/android-acceptance-worker.mjs");
    process.exitCode = launchAndroidAcceptance(process.argv.slice(2));
  } else if (["android", "android-session", "android-sdk", "android-provider-preflight"].includes(platform)) await android(platformArgument);
  else throw new Error("Choose windows, windows-session, windows-sdk, windows-sdk-signout-loopback, windows-sdk-refresh-loopback, android, android-session, android-sdk, android-provider-preflight or android-provider-acceptance. Android requires a disposable emulator serial.");
}
