import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const prefix = "klaxon-p0-obsidian-";

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function waitForExit(closed) {
  return Promise.race([closed.then(() => true), delay(15000, false, { ref: false })]);
}

async function readRegistry(profile) {
  try {
    return JSON.parse(await readFile(path.join(profile, "obsidian.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {};
  }
}

async function selectVault(profile, { id, path: vaultPath }) {
  const registry = await readRegistry(profile);
  const vaults = Object.entries(registry.vaults ?? {}).map(([key, entry]) => [key,
    entry.open ? { ...entry, open: false } : entry]);
  const selected = Object.hasOwn(registry.vaults ?? {}, id) ? registry.vaults[id] : {};
  assert.equal(selected.path ?? vaultPath, vaultPath, "Fixture vault ID already belongs to another path");
  await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({
    ...registry,
    updateDisabled: true,
    vaults: Object.fromEntries([...vaults, [id, { ...selected, path: vaultPath, ts: Date.now(), open: true }]]),
  }));
}

async function debuggerEndpoint(child, endpointFile) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.ok(isRunning(child), "Fixture exited before opening its window");
    let endpoint;
    try {
      endpoint = await readFile(endpointFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const match = /^(\d+)\r?\n(\/devtools\/browser\/[a-f0-9-]+)$/i.exec(endpoint?.trim() ?? "");
    if (match) return "ws://127.0.0.1:" + match[1] + match[2];
    await delay(150);
  }
  throw new Error("Fixture profile did not publish its debugger port");
}

// Call withVault sequentially with synthetic vault directories created directly under root.
export async function withDisposableObsidian(executablePath, action) {
  assert(process.platform === "win32" && path.isAbsolute(executablePath ?? ""),
    "Pass the absolute path of the installed Obsidian.exe on Windows.");
  assert.equal(path.basename(executablePath).toLowerCase(), "obsidian.exe");

  const tempParent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(tempParent, prefix));
  const profile = path.join(root, "profile");
  const environment = path.join(root, "environment");
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "PATH", "ComSpec", "PATHEXT", "SystemDrive"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    APPDATA: path.join(environment, "roaming"),
    LOCALAPPDATA: path.join(environment, "local"),
    USERPROFILE: path.join(environment, "user"),
    TEMP: path.join(environment, "temp"),
    TMP: path.join(environment, "temp"),
  });
  const flags = [
    "--user-data-dir=" + profile, "--disable-background-networking",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", "--disable-gpu",
  ];
  const options = { env, windowsHide: true };
  let activeVault;
  let closing = false;

  async function runVault(vault, callback) {
    const { id, path: vaultPath } = vault;
    assert.ok(typeof id === "string" && id.length > 0, "A fixture vault ID is required");
    assert.equal(path.dirname(vaultPath), root, "Fixture vault must be directly inside the disposable root");
    assert.ok((await lstat(vaultPath)).isDirectory(), "Fixture vault must be a real directory");
    assert.equal(await realpath(vaultPath), vaultPath, "Fixture vault path must be canonical");
    assert.ok(![profile, environment].includes(vaultPath), "Fixture vault must be separate from app data");
    await selectVault(profile, vault);
    const endpointFile = path.join(profile, "DevToolsActivePort");
    await rm(endpointFile, { force: true });

    const child = spawn(executablePath, [...flags, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      { ...options, stdio: "ignore" });
    const closed = new Promise(resolve => child.once("close", resolve));
    let browser, page;
    try {
      await once(child, "spawn");
      const endpoint = await debuggerEndpoint(child, endpointFile);
      browser = await chromium.connectOverCDP(endpoint, { timeout: 5000 });
      const context = browser.contexts()[0];
      page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
      await page.waitForFunction(expected => window.app?.workspace?.layoutReady &&
        window.app?.vault?.adapter?.getBasePath() === expected, vaultPath, { timeout: 20000 });

      async function openNote(note) {
        assert.ok(isRunning(child) && !page.isClosed(), "Fixture window is closed");
        const uri = "obsidian://open?vault=" + encodeURIComponent(id) + "&file=" + encodeURIComponent(note);
        // Deliver the URI to the running fixture with the same profile and environment.
        await run(executablePath, [...flags, uri], { ...options, timeout: 10000 });
        await page.waitForFunction(expected => window.app.workspace.getActiveFile()?.path === expected,
          note, { timeout: 10000 });
      }

      return await callback(page, openNote);
    } finally {
      try {
        try {
          if (child.pid && isRunning(child) && browser?.isConnected()) {
            // Quit the fixture browser process, including any background windows.
            const session = await browser.newBrowserCDPSession();
            void session.send("Browser.close").catch(() => {});
            await waitForExit(closed);
          }
        } finally {
          if (child.pid && isRunning(child)) child.kill();
          assert.ok(await waitForExit(closed), "Fixture process did not exit");
        }
      } finally {
        if (browser) await browser.close();
      }
    }
  }

  function withVault(vault, callback) {
    assert.ok(!closing && !activeVault, "Fixture vault launches must be sequential and inside the disposable host");
    activeVault = runVault(vault, callback).finally(() => { activeVault = undefined; });
    return activeVault;
  }

  try {
    for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, env.TEMP, profile]) {
      await mkdir(dir, { recursive: true });
    }
    return await action({ root, profile, withVault });
  } finally {
    closing = true;
    try {
      await activeVault;
    } finally {
      assert.equal(path.dirname(root), tempParent);
      assert.ok(path.basename(root).startsWith(prefix));
      assert.equal(await realpath(root), root);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}
