import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { admitOwnerPhone, runOwnerPhoneFixture, withOwnerPhone } from "./owner-phone.mjs";

const serial = "SyntheticPhone01";
const appId = "dev.klaxon.p0native";
const origin = "https://fixture.convex.cloud";
const apkSha256 = "a".repeat(64);
const args = ["--serial", serial, "--origin", origin, "--apk-sha256", apkSha256];
const entry = fileURLToPath(new URL("./owner-phone.mjs", import.meta.url));

function fakeAdb(overrides = {}) {
  const calls = [];
  const responses = {
    "-d get-serialno": serial,
    "devices -l": "List of devices attached\n" + serial + " device transport_id:42\nother-phone device transport_id:43",
    "get-serialno": serial,
    "shell getprop ro.kernel.qemu": "",
    "shell getprop ro.boot.qemu": "0",
    "shell getprop sys.boot_completed": "1",
    "shell getprop ro.product.cpu.abi": "arm64-v8a",
    "shell getprop ro.build.version.sdk": "36",
    "shell am get-current-user": "0",
    "shell am get-started-user-state 0": "RUNNING_UNLOCKED",
    "forward --list": "other-phone tcp:41002 localabstract:other",
    "reverse --list": "",
    "shell pm list users": "Users:\n\tUserInfo{0:Owner:13} running\n\tUserInfo{10:Profile:30}",
    ["shell pm list packages -u --user 0 " + appId]: "",
    ["shell pm list packages -u --user 10 " + appId]: "",
    ...overrides,
  };
  return { calls, runAdb(argv) {
    calls.push(argv);
    const query = argv[0] === "-t" ? argv.slice(2).join(" ") : argv.join(" ");
    assert.ok(Object.hasOwn(responses, query), "Unexpected ADB operation");
    const answer = responses[query];
    return Buffer.from(typeof answer === "function" ? answer() : answer);
  } };
}

test("the phone CLI requires explicit approval and a valid serial, origin and hash", () => {
  for (const cli of [
    args, [...args, "--owner-approved", "--accounts-file", "missing"],
    [...args, "--owner-approved", "--key-file", "missing"],
    [...args, "--owner-approved", "--owner-approved-hosted"],
    [...args, "--owner-approved", "--owner-approved-hosted", "--key-file", "  "],
    [...args, "--owner-approved-hosted", "--key-file", "missing"],
    [...args.slice(0, -1), "bad-hash", "--owner-approved"],
    ["--serial", "emulator-5554", ...args.slice(2), "--owner-approved"],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...cli], {
      encoding: "utf8", env: { ...process.env, ADB: "unexpected-adb", DEBUG: "pw:protocol" }, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Invalid owner phone fixture configuration\./);
  }
});

const wifiNetwork = "Active default network: 12\n\nCurrent Networks:\n" +
  "  NetworkAgentInfo{ network{12} nc{[ Transports: WIFI Capabilities: INTERNET&NOT_VPN&VALIDATED]} }";

function fakeLifecycle({ attestationError, network = wifiNetwork, retirementError, packageError,
  retiredTasks = 1, revokedControls = 3,
} = {}) {
  const steps = [];
  const keyFile = "private-fixture-test";
  const accounts = { a: { username: "owner-a", password: "synthetic-a" },
    b: { username: "owner-b", password: "synthetic-b" } };
  const input = { ...accounts.a, owner: "fixture-owner" };
  const controls = { control: {}, stranger: {}, taskId: "synthetic-task", title: "before", updatedTitle: "after" };
  const evidence = { status: "passed", appProcesses: 3, inputConsumed: true, coldLogout: true,
    fixtureCleanup: { knownControlSessions: 3, controlSessionsRevoked: revokedControls } };
  const retirement = { ownersRetired: 2, sessionsRevoked: 0, tasksDeleted: retiredTasks, usernamesDeleted: 2, usersDeleted: 2,
    passwordRowsRetained: 2, authUserIdRowsRetained: 2 };
  const target = {
    api: 36, withActivity: check => check("selected fixture page"),
    adb(...command) {
      steps.push("device network");
      assert.deepEqual(command, ["shell", "dumpsys", "connectivity", "--short"]);
      return network;
    },
  };
  const config = { serial, apkSha256, origin, keyFile };
  const services = {
    async withPhone({ serial: selected, apkSha256: hash }, check) {
      assert.equal(selected, serial);
      assert.equal(hash, apkSha256);
      steps.push("owned install ready");
      try { return await check(target); }
      finally {
        steps.push("device cleanup");
        if (packageError) throw packageError;
      }
    },
    async verifyPage(page, expectedOrigin, { requireRetirableProbe }) {
      assert.equal(page, "selected fixture page");
      assert.equal(expectedOrigin, origin);
      steps.push(requireRetirableProbe ? "origin and cleanup probe attestation" : "origin attestation");
      if (attestationError) throw attestationError;
    },
    async withAccounts(options, action) {
      assert.deepEqual(options, { origin, keyFile });
      steps.push("hosted enrollment");
      const result = await action(accounts);
      steps.push("hosted retirement");
      if (retirementError) throw retirementError;
      return { evidence: result, retirement };
    },
    async withScenario(expectedOrigin, actualAccounts, action) {
      assert.equal(expectedOrigin, origin);
      assert.equal(actualAccounts, accounts);
      steps.push("two owner controls");
      return action({ input, ...controls });
    },
    async withTarget(device, credentials, exercise, expectedOrigin) {
      assert.equal(device.withActivity, target.withActivity);
      assert.equal(device.primaryUser, true);
      assert.equal(credentials, input);
      assert.equal(expectedOrigin, origin);
      steps.push("native lifecycle");
      return exercise("Android launch", "protected-slot check");
    },
    async exerciseProvider(options) {
      assert.deepEqual(options, { launch: "Android launch", verifySlotCleared: "protected-slot check", ...controls,
        origin, hostedReconnect: true });
      steps.push("hosted exercise");
      return evidence;
    },
  };
  return { steps, config, evidence, retirement, services };
}

