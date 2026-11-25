// Optional P0-05 rehearsal on Windows with the installed desktop app.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const run = promisify(execFile);
const executablePath = process.argv[2];
assert(process.platform === "win32" && path.isAbsolute(executablePath ?? ""),
  "Pass the absolute path of the installed Obsidian.exe on Windows.");
assert.equal(path.basename(executablePath).toLowerCase(), "obsidian.exe");

const tempParent = path.resolve(tmpdir());
const root = await mkdtemp(path.join(tempParent, "klaxon-p0-obsidian-"));
const id = randomBytes(8).toString("hex");
const vault = path.join(root, "P0 " + id);
const profile = path.join(root, "profile");
const original = "Planning/First café note.md";
const renamed = "Planning/Renamed café note.md";
const content = "Synthetic Klaxon P0 note " + id;
const flags = [
  "--user-data-dir=" + profile, "--disable-background-networking",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost", "--disable-gpu",
];
const env = {};
for (const key of ["SystemRoot", "WINDIR", "PATH", "ComSpec", "PATHEXT", "SystemDrive"]) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  APPDATA: path.join(root, "roaming"), LOCALAPPDATA: path.join(root, "local"),
  USERPROFILE: path.join(root, "user"), TEMP: path.join(root, "temp"), TMP: path.join(root, "temp"),
});
let child, browser;
try {
  const directories = [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE, env.TEMP, profile,
    path.join(vault, ".obsidian"), path.join(vault, "Planning")];
  for (const dir of directories) await mkdir(dir, { recursive: true });
  await writeFile(path.join(profile, "obsidian.json"), JSON.stringify({
    updateDisabled: true, vaults: { [id]: { path: vault, ts: Date.now(), open: true } },
  }));
  await writeFile(path.join(vault, original), content);
  await writeFile(path.join(vault, "Other.md"), "Synthetic control note");
  child = spawn(executablePath, [...flags, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
    { env, windowsHide: true, stdio: "ignore" });
  await once(child, "spawn");
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, "Fixture exited before opening its window");
    try { endpoint = await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (endpoint?.includes("/devtools/browser/")) break;
    await delay(150);
  }
  const [port, wsPath] = (endpoint ?? "").trim().split(/\r?\n/);
  assert.match(port, /^\d+$/, "Fixture profile did not publish its debugger port");
  assert.match(wsPath, /^\/devtools\/browser\/[a-f0-9-]+$/i);
  browser = await chromium.connectOverCDP("ws://127.0.0.1:" + port + wsPath, { timeout: 5000 });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page", { timeout: 15000 });
  await page.waitForFunction(expected => window.app?.vault?.adapter?.getBasePath() === expected,
    vault, { timeout: 20000 });

  async function openNote(note) {
    const uri = "obsidian://open?vault=" + encodeURIComponent(id) + "&file=" + encodeURIComponent(note);
    // Address only this fixture instance. The OS-wide URI association is outside this rehearsal.
    await run(executablePath, [...flags, uri], { env, windowsHide: true, timeout: 10000 });
    await page.waitForFunction(expected => window.app.workspace.getActiveFile()?.path === expected,
      note, { timeout: 10000 });
  }
  await openNote("Other.md");
  await openNote(original);
  await page.evaluate(async ({ original, renamed }) => {
    await window.app.fileManager.renameFile(window.app.workspace.getActiveFile(), renamed);
    if (window.app.vault.getAbstractFileByPath(original)) throw Error("Old path still resolves");
  }, { original, renamed });
  await openNote("Other.md");
  await openNote(renamed);
  assert.equal(await readFile(path.join(vault, renamed), "utf8"), content);
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        // Observe termination errors before asking this fixture process to exit.
        await Promise.all([
          once(child, "close", { signal: AbortSignal.timeout(5000) }),
          Promise.resolve().then(() => child.kill()),
        ]);
      }
    } finally {
      assert.equal(path.dirname(root), tempParent);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}
console.log("PASS: desktop URI opened the selected note before and after manual rename reconciliation. Fixture removed.");
