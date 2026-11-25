import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withAndroidFixture } from "../android-install.mjs";

const appId = "dev.klaxon.p0alarm";
const maxDispatchDelayMs = 90_000;
const observeAfterCallbackMs = 10_000;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function verifyPlan(plan, runId) {
  assert.equal(plan.runId, runId);
  assert.ok(["exact", "inexact"].includes(plan.mode), "Expected an identified arming mode");
  assert.ok([plan.armedPid, plan.armedProcessStartElapsedMs, plan.armedAtMs].every(positiveInteger));
  assert.deepEqual([
    plan.replacedDueMs - plan.armedAtMs, plan.canceledDueMs - plan.armedAtMs, plan.dueMs - plan.armedAtMs,
  ], [20_000, 24_000, 30_000], "Expected the bounded replacement and cancellation plan");
}

export function verifyAlarmReceipt({ runId, plan, receipts, coldBeforeMs, observedThroughMs }) {
  verifyPlan(plan, runId);
  assert.ok(coldBeforeMs >= plan.armedAtMs && coldBeforeMs < plan.replacedDueMs,
    "The arming process must exit before the original deadline");
  assert.equal(receipts.length, 1, "Expected one callback after replacement and cancellation");
  const [receipt] = receipts;
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.slot, "retained");
  assert.equal(receipt.revision, 2, "Expected the replacement revision");
  assert.equal(receipt.dueMs, plan.dueMs);
  assert.ok(positiveInteger(receipt.pid) && receipt.pid !== plan.armedPid &&
    positiveInteger(receipt.processStartElapsedMs) && receipt.processStartElapsedMs > plan.armedProcessStartElapsedMs,
    "Expected a new receiver process");
  assert.equal(receipt.interactive, false, "Expected the emulator screen to remain noninteractive");
  assert.ok(typeof receipt.keyguardLocked === "boolean" && typeof receipt.idle === "boolean");
  assert.ok(positiveInteger(receipt.receivedAtMs) && receipt.receivedAtMs >= plan.dueMs &&
    receipt.receivedAtMs <= plan.dueMs + maxDispatchDelayMs, "Callback outside the observed due window");
  const observedAfterCallbackMs = observedThroughMs - receipt.receivedAtMs;
  assert.ok(observedAfterCallbackMs >= observeAfterCallbackMs, "The callback was not observed through the quiet window");
  return {
    mode: plan.mode, delayMs: receipt.receivedAtMs - plan.dueMs, callbacks: receipts.length, coldProcess: true,
    interactive: receipt.interactive, keyguardLocked: receipt.keyguardLocked, idle: receipt.idle, observedAfterCallbackMs,
  };
}

async function rehearse(serial) {
  assert.match(serial ?? "", /^emulator-\d+$/, "Pass the disposable alarm emulator serial");
  const apk = fileURLToPath(new URL("./build/outputs/apk/debug/android-alarm-debug.apk", import.meta.url));
  const adb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args], {
    timeout: args[0] === "push" ? 120_000 : 30_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  }).trim();
  assert.match(adb("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonAlarmP0_[A-Za-z0-9]+$/);
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
  assert.equal(adb("shell", "getprop", "sys.boot_completed"), "1");
  assert.equal(adb("shell", "getprop", "ro.product.cpu.abi"), "x86_64");
  assert.equal(adb("shell", "getprop", "ro.build.version.sdk"), "36");
  function assertOffline() {
    assert.equal(adb("shell", "settings", "get", "global", "airplane_mode_on"), "1");
    assert.equal(adb("shell", "settings", "get", "global", "wifi_on"), "0");
    assert.match(adb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
    assert.equal(adb("reverse", "--list"), "");
    assert.ok(!adb("forward", "--list").split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === serial));
  }
  assertOffline();
  assert.equal(adb("shell", "pm", "list", "packages", "-u", "--user", "0", appId), "");
  const deviceTime = () => {
    const seconds = adb("shell", "date", "+%s");
    assert.match(seconds, /^\d{10}$/);
    return Number(seconds) * 1000;
  };
  const pid = () => adb("shell", "sh", "-c", "'pidof " + appId + " || true'");

  try {
    return await withAndroidFixture(adb, apk, appId, async () => {
      const runId = randomUUID();
      assert.match(adb("shell", "am", "start", "-W", "-n", appId + "/.ArmActivity", "--es", "run-id", runId),
        /^Status: ok\s*$/m);
      const planText = adb("shell", "run-as", appId, "cat", "no_backup/plan.json");
      const plan = JSON.parse(planText);
      verifyPlan(plan, runId);
      assert.equal(pid(), String(plan.armedPid));
      assert.equal(adb("shell", "run-as", appId, "cat", "no_backup/receipts.jsonl"), "");
      const killDeadline = performance.now() + 10_000;
      while (pid() && performance.now() < killDeadline) {
        adb("shell", "am", "kill", appId);
        await pause(250);
      }
      assert.equal(pid(), "", "The background fixture process did not exit");
      const coldBeforeMs = deviceTime() + 1000;
      assert.ok(coldBeforeMs < plan.replacedDueMs, "The original deadline passed before cold-state verification");
      adb("shell", "input", "keyevent", "KEYCODE_SLEEP");

      const deadline = performance.now() + (plan.dueMs - deviceTime()) + maxDispatchDelayMs + observeAfterCallbackMs + 2000;
      let receipts;
      let observedThroughMs;
      do {
        observedThroughMs = deviceTime();
        const text = adb("shell", "run-as", appId, "cat", "no_backup/receipts.jsonl");
        receipts = text ? text.split(/\r?\n/).map(line => JSON.parse(line)) : [];
        if (receipts.length > 1 || (receipts.length === 1 &&
            observedThroughMs >= receipts[0].receivedAtMs + observeAfterCallbackMs)) break;
        await pause(1000);
      } while (performance.now() < deadline);

      return {
        ...verifyAlarmReceipt({ runId, plan, receipts, coldBeforeMs, observedThroughMs }),
        dueUtc: new Date(plan.dueMs).toISOString(),
        receivedUtc: new Date(receipts[0].receivedAtMs).toISOString(),
      };
    });
  } finally {
    assertOffline();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  assert.equal(process.argv.length, 3, "Pass exactly one disposable alarm emulator serial");
  console.log("Android alarm fixture callback and scoped uninstall verified.", await rehearse(process.argv[2]));
}
