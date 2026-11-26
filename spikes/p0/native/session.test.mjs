import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./session-fixture.ps1", import.meta.url));
const skip = process.platform !== "win32" && "requires Windows current-user DPAPI";
const markerPrefix = "KLAXON-P0-INERT/";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "klaxon-p0-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const slot = owner => join(directory, owner + ".bin");

  // Each invocation starts a new process. Only the DPAPI-protected files survive.
  function run(action, owner, expected, response = "grant", generation = 1) {
    const systemRoot = process.env.SystemRoot;
    const powershell = process.env.P0_SESSION_POWERSHELL ??
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawnSync(powershell, [
      "-NoProfile", "-NonInteractive", "-File", worker, basename(directory),
      action, owner, response, String(generation),
    ], {
      env: { SystemRoot: systemRoot, TEMP: tmpdir(), TMP: tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8", timeout: 15000, windowsHide: true,
    });
    if (child.error) throw child.error;
    assert.ok(!child.stdout.includes(markerPrefix) && !child.stderr.includes(markerPrefix),
      "worker output included a fixture marker");
    assert.equal(child.status, 0, `worker failed at ${action}`);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout.trim(), expected);
  }

  async function checkStore(...owners) {
    const files = (await readdir(directory)).sort();
    assert.deepEqual(files, owners.map(owner => owner + ".bin").sort());
    for (const file of files) {
      const bytes = await readFile(join(directory, file));
      assert.ok(bytes.length > 0);
      for (const encoding of ["utf8", "utf16le"]) {
        assert.ok(!bytes.includes(Buffer.from(markerPrefix, encoding)), "plaintext fixture marker on disk");
      }
    }
  }
  return { run, slot, checkStore };
}

test("cold process requires refresh, retries an outage, rotates and clears on expiry", { skip }, async t => {
  const { run, slot, checkStore } = await fixture(t);
  run("resume", "alpha", "sign-in-required");
  run("sign-in", "alpha", "stored");
  await checkStore("alpha");
  const before = await readFile(slot("alpha"));
  run("resume", "alpha", "retry-required", "unavailable");
  assert.ok(before.equals(await readFile(slot("alpha"))), "outage changed the stored record");
  run("resume", "alpha", "authenticated");
  await checkStore("alpha");
  // The simulated provider accepts only the rotated generation on this cold start.
  run("resume", "alpha", "authenticated", "grant", 2);
  run("resume", "alpha", "sign-in-required", "expired", 3);
  await checkStore();
  run("resume", "alpha", "sign-in-required");
});

test("logout survives relaunch and a different fixture owner cannot resume a copied record", { skip }, async t => {
  const { run, slot, checkStore } = await fixture(t);
  run("sign-in", "alpha", "stored");
  run("resume", "beta", "sign-in-required");
  const copied = await readFile(slot("alpha"));
  await writeFile(slot("beta"), copied);
  run("resume", "beta", "storage-unavailable");
  assert.ok(copied.equals(await readFile(slot("beta"))), "a protection failure discarded the record");
  run("resume", "alpha", "authenticated");
  run("sign-in", "beta", "stored");
  run("logout", "alpha", "signed-out");
  await checkStore("beta");
  run("resume", "alpha", "sign-in-required");
  run("resume", "beta", "authenticated");
  run("logout", "beta", "signed-out");
  await checkStore();
});

test("a replayed pre-rotation marker is rejected by the simulated provider after restart", { skip }, async t => {
  const { run, slot, checkStore } = await fixture(t);
  run("sign-in", "alpha", "stored");
  const stale = await readFile(slot("alpha"));
  run("resume", "alpha", "authenticated");
  await writeFile(slot("alpha"), stale);
  run("resume", "alpha", "sign-in-required", "grant", 2);
  await checkStore();
  run("resume", "alpha", "sign-in-required");
});
