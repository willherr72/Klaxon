import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { convexDevelopmentOriginPattern } from "../../build-policy.mjs";
import { androidAcceptanceEnv, providerWorkerEnvironmentIsClean } from "./android-acceptance-worker.mjs";

async function runHostedWorker() {
  assert.ok(providerWorkerEnvironmentIsClean());
  const { values: { origin, emulator, platform, "accounts-file": accountsFile } } = parseArgs({
    args: process.argv.slice(3),
    options: { origin: { type: "string" }, emulator: { type: "string" }, "accounts-file": { type: "string" },
      platform: { type: "string", default: "both" } },
  });
  assert.ok(convexDevelopmentOriginPattern.test(origin), "Expected a plain HTTPS Convex deployment origin");
  assert.ok(["windows", "android", "both"].includes(platform));
  const windowsEnabled = platform !== "android";
  const androidEnabled = platform !== "windows";
  if (androidEnabled) assert.match(emulator ?? "", /^emulator-\d+$/, "Pass a disposable Android emulator serial");
  const { android, withWindowsHost } = await import("../smoke.mjs");
  const { hostedExecutable } = await import("./build.mjs");
  const { exerciseLocalProvider, verifyHostedPage } = await import("./check.mjs");
  const { withAndroidTarget } = await import("./android-session-preflight.mjs");

  async function withWindowsTarget(action, input) {
    const parent = await realpath(tmpdir());
    const root = await mkdtemp(join(parent, "klaxon-p0-session-"));
    const record = join(root, "packaged.bin");
    const profile = join(root, "webview");
    const capture = { runName: basename(root), hosts: new Set(), browsers: new Set() };
    const env = { TEMP: parent, TMP: parent };
    if (input) env.KLAXON_P0_LOCAL_OWNER_ID = input.owner;
    const launch = (check, extra = {}) =>
      withWindowsHost(hostedExecutable, profile, check, capture, { ...env, ...extra });
    try {
      await mkdir(profile);
      await launch(page => verifyHostedPage(page, origin));
      if (!input) return;
      const verifySlotCleared = async () => {
        for (const file of [record, join(root, "packaged.staged"), join(root, "packaged.signout-pending")]) {
          await assert.rejects(access(file), { code: "ENOENT" });
        }
      };
      let sessions = 0;
      const result = await action(async check => {
        const initial = sessions++ === 0;
        await launch(check, initial ? { KLAXON_P0_LOCAL_USER: input.username, KLAXON_P0_LOCAL_PASSWORD: input.password } : {});
        if (initial) {
          const sealed = await readFile(record);
          assert.ok(sealed.length > 0 && !sealed.includes(input.password));
        }
      }, verifySlotCleared);
      if (result.status !== "passed") console.error("Windows hosted observation", {
        status: result.status, stage: result.stage ?? "subscription result",
      });
      assert.equal(result.status, "passed");
      stage = "Windows hosted cold sign-out";
      await verifySlotCleared();
      await launch(async page => {
        await verifyHostedPage(page, origin);
        assert.deepEqual(await page.evaluate(async () => {
          async function denial(command, args) {
            try { await window.__TAURI__.core.invoke(command, args); }
            catch (status) { return status === "signed-out"; }
            return false;
          }
          return [
            await denial("local_resume"),
            await denial("local_access", { forceRefresh: false }),
          ];
        }), [true, true]);
      });
      assert.equal(sessions, 2);
      assert.equal(capture.hosts.size, 4);
      return { ...result, coldLogout: true, lifecycleProcesses: 3 };
    } finally {
      const stat = await lstat(root);
      assert.ok(dirname(root) === parent && stat.isDirectory() && !stat.isSymbolicLink() && await realpath(root) === root);
      await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
    }
  }

  let stage = "packaged origin attestation";
  try {
    const evidence = {};
    if (windowsEnabled) {
      await withWindowsTarget();
      evidence.windows = "origin-matched";
    }
    if (androidEnabled) {
      await android(emulator, target => target.withActivity(page => verifyHostedPage(page, origin)),
        { requireNetwork: !!accountsFile });
      evidence.android = "origin-matched";
    }
    if (!accountsFile) return evidence;

    stage = "private fixture input";
    const { withHostedProviderScenario } = await import("./hosted-controls.mjs");
    const bytes = await readFile(accountsFile);
    let accounts;
    try { accounts = JSON.parse(bytes.toString("utf8")); }
    finally { bytes.fill(0); }
    stage = "hosted fixture lifecycle or cleanup";
    return await withHostedProviderScenario(origin, accounts, async ({ input, ...controls }) => {
      const run = (launch, verifySlotCleared, titles) => exerciseLocalProvider({
        ...controls, ...titles, launch, verifySlotCleared, origin, hostedReconnect: true,
      });
      if (windowsEnabled) {
        stage = "Windows hosted lifecycle";
        evidence.windows = await withWindowsTarget((launch, verifySlotCleared) => run(launch, verifySlotCleared), input);
        console.log("Windows hosted lifecycle passed");
      }
      if (androidEnabled) {
        stage = "Android hosted lifecycle";
        evidence.android = await android(emulator, target => withAndroidTarget(target, input,
          (launch, verifySlotCleared) => run(launch, verifySlotCleared, windowsEnabled ? {
            title: controls.updatedTitle, updatedTitle: controls.title,
          } : undefined), origin));
      }
      return evidence;
    });
  } catch (error) {
    // Playwright and SDK exceptions can contain evaluation arguments and provider responses.
    const cleanup = error.fixtureCleanup;
    if (cleanup) console.error("Scoped hosted cleanup", cleanup);
    if (error.fixtureStage) console.error("Hosted control stage", error.fixtureStage);
    if (error.failureLocation?.length) console.error("Hosted fixture location", error.failureLocation.join(", "));
    if (error.fixtureRevocation) console.error("Hosted control revocation", error.fixtureRevocation);
    throw Error("Hosted native fixture failed during " + stage);
  }
}

if (process.argv[2] === "--isolated-worker") {
  try { console.log("Hosted native fixture evidence", await runHostedWorker()); }
  catch (error) {
    // Only errors deliberately raised by this module are safe to emit.
    console.error(error.message.startsWith("Hosted native fixture failed during ") ?
      error.message : "Invalid hosted native fixture configuration.");
    process.exitCode = 1;
  }
} else {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated-worker", ...process.argv.slice(2)], {
    env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true,
  });
  process.exitCode = child.status ?? 1;
}
