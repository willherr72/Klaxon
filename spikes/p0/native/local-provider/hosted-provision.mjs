import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
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

function createHostedAdminClient(origin) {
  return new ConvexHttpClient(origin, {
    logger: false,
    fetch: async (url, options) => {
      if (new URL(url).origin !== origin) throw Error("Unexpected provisioning endpoint");
      const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(20_000) });
      if (response.status !== 200) throw Error("Expected a definitive hosted provisioning response");
      return response;
    },
  });
}

async function withHostedAdmin({ origin, keyFile }, action, createAdminClient = createHostedAdminClient) {
  if (!convexDevelopmentOriginPattern.test(origin) || !keyFile) {
    throw Error("Hosted fixture provisioning requires a development origin and key file.");
  }
  let key;
  try {
    const buffer = await readFile(keyFile);
    try { key = buffer.toString("utf8").trim(); }
    finally { buffer.fill(0); }
  } catch {
    throw Error("Hosted fixture development key could not be read.");
  }
  if (!devKeyMatchesOrigin(key, origin)) throw Error("Hosted fixture development key does not match the origin.");

  let admin;
  try {
    try {
      admin = createAdminClient(origin);
      admin.setAdminAuth(key);
    } catch {
      throw Error("Hosted fixture provisioning authorization failed.");
    } finally {
      key = undefined;
    }
    return await action(admin);
  } finally {
    admin?.clearAuth();
  }
}

async function writeRetirementReceipt(origin, runId, tempRoot) {
  let directory;
  let receiptPath;
  try {
    directory = await mkdtemp(join(await realpath(tempRoot), "klaxon-p0-hosted-"));
    receiptPath = join(directory, "retirement.json");
    await writeFile(receiptPath, JSON.stringify({ origin, runId }), { flag: "wx", mode: 0o600 });
    return receiptPath;
  } catch {
    if (receiptPath) await unlink(receiptPath).catch(() => {});
    if (directory) await rmdir(directory).catch(() => {});
    throw Error("Hosted fixture retirement receipt could not be written.");
  }
}

function validRetirementExpectation(expected) {
  return expected && Number.isInteger(expected.minOwners) && expected.minOwners >= 0 &&
    expected.minOwners <= 2 && typeof expected.complete === "boolean" &&
    (!expected.complete || expected.minOwners === 2);
}

async function confirmRetirement(admin, runId, retirementReceipt, expected) {
  const fields = ["ownersRetired", "sessionsRevoked", "tasksDeleted", "usernamesDeleted", "usersDeleted",
    "passwordRowsRetained", "authUserIdRowsRetained"];
  let retirement;
  try {
    const result = await admin.function("authFixtures:retireDisposable", undefined, { runId });
    assert.ok(fields.every(field => Number.isSafeInteger(result?.[field]) && result[field] >= 0));
    const owners = result.ownersRetired;
    assert.ok(owners >= (expected?.minOwners ?? 0) && owners <= 2 && result.usersDeleted <= owners &&
      result.usernamesDeleted <= owners && result.tasksDeleted <= 16 * owners && result.sessionsRevoked <= 100 * owners &&
      result.passwordRowsRetained === owners && result.authUserIdRowsRetained === owners);
    if (expected?.complete) {
      assert.ok(result.tasksDeleted === 1 && result.usersDeleted === owners && result.usernamesDeleted === owners);
    }
    retirement = Object.fromEntries(fields.map(field => [field, result[field]]));
  } catch {
    // Keep the receipt so the operator can retry even if the reply was lost.
    throw Object.assign(Error("Hosted retirement unconfirmed. Retry with --retire-receipt."), { retirementReceipt });
  }
  try {
    await unlink(retirementReceipt);
    await rmdir(dirname(retirementReceipt));
  } catch {
    throw Error("Hosted fixture retirement confirmed. Local receipt cleanup failed.");
  }
  return retirement;
}

