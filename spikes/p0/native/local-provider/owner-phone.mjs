import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { convexDevelopmentOriginPattern } from "../../build-policy.mjs";
import { withAndroidFixture } from "../android-install.mjs";
import { androidAcceptanceEnv, providerWorkerEnvironmentIsClean } from "./android-acceptance-worker.mjs";

const appId = "dev.klaxon.p0native";
const apk = fileURLToPath(new URL("../.run/klaxon-p0-arm64-provider-hosted.apk", import.meta.url));
const phoneSerial = /^(?!emulator-)[a-z0-9][a-z0-9_-]{2,63}$/i;

function runAdb(args, input) {
  return execFileSync(process.env.ADB ?? "adb", ["-H", "127.0.0.1", "-P", "5037", ...args], {
    input, stdio: ["pipe", "pipe", "pipe"], timeout: args.includes("push") ? 120000 : 30000, maxBuffer: 16 * 1024 * 1024,
  });
}

export function admitOwnerPhone(serial, command = runAdb) {
  assert.match(serial ?? "", phoneSerial, "Expected an explicitly selected physical phone serial");
  const read = (...args) => command(args).toString("utf8").trim();
  assert.ok(read("-d", "get-serialno") === serial, "Expected the selected USB phone");
  const matched = read("devices", "-l").split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(tokens => tokens[0] === serial);
  assert.ok(matched.length === 1 && matched[0][1] === "device", "Expected one authorized phone transport");
  const transport = matched[0].filter(token => /^transport_id:[1-9]\d*$/.test(token));
  assert.equal(transport.length, 1, "Expected one phone transport identifier");
  const target = ["-t", transport[0].slice("transport_id:".length)];
  const adbBytes = (args, input) => {
    assert.ok(read(...target, "get-serialno") === serial, "ADB phone transport changed");
    return command([...target, ...args], input);
  };
  const adb = (...args) => adbBytes(args).toString("utf8").trim();
  const prop = key => adb("shell", "getprop", key);
  for (const key of ["ro.kernel.qemu", "ro.boot.qemu"]) {
    assert.ok(["", "0"].includes(prop(key)), "Expected physical Android");
  }
  assert.equal(prop("sys.boot_completed"), "1");
  assert.equal(prop("ro.product.cpu.abi"), "arm64-v8a");
  const sdk = prop("ro.build.version.sdk");
  assert.ok(/^\d{2,3}$/.test(sdk) && Number(sdk) >= 24, "Android API level below the fixture minimum");
  assert.equal(adb("shell", "am", "get-current-user"), "0", "Expected Android user zero");
  assert.equal(adb("shell", "am", "get-started-user-state", "0"), "RUNNING_UNLOCKED", "Expected an unlocked Android user");
  function assertNoMappings() {
    const forwards = adb("forward", "--list").split(/\r?\n/);
    assert.ok(!forwards.some(line => line.trim().split(/\s+/)[0] === serial), "Expected no ADB forwards for the phone");
    assert.equal(adb("reverse", "--list"), "", "Expected no ADB reverse routes for the phone");
  }
  assertNoMappings();
  const users = adb("shell", "pm", "list", "users").split(/\r?\n/);
  assert.equal(users.shift(), "Users:");
  const ids = users.map(line => /^\s*UserInfo\{(\d+):/.exec(line)?.[1]);
  assert.ok(ids.includes("0") && ids.every(Boolean) && new Set(ids).size === ids.length, "Could not verify Android users");
  for (const id of ids) {
    assert.equal(adb("shell", "pm", "list", "packages", "-u", "--user", id, appId), "",
      "Expected no prior P0 fixture package");
  }
  return { adb, adbBytes, api: Number(sdk), assertNoMappings };
}

async function verifyArm64Apk(file, expectedHash) {
  assert.match(expectedHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), expectedHash);
  const tools = join(process.env.ANDROID_HOME, "build-tools", "36.0.0");
  const run = (command, args) => execFileSync(command, args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  });
  const badging = run(join(tools, "aapt.exe"), ["dump", "badging", file]);
  assert.match(badging, /^package: name='dev\.klaxon\.p0native' /m);
  assert.match(badging, /^application-debuggable\r?$/m);
  assert.match(badging, /^native-code: 'arm64-v8a'\r?$/m);
  const manifest = run(join(tools, "aapt.exe"), ["dump", "xmltree", file, "AndroidManifest.xml"]);
  assert.ok(/^\s*A: android:allowBackup\([^)]+\)=\(type 0x12\)0x0\r?$/m.test(manifest),
    "Require Android backup disabled for the phone fixture");
  const certs = run(join(process.env.JAVA_HOME, "bin", "java.exe"), [
    "-jar", join(tools, "lib", "apksigner.jar"), "verify", "--verbose", "--print-certs", file,
  ]);
  assert.match(certs, /^Number of signers: 1\r?$/m);
  assert.match(certs, /^Signer #1 certificate DN: .*\bCN=Android Debug\r?$/m);
  assert.match(certs, /^Verified using v2 scheme \(APK Signature Scheme v2\): true\r?$/m);
}