test("origin attestation and phone networking precede enrollment in the same verified install", async () => {
  const { services, config, evidence, retirement, steps } = fakeLifecycle();
  const result = await runOwnerPhoneFixture(config, services);
  assert.deepEqual(result, { api: 36, originAttested: true, hosted: evidence, retirement });
  assert.deepEqual(steps, ["owned install ready", "origin and cleanup probe attestation", "device network", "hosted enrollment",
    "two owner controls", "native lifecycle", "hosted exercise", "hosted retirement", "device cleanup"]);
});

test("account-free mode and failed origin or network evidence never reach enrollment", async () => {
  const defaultMode = fakeLifecycle();
  const { keyFile, ...config } = defaultMode.config;
  assert.ok(keyFile);
  assert.deepEqual(await runOwnerPhoneFixture(config, defaultMode.services), { api: 36, originAttested: true });
  assert.deepEqual(defaultMode.steps, ["owned install ready", "origin attestation", "device cleanup"]);
  for (const failure of [
    { attestationError: Error("origin mismatch") },
    { network: "Active default network: none" },
    { network: wifiNetwork.replace("Transports: WIFI", "Transports: WIFI|VPN") },
    { network: wifiNetwork.replace("Transports: WIFI", "Transports: USB") },
    { network: wifiNetwork.replace("&VALIDATED", "&CAPTIVE_PORTAL") },
    { network: wifiNetwork.replace("network{12}", "network{112}") },
    { network: wifiNetwork.replace("Current Networks:", "Network history:") },
  ]) {
    const fixture = fakeLifecycle(failure);
    await assert.rejects(runOwnerPhoneFixture(fixture.config, fixture.services), /origin mismatch|phone network/i);
    assert.ok(!fixture.steps.includes("hosted enrollment"));
    assert.equal(fixture.steps.at(-1), "device cleanup");
  }
});

test("a validated cellular default can proceed to hosted enrollment", async () => {
  const fixture = fakeLifecycle({ network: wifiNetwork.replace("Transports: WIFI", "Transports: CELLULAR") });
  assert.equal((await runOwnerPhoneFixture(fixture.config, fixture.services)).hosted.status, "passed");
  assert.ok(fixture.steps.includes("hosted enrollment"));
});

test("retirement failure retains the scoped receipt even when package cleanup also fails", async () => {
  const receipt = "synthetic-retirement.json";
  const packageError = Error("simulated package cleanup failure");
  const fixture = fakeLifecycle({
    retirementError: Object.assign(Error("retirement unconfirmed"), { retirementReceipt: receipt }),
    packageError,
  });
  await assert.rejects(runOwnerPhoneFixture(fixture.config, fixture.services), error =>
    error.retirementReceipt === receipt && error.cause === packageError);
});

test("hosted pass requires complete control revocation and exact retirement of the synthetic task", async () => {
  for (const incomplete of [{ revokedControls: 2 }, { retiredTasks: 0 }]) {
    const fixture = fakeLifecycle(incomplete);
    await assert.rejects(runOwnerPhoneFixture(fixture.config, fixture.services), /retirement incomplete|counts do not match/);
    assert.deepEqual(fixture.steps.slice(-2), ["hosted retirement", "device cleanup"]);
  }
});

