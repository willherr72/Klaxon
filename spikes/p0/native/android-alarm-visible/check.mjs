import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { withAndroidFixture } from "../android-install.mjs";

const [serial] = process.argv.slice(2);
assert.equal(process.argv.length, 3, "Pass one disposable visible-alarm emulator serial");
assert.match(serial, /^emulator-\d+$/);

const appId = "dev.klaxon.p0alarmvisible";
const apk = fileURLToPath(new URL("./build/outputs/apk/debug/android-alarm-visible-debug.apk", import.meta.url));
const adb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args], {
  timeout: args[0] === "push" ? 120_000 : 30_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
}).trim();

assert.match(adb("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonAlarmVisibleP0_[A-Za-z0-9]+$/);
for (const [key, expected] of Object.entries({
  "ro.kernel.qemu": "1", "ro.build.version.sdk": "36", "ro.product.cpu.abi": "x86_64", "sys.boot_completed": "1",
})) assert.equal(adb("shell", "getprop", key), expected);

function assertOffline() {
  assert.equal(adb("shell", "settings", "get", "global", "airplane_mode_on"), "1");
  assert.equal(adb("shell", "settings", "get", "global", "wifi_on"), "0");
  assert.match(adb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
  assert.equal(adb("reverse", "--list"), "");
  assert.ok(!adb("forward", "--list").split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === serial));
}

const verifyAbsent = () => assert.equal(adb("shell", "pm", "list", "packages", "-u", "--user", "0", appId), "");
assertOffline();
verifyAbsent();

const uiFile = `/data/local/tmp/klaxon-p0-visible-${randomUUID()}.xml`;
function captureUi() {
  adb("shell", "rm", "-f", uiFile);
  adb("shell", "uiautomator", "dump", uiFile);
  return adb("shell", "cat", uiFile).match(/<node [^>]+>/g) ?? [];
}

async function waitForUi(predicate, stage) {
  const deadline = performance.now() + 30_000;
  do {
    // The hierarchy can be temporarily unavailable during activity transitions.
    let nodes = [];
    try { nodes = captureUi(); } catch { /* Poll the selected activity again. */ }
    const value = predicate(nodes);
    if (value) return value;
    await pause(300);
  } while (performance.now() < deadline);
  throw new Error(`Android visible-alarm UI did not reach ${stage}`);
}

const fixtureNode = node => node.includes(`package="${appId}"`);
const isText = label => node => fixtureNode(node) && node.includes(`text="${label}"`);
const allow = isText("Allow notifications");
const arm = isText("Arm test reminder");
const permissionController = node => /package="[\w.]*permissioncontroller"/.test(node);
const permissionButton = suffix => node => permissionController(node) && /resource-id="[\w.]*permissioncontroller:id\//.test(node) &&
  node.includes(`permission_${suffix}_button"`);

function tap(node) {
  const bounds = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
  assert.ok(bounds, "Expected fixture control bounds");
  const [left, top, right, bottom] = bounds.slice(1).map(Number);
  assert.ok(right > left && bottom > top);
  adb("shell", "input", "tap", Math.floor((left + right) / 2), Math.floor((top + bottom) / 2));
}

function assertUnarmed() {
  assert.match(adb("shell", "dumpsys", "package", appId), /android\.permission\.POST_NOTIFICATIONS: granted=false/);
  adb("shell", "run-as", appId, "test", "!", "-e", "no_backup/run.json");
}

async function openFixture() {
  assert.match(adb("shell", "am", "start", "-W", "-n", `${appId}/.ArmActivity`), /^Status: ok\s*$/m);
  const unarmed = isText("No test alarm armed.");
  const controls = await waitForUi(nodes => nodes.some(allow) && nodes.some(arm) && nodes.some(unarmed) && nodes,
    "the fixture permission screen");
  assert.ok(controls.find(arm).includes('enabled="false"'), "Arming must remain disabled without permission");
  assertUnarmed();
  return controls.find(allow);
}

let failure;
try {
  await withAndroidFixture(adb, apk, appId, async () => {
    tap(await openFixture());
    const denyButton = await waitForUi(nodes => nodes.some(node => permissionController(node) &&
      node.includes("Klaxon P0 native alarm")) && nodes.some(permissionButton("allow")) &&
      nodes.find(permissionButton("deny")), "the Android permission prompt");
    tap(denyButton);
    const disabledArm = await waitForUi(nodes => nodes.find(arm), "the denied fixture state");
    assert.ok(disabledArm.includes('enabled="false"'), "Arming must remain disabled after denial");
    assertUnarmed();
    adb("shell", "am", "force-stop", appId);
    await openFixture();
  });
} catch (error) {
  failure = error;
}
try {
  adb("shell", "rm", "-f", uiFile);
  adb("shell", "test", "!", "-e", uiFile);
  assertOffline();
  verifyAbsent();
} catch (cleanupError) {
  if (failure) throw new AggregateError([failure, cleanupError], "Android permission check and cleanup failed");
  throw cleanupError;
}
if (failure) throw failure;

console.log("Android visible-alarm fixture verified permission denial, no arming, and scoped uninstall.");
