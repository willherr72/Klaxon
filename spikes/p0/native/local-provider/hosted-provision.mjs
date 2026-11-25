import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { convexDevelopmentOriginPattern } from "../../build-policy.mjs";
import { androidAcceptanceEnv, providerWorkerEnvironmentIsClean } from "./android-acceptance-worker.mjs";

export function devKeyMatchesOrigin(key, origin) {
  if (!convexDevelopmentOriginPattern.test(origin)) return false;
  const [deployment, material, extra] = key.split("|");
  const label = new URL(origin).hostname.split(".")[0];
  return deployment === "dev:" + label && !!material && !/\s/.test(material) && extra === undefined;
}

async function provision() {
  assert.ok(providerWorkerEnvironmentIsClean());
  const { values: { origin, emulator, platform, "key-file": keyFile, "retire-receipt": retireReceipt } } = parseArgs({
    args: process.argv.slice(3),
    options: { origin: { type: "string" }, emulator: { type: "string" }, "key-file": { type: "string" },
      platform: { type: "string", default: "both" }, "retire-receipt": { type: "string" } },
  });
  assert.ok(convexDevelopmentOriginPattern.test(origin) && keyFile);
  assert.ok(["windows", "android", "both"].includes(platform));
  if (!retireReceipt && platform !== "windows") assert.match(emulator ?? "", /^emulator-\d+$/);
  const buffer = await readFile(keyFile);
  const key = buffer.toString("utf8").trim();
  buffer.fill(0);
  assert.ok(devKeyMatchesOrigin(key, origin));
  const admin = new ConvexHttpClient(origin, {
    logger: false,
    fetch: (url, options) => {
      if (new URL(url).origin !== origin) throw Error("Unexpected provisioning endpoint");
      return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20_000) });
    },
  });
  admin.setAdminAuth(key);
  async function retire(runId) {
    const result = await admin.function("authFixtures:retireDisposable", undefined, { runId });
    const fields = ["ownersRetired", "sessionsRevoked", "tasksDeleted", "usernamesDeleted", "usersDeleted",
      "passwordRowsRetained", "authUserIdRowsRetained"];
    assert.ok(fields.every(field => Number.isSafeInteger(result?.[field]) && result[field] >= 0));
    return Object.fromEntries(fields.map(field => [field, result[field]]));
  }
  try {
    if (retireReceipt) {
      const receiptPath = await realpath(retireReceipt);
      const directory = dirname(receiptPath);
      assert.ok(basename(receiptPath) === "retirement.json" &&
        /^klaxon-p0-hosted-[a-z0-9]{6}$/i.test(basename(directory)) && dirname(directory) === await realpath(tmpdir()));
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      assert.equal(receipt.origin, origin);
      assert.match(receipt.runId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      const result = await retire(receipt.runId);
      await unlink(receiptPath);
      await rmdir(directory);
      console.log("Hosted fixture retirement", result);
      return;
    }

    const runId = randomUUID();
    const directory = await mkdtemp(join(await realpath(tmpdir()), "klaxon-p0-hosted-"));
    const receipt = join(directory, "retirement.json");
    const credentials = join(directory, "fixture-accounts.json");
    await writeFile(receipt, JSON.stringify({ origin, runId }), { flag: "wx", mode: 0o600 });
    let enrolled = false;
    try {
      const accounts = {};
      for (const owner of ["a", "b"]) {
        accounts[owner] = { username: "p0-hosted-" + runId + "-" + owner, password: randomUUID() };
        enrolled = true;
        await admin.function("authFixtures:enrollDisposable", undefined, { runId, ...accounts[owner] });
      }
      await writeFile(credentials, JSON.stringify(accounts), { flag: "wx", mode: 0o600 });
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL("./hosted-run.mjs", import.meta.url)), "--origin", origin,
        "--platform", platform, ...(emulator ? ["--emulator", emulator] : []), "--accounts-file", credentials,
      ], { env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true });
      if (child.status !== 0) process.exitCode = 1;
    } finally {
      // Leave the nonsecret receipt available if a reply is lost or retirement fails.
      try {
        if (enrolled) console.log("Hosted fixture retirement", await retire(runId));
        await unlink(receipt);
      } catch {
        console.error("Hosted retirement unconfirmed. Retry with --retire-receipt", receipt);
        process.exitCode = 1;
      } finally {
        await unlink(credentials).catch(error => { if (error.code !== "ENOENT") throw error; });
        await rmdir(directory).catch(error => {
          if (error.code !== "ENOTEMPTY") throw error;
        });
      }
    }
  } finally {
    admin.clearAuth();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "--isolated-worker") {
    try { await provision(); }
    catch {
      console.error("Hosted fixture provisioning stopped.");
      process.exitCode = 1;
    }
  } else {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated-worker", ...process.argv.slice(2)],
      { env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true });
    process.exitCode = child.status ?? 1;
  }
}
