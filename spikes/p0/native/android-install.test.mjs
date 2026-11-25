import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withAndroidFixture } from "./android-install.mjs";

const apk = fileURLToPath(import.meta.url);
const appId = "dev.klaxon.p0native";
const receipt = "/data/local/tmp/klaxon-p0-install-active";
const rawAdbError = "private ADB output";
const unexpectedAction = () => assert.fail("fixture should not start");

function fakeDevice({
  acknowledgeLaunch = true, acknowledgePush = true, polls = ["0"], result = "Success", failCleanup = false,
} = {}) {
  const calls = [];
  const state = { locked: false, installed: false, status: undefined };
  let tick = 0;
  const timing = { now: () => tick, pause: async ms => { tick += ms; }, timeoutMs: 500 };
  function adb(...args) {
    calls.push(args);
    const [command, tool, path] = args;
    if (command === "push") {
      if (!acknowledgePush) throw new Error(rawAdbError);
      return "";
    }
    if (command === "uninstall") {
      if (failCleanup) throw new Error(rawAdbError);
      state.installed = false;
      return "Success";
    }
    if (tool === "mkdir") {
      assert.equal(path, receipt);
      if (state.locked) throw new Error(rawAdbError);
      state.locked = true;
    } else if (tool.startsWith("nohup ")) {
      if (!acknowledgeLaunch) throw new Error(rawAdbError);
    } else if (tool === "pm") {
      return state.installed ? "package:" + appId : "";
    } else if (tool === "ls") {
      state.status = polls.shift();
      if (state.status instanceof Error) throw state.status;
      if (state.status === "0") state.installed = true;
      return state.status === undefined ? "base.apk\nresult" : "base.apk\nresult\nstatus";
    } else if (tool === "head") {
      const [, , , , filename] = args;
      return filename.endsWith("/status") ? state.status : result;
    } else if (tool === "rmdir") {
      state.locked = false;
    } else {
      assert.equal(tool, "rm");
    }
    return "";
  }
  return {
    calls, state,
    run: action => withAndroidFixture(adb, apk, appId, action, timing),
  };
}

test("a lost launch acknowledgment and transient poll error still allow a confirmed install", async () => {
  const device = fakeDevice({ acknowledgeLaunch: false, polls: [new Error(rawAdbError), "0"] });
  const value = await device.run(() => {
    assert.equal(device.state.installed, true);
    assert.equal(device.state.locked, true);
    return "exercised";
  });
  assert.equal(value, "exercised");
  assert.equal(device.state.installed, false);
  assert.equal(device.state.locked, false);
  const launches = device.calls.filter(([, command]) => command.startsWith("nohup "));
  assert.deepEqual(launches, [["shell", `nohup sh -c 'pm install -S ${statSync(apk).size} >${receipt}/result 2>&1 <${receipt}/base.apk; echo $? >${receipt}/status.tmp; mv ${receipt}/status.tmp ${receipt}/status' </dev/null >/dev/null 2>&1 &`]]);
  assert.ok(device.calls.findIndex(([command]) => command === "uninstall") <
    device.calls.findIndex(([, command]) => command === "rmdir"));
});

test("a timeout preserves the receipt and blocks a retry before package checks or staging", async () => {
  const device = fakeDevice({ acknowledgeLaunch: false, polls: [] });
  await assert.rejects(device.run(unexpectedAction), /outcome unconfirmed.*klaxon-p0-install-active\/status/);
  assert.equal(device.state.locked, true);
  assert.ok(!device.calls.some(([command, tool]) => command === "uninstall" || tool === "rm" || tool === "rmdir"));
  const previousCalls = device.calls.length;
  await assert.rejects(device.run(unexpectedAction), /existing install receipt.*klaxon-p0-install-active/);
  assert.deepEqual(device.calls.slice(previousCalls), [["shell", "mkdir", receipt]]);
});

test("invalid or abnormal receipts leave the install pending", async () => {
  for (const status of ["", "0\n1", "137", "1"]) {
    const device = fakeDevice({ polls: [status], result: "unrecognized worker output" });
    await assert.rejects(device.run(unexpectedAction), /outcome unconfirmed/);
    assert.equal(device.state.locked, true);
    assert.ok(!device.calls.some(([command, tool]) => command === "uninstall" || tool === "rm" || tool === "rmdir"));
  }
});

test("the API 36 argument rejection before install releases the reservation", async () => {
  const device = fakeDevice({ polls: ["255"], result: "java.lang.IllegalArgumentException: Unknown option -\r\n" });
  await assert.rejects(device.run(unexpectedAction), /installation failed \(unsupported stdin option\)/);
  assert.equal(device.state.locked, false);
  assert.equal(device.state.installed, false);
});

test("a confirmed package-manager failure releases the receipt and reports a bounded public reason", async () => {
  const device = fakeDevice({
    polls: ["1"],
    result: `Failure [INSTALL_FAILED_USER_RESTRICTED: ${rawAdbError}\u001b[31m${"x".repeat(4096)}]`,
  });
  await assert.rejects(device.run(unexpectedAction), { message: "Android fixture installation failed (INSTALL_FAILED_USER_RESTRICTED)" });
  assert.equal(device.state.locked, false);
  assert.deepEqual(device.calls.find(([, , , , path]) => path === receipt + "/result"),
    ["shell", "head", "-c", "2048", receipt + "/result"]);
});

test("the receipt blocks a competing run and package cleanup errors keep it in place", async () => {
  const device = fakeDevice({ failCleanup: true });
  await assert.rejects(device.run(async () => {
    await assert.rejects(device.run(unexpectedAction), /existing install receipt/);
  }), /package cleanup unconfirmed.*klaxon-p0-install-active/);
  assert.equal(device.state.installed, true);
  assert.equal(device.state.locked, true);
  assert.ok(!device.calls.some(([, tool]) => tool === "rm" || tool === "rmdir"));
});

test("a lost push acknowledgment blocks relaunch without exposing ADB output", async () => {
  const device = fakeDevice({ acknowledgePush: false });
  await assert.rejects(device.run(unexpectedAction), {
    message: `Android APK staging unconfirmed; inspect ${receipt} before retrying`,
  });
  assert.equal(device.state.locked, true);
  const previousCalls = device.calls.length;
  assert.ok(!device.calls.some(([, tool]) => tool.startsWith("nohup ") || tool === "rm" || tool === "rmdir"));
  await assert.rejects(device.run(unexpectedAction), /existing install receipt/);
  assert.deepEqual(device.calls.slice(previousCalls), [["shell", "mkdir", receipt]]);
});

test("a failed smoke exercise still cleans up its confirmed install", async () => {
  const device = fakeDevice();
  const exerciseFailure = new Error("smoke assertion failed");
  await assert.rejects(device.run(() => { throw exerciseFailure; }), error => error === exerciseFailure);
  assert.equal(device.state.installed, false);
  assert.equal(device.state.locked, false);
});