test("validates the approved hash before talking to local ADB", async () => {
  const fixture = fakeAdb();
  await assert.rejects(withOwnerPhone({ serial, apkSha256 }, assert.fail, {
    runAdb: fixture.runAdb, verifyApk: async () => { throw Error("hash mismatch"); },
  }), /hash mismatch/);
  assert.deepEqual(fixture.calls, []);
});

test("selects one USB transport and queries fixture absence for each Android user", () => {
  const fixture = fakeAdb();
  const target = admitOwnerPhone(serial, fixture.runAdb);
  assert.equal(target.api, 36);
  assert.deepEqual(fixture.calls.slice(0, 2), [["-d", "get-serialno"], ["devices", "-l"]]);
  assert.ok(fixture.calls.slice(2).every(argv => argv[0] === "-t" && argv[1] === "42"));
  assert.deepEqual(fixture.calls.at(-1), ["-t", "42", "shell", "pm", "list", "packages", "-u", "--user", "10", appId]);
});

test("rejects wrong USB selection, transport, emulator, ABI, user, package and routes during admission", () => {
  for (const [query, value] of [
    ["-d get-serialno", "another-device"],
    ["get-serialno", "another-device"],
    ["shell getprop ro.kernel.qemu", "1"],
    ["shell getprop ro.boot.qemu", "1"],
    ["shell getprop ro.product.cpu.abi", "x86_64"],
    ["shell am get-current-user", "10"],
    ["shell am get-started-user-state 0", "RUNNING_LOCKED"],
    ["shell pm list packages -u --user 10 " + appId, "package:" + appId],
    ["forward --list", serial + " tcp:41000 localabstract:prior"],
    ["reverse --list", "UsbFfs tcp:3210 tcp:3210"],
  ]) {
    const fixture = fakeAdb({ [query]: value });
    assert.throws(() => admitOwnerPhone(serial, fixture.runAdb));
    assert.ok(!fixture.calls.some(argv => argv.some(token => /^(push|install|uninstall|mkdir|--remove)$/.test(token))));
  }
});

test("uses one selected transport through verified install, exercise failure and cleanup", async () => {
  const dir = "/data/local/tmp/klaxon-p0-install-active";
  const base = "/data/app/fixture/base.apk";
  let installed = false;
  let installedByRunner = false;
  let reserved = false;
  let forward = false;
  const fixture = fakeAdb({
    "forward --list": () => forward ? serial + " tcp:41001 localabstract:webview_devtools_remote_42" : "",
    ["shell pm list packages -u --user 0 " + appId]: () => installed ? "package:" + appId : "",
    ["shell mkdir " + dir]: () => { reserved = true; return ""; },
    ["shell sha256sum " + dir + "/base.apk"]: apkSha256 + "  " + dir + "/base.apk",
    ["shell ls -1 " + dir]: "status",
    ["shell head -c 16 " + dir + "/status"]: "0",
    ["shell pm path --user 0 " + appId]: "package:" + base,
    ["shell sha256sum " + base]: apkSha256 + "  " + base,
    ["shell pm uninstall --user 0 " + appId]: () => { installed = false; return "Success"; },
    ["shell rm -f " + ["base.apk", "result", "status.tmp", "status"].map(name => dir + "/" + name).join(" ")]: "",
    ["shell rmdir " + dir]: () => { reserved = false; return ""; },
  });
  const file = fileURLToPath(import.meta.url);
  async function verifyApk(path, hash) {
    assert.equal(path, file);
    assert.equal(hash, apkSha256);
    assert.deepEqual(fixture.calls, []);
  }
  function runAdb(argv) {
    if (argv[2] === "push" || argv[3]?.startsWith("nohup ")) {
      assert.deepEqual(argv.slice(0, 2), ["-t", "42"]);
      assert.equal(reserved, true);
      if (argv[2] === "push") assert.deepEqual(argv.slice(3), [file, dir + "/base.apk"]);
      else {
        assert.match(argv[3], /pm install -R --user 0 -S /);
        installedByRunner = installed = true;
      }
      return Buffer.from("");
    }
    return fixture.runAdb(argv);
  }
  const exerciseFailure = Error("synthetic origin attestation failed");
  await assert.rejects(withOwnerPhone({ serial, apkSha256 }, target => {
    assert.equal(target.appId, appId);
    assert.equal(target.api, 36);
    assert.ok(installed);
    forward = true;
    throw exerciseFailure;
  }, { runAdb, apkPath: file, verifyApk }), error =>
    error.code === "P0_PHONE_ADB_CLEANUP" && error.errors.includes(exerciseFailure));
  assert.equal(installedByRunner, true);
  assert.equal(installed, false);
  assert.equal(reserved, false);
  assert.equal(forward, true);
  assert.ok(!fixture.calls.some(argv => argv.includes("--remove-all")));
});