export async function withOwnerPhone({ serial, apkSha256 }, action, {
  runAdb: command = runAdb, verifyApk = verifyArm64Apk, apkPath = apk,
} = {}) {
  await verifyApk(apkPath, apkSha256);
  const { adb, adbBytes, api, assertNoMappings } = admitOwnerPhone(serial, command);
  let fixtureError;
  try {
    return await withAndroidFixture(adb, apkPath, appId, async () => {
      const { withAndroidActivity } = await import("../smoke.mjs");
      const withActivity = check => withAndroidActivity(adb, serial, appId, check, { primaryUser: true });
      return action({ withActivity, adb, adbBytes, appId, api });
    }, { apkSha256 });
  } catch (error) {
    fixtureError = error;
    throw error;
  } finally {
    try { assertNoMappings(); }
    catch (error) {
      throw Object.assign(new AggregateError(fixtureError ? [fixtureError, error] : [error],
        "Phone ADB mapping cleanup unconfirmed"), { code: "P0_PHONE_ADB_CLEANUP" });
    }
  }
}

function hasValidatedPhoneNetwork(snapshot) {
  const defaults = [...snapshot.matchAll(/^[ \t]*Active default network: ([1-9]\d*)[ \t]*\r?$/gm)];
  if (defaults.length !== 1) return false;
  const current = snapshot.split(/\r?\n[ \t]*\r?\n/)
    .find(section => /^[ \t]*Current Networks:[ \t]*\r?$/m.test(section));
  const entries = current?.split(/\r?\n/).filter(row => /^[ \t]*NetworkAgentInfo\{/.test(row) &&
    row.includes("network{" + defaults[0][1] + "}"));
  if (entries?.length !== 1) return false;
  const network = / nc\{\[[ \t]*Transports: (WIFI|CELLULAR) Capabilities: ([A-Z0-9_&]+)/.exec(entries[0]);
  if (!network) return false;
  const capabilities = network[2].split("&");
  return ["INTERNET", "NOT_VPN", "VALIDATED"].every(capability => capabilities.includes(capability)) &&
    !capabilities.includes("CAPTIVE_PORTAL");
}

export async function runOwnerPhoneFixture(config, {
  withPhone = withOwnerPhone, verifyPage, withAccounts, withScenario, withTarget, exerciseProvider,
} = {}) {
  verifyPage ??= (await import("./check.mjs")).verifyHostedPage;
  const { origin, keyFile } = config;
  let retirementReceipt;
  let retirementProgressUnconfirmed;
  try {
    return await withPhone(config, async target => {
      await target.withActivity(page => verifyPage(page, origin, { requireRetirableProbe: !!keyFile }));
      const attested = { api: target.api, originAttested: true };
      if (!keyFile) return attested;

      assert.ok(hasValidatedPhoneNetwork(target.adb("shell", "dumpsys", "connectivity", "--short")),
        "Expected a validated Wi-Fi or cellular phone network before enrollment");
      withAccounts ??= (await import("./hosted-provision.mjs")).withHostedFixtureAccounts;
      withScenario ??= (await import("./hosted-controls.mjs")).withHostedProviderScenario;
      withTarget ??= (await import("./android-session-preflight.mjs")).withAndroidTarget;
      exerciseProvider ??= (await import("./check.mjs")).exerciseLocalProvider;
      try {
        const { evidence, retirement } = await withAccounts({ origin, keyFile }, accounts =>
          withScenario(origin, accounts, ({ input, ...controls }) =>
            withTarget({ ...target, primaryUser: true }, input, (launch, verifySlotCleared) => exerciseProvider({
              ...controls, launch, verifySlotCleared, origin, hostedReconnect: true,
            }), origin)));
        assert.ok(evidence.status === "passed" && evidence.appProcesses === 3 &&
          evidence.inputConsumed && evidence.coldLogout, "Hosted phone lifecycle incomplete");
        assert.ok(evidence.fixtureCleanup.knownControlSessions === 3 &&
          evidence.fixtureCleanup.controlSessionsRevoked === 3, "Hosted control retirement incomplete");
        assert.ok(retirement.ownersRetired === 2 && retirement.tasksDeleted === 1 &&
          retirement.usernamesDeleted === 2 && retirement.usersDeleted === 2, "Hosted fixture retirement counts do not match");
        return { ...attested, hosted: evidence, retirement };
      } catch (error) {
        retirementReceipt = error?.retirementReceipt;
        retirementProgressUnconfirmed = error?.retirementProgressUnconfirmed;
        throw error;
      }
    });
  } catch (error) {
    // A later device cleanup failure must not hide the remote retirement retry.
    if (retirementReceipt && error?.retirementReceipt !== retirementReceipt) {
      throw Object.assign(new Error("Hosted fixture retirement also unconfirmed", { cause: error }),
        { retirementReceipt, retirementProgressUnconfirmed, code: error?.code });
    }
    throw error;
  }
}

async function run() {
  let config;
  try {
    assert.ok(providerWorkerEnvironmentIsClean());
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: { serial: { type: "string" }, origin: { type: "string" },
        "apk-sha256": { type: "string" }, "owner-approved": { type: "boolean" },
        "owner-approved-hosted": { type: "boolean" }, "key-file": { type: "string" } },
    });
    assert.ok(values["owner-approved"] && phoneSerial.test(values.serial ?? "") &&
      convexDevelopmentOriginPattern.test(values.origin) && /^[0-9a-f]{64}$/.test(values["apk-sha256"] ?? ""));
    const keyFile = values["key-file"];
    assert.equal(!!values["owner-approved-hosted"], keyFile !== undefined);
    if (keyFile !== undefined) assert.ok(keyFile.trim());
    config = { serial: values.serial, origin: values.origin, apkSha256: values["apk-sha256"], keyFile };
  } catch {
    console.error("Invalid owner phone fixture configuration.");
    process.exitCode = 1;
    return;
  }
  try {
    const evidence = await runOwnerPhoneFixture(config);
    if (config.keyFile) {
      console.log("ARM64 phone fixture removed and scoped ADB mappings absent.", evidence);
    } else {
      console.log("ARM64 phone origin attestation passed. Fixture removed and scoped ADB mappings absent. Android API", evidence.api);
    }
  } catch (error) {
    if (error?.retirementReceipt) {
      console.error("Hosted retirement unconfirmed. Retry with --retire-receipt", error.retirementReceipt);
      if (error.retirementProgressUnconfirmed) console.error("Expected cleanup counts could not be saved. Verify counts on recovery.");
    }
    if (error?.code === "P0_PHONE_ADB_CLEANUP") {
      console.error("Phone ADB mapping cleanup unconfirmed. Inspect the selected phone's scoped forwards and install receipt before retrying.");
    } else {
      console.error("Phone fixture stopped during admission, attestation, lifecycle or cleanup. Inspect any remaining scoped install receipt before retrying.");
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === "--isolated-worker") {
    await run();
  } else {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--isolated-worker", ...process.argv.slice(2)],
      { env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true });
    process.exitCode = child.status ?? 1;
  }
}