async function saveRetirementProgress(receipt, origin, runId, expected) {
  const pending = receipt + ".next";
  await writeFile(pending, JSON.stringify({ origin, runId, expected }), { flag: "wx", mode: 0o600 });
  try { await rename(pending, receipt); }
  finally { await unlink(pending).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

async function withProvisionedAccounts(options, action, {
  createAdminClient, tempRoot = tmpdir(), requireCompleteRetirement = false,
} = {}) {
  return withHostedAdmin(options, async admin => {
    const runId = randomUUID();
    const accounts = Object.fromEntries(["a", "b"].map(owner => [owner, {
      username: `p0-hosted-${runId}-${owner}`, password: randomUUID(),
    }]));
    const receipt = await writeRetirementReceipt(options.origin, runId, tempRoot);
    const owners = new Set();
    let completed = false;
    let evidence;
    let retirement;
    try {
      try {
        for (const account of Object.values(accounts)) {
          const owner = await admin.function("authFixtures:enrollDisposable", undefined, { runId, ...account });
          assert.ok(typeof owner === "string" && owner.length > 0 && owner.trim() === owner && !owners.has(owner));
          owners.add(owner);
          account.owner = owner;
        }
      } catch {
        throw Error("Hosted fixture enrollment failed.");
      }
      evidence = await action(accounts, dirname(receipt));
      completed = true;
    } finally {
      const expected = { minOwners: owners.size, complete: completed && requireCompleteRetirement };
      // A local receipt update failure must not prevent the scoped remote retirement attempt.
      let progressSaved = false;
      try {
        await saveRetirementProgress(receipt, options.origin, runId, expected);
        progressSaved = true;
      } catch {}
      try {
        retirement = await confirmRetirement(admin, runId, receipt, expected);
      } catch (error) {
        if (error?.retirementReceipt && !progressSaved) error.retirementProgressUnconfirmed = true;
        throw error;
      }
    }
    return { evidence, retirement };
  }, createAdminClient);
}

export function withHostedFixtureAccounts(options, action, dependencies) {
  return withProvisionedAccounts(options, accounts => action(accounts), { ...dependencies, requireCompleteRetirement: true });
}

export async function retryHostedFixtureRetirement({ origin, keyFile, retirementReceipt }, {
  createAdminClient, tempRoot = tmpdir(),
} = {}) {
  const receiptPath = await realpath(retirementReceipt);
  const directory = dirname(receiptPath);
  assert.ok(basename(receiptPath) === "retirement.json" &&
    /^klaxon-p0-hosted-[a-z0-9]{6}$/i.test(basename(directory)) && dirname(directory) === await realpath(tempRoot));
  const { origin: receiptOrigin, runId, expected } = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receiptOrigin, origin);
  assert.match(runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(expected === undefined || validRetirementExpectation(expected), "Invalid retirement progress");
  return await withHostedAdmin({ origin, keyFile },
    admin => confirmRetirement(admin, runId, receiptPath, expected), createAdminClient);
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

  const options = { origin, keyFile };
  if (retireReceipt) {
    const retirement = await retryHostedFixtureRetirement({ ...options, retirementReceipt: retireReceipt });
    console.log("Hosted fixture retirement", retirement);
    return;
  }

  const { retirement } = await withProvisionedAccounts(options, async (accounts, directory) => {
    const credentials = join(directory, "fixture-accounts.json");
    try {
      await writeFile(credentials, JSON.stringify(accounts), { flag: "wx", mode: 0o600 });
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL("./hosted-run.mjs", import.meta.url)), "--origin", origin,
        "--platform", platform, ...(emulator ? ["--emulator", emulator] : []), "--accounts-file", credentials,
      ], { env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true });
      if (child.status !== 0) process.exitCode = 1;
    } finally {
      await unlink(credentials).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  });
  console.log("Hosted fixture retirement", retirement);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "--isolated-worker") {
    try { await provision(); }
    catch (error) {
      if (error?.retirementReceipt) {
        console.error("Hosted retirement unconfirmed. Retry with --retire-receipt", error.retirementReceipt);
        if (error.retirementProgressUnconfirmed) console.error("Expected cleanup counts could not be saved. Verify counts on recovery.");
      } else {
        console.error("Hosted fixture provisioning stopped.");
      }
      process.exitCode = 1;
    }
  } else {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated-worker", ...process.argv.slice(2)],
      { env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true });
    process.exitCode = child.status ?? 1;
  }
}
