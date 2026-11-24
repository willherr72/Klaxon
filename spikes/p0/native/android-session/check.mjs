import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = "dev.klaxon.p0session";
const [serial] = process.argv.slice(2);
assert.match(serial ?? "", /^emulator-\d+$/, "Pass the disposable emulator serial");
const apk = fileURLToPath(new URL("./build/outputs/apk/debug/android-session-debug.apk", import.meta.url));
await access(apk);
const adb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-s", serial, ...args], { timeout: 30000 });
const text = (...args) => adb(...args).toString().trim();
assert.match(text("emu", "avd", "name").split(/\r?\n/)[0].trim(), /^KlaxonSessionP0_[A-Za-z0-9]+$/);
assert.equal(text("shell", "getprop", "ro.kernel.qemu"), "1");
assert.equal(text("shell", "getprop", "sys.boot_completed"), "1");
assert.equal(text("shell", "settings", "get", "global", "airplane_mode_on"), "1");
assert.match(text("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i);
const packages = () => text("shell", "pm", "list", "packages", app);
assert.equal(packages(), "", "Require a fresh fixture installation");

const pids = new Set();
function step(operation, owner, outcome, response = "grant", generation = 1) {
  text("shell", "am", "force-stop", app);
  const report = text("shell", "am", "instrument", "-w", "-r",
    "-e", "operation", operation, "-e", "owner", owner, "-e", "response", response,
    "-e", "generation", String(generation), app + "/.SessionProbe");
  assert.ok(!report.includes("KLAXON-P0-INERT/"), "plaintext marker in instrumentation output");
  assert.match(report, /^INSTRUMENTATION_CODE: -1\s*$/m);
  const fields = Object.fromEntries([...report.matchAll(/^INSTRUMENTATION_RESULT: (\w+)=([^\r\n]*)/gm)]
    .map(([, key, value]) => [key, value]));
  assert.equal(fields.outcome, outcome, operation + " " + owner);
  assert.match(fields.workerPid, /^\d+$/);
  assert.ok(!pids.has(fields.workerPid), "expected a fresh process");
  pids.add(fields.workerPid);
  return fields;
}

const empty = "no-key/no-file", stored = "key/file";
function inventory(result, alpha, beta) {
  assert.equal(result.alpha, alpha);
  assert.equal(result.beta, beta);
}
const copy = (from, to) => text("shell", "run-as", app, "cp", from, to);
const record = owner => {
  const bytes = adb("exec-out", "run-as", app, "cat", "no_backup/" + owner + ".bin");
  assert.ok(bytes.length > 28, "expected IV, encrypted data and GCM tag");
  assert.ok(!bytes.includes(Buffer.from("KLAXON-P0-INERT/")), "plaintext marker on disk");
  return bytes;
};

assert.match(text("install", "-t", apk), /Success/);
try {
  inventory(step("inspect", "alpha", "inspected"), empty, empty);
  step("resume", "alpha", "sign-in-required");
  inventory(step("sign-in", "alpha", "stored"), stored, empty);
  const first = record("alpha");
  step("resume", "alpha", "retry-required", "unavailable");
  assert.ok(record("alpha").equals(first), "outage modified the record");
  copy("no_backup/alpha.bin", "cache/pre-rotation.bin");
  step("resume", "alpha", "authenticated");
  assert.ok(!record("alpha").equals(first), "rotation left the original ciphertext");
  step("resume", "alpha", "authenticated", "grant", 2);
  copy("cache/pre-rotation.bin", "no_backup/alpha.bin");
  text("shell", "run-as", app, "rm", "cache/pre-rotation.bin");
  inventory(step("resume", "alpha", "sign-in-required", "grant", 3), empty, empty);
  step("resume", "alpha", "sign-in-required");
  console.log("PASS cold restart, offline retry, rotation and simulated stale-marker rejection");

  step("sign-in", "alpha", "stored");
  step("resume", "beta", "sign-in-required");
  inventory(step("sign-in", "beta", "stored"), stored, stored);
  copy("no_backup/alpha.bin", "no_backup/beta.bin");
  inventory(step("resume", "beta", "storage-unavailable"), stored, stored);
  assert.ok(record("beta").equals(record("alpha")), "unreadable record was modified");
  step("resume", "alpha", "authenticated");
  inventory(step("sign-out", "beta", "signed-out"), stored, empty);
  step("resume", "alpha", "authenticated", "grant", 2);
  step("sign-in", "beta", "stored");
  inventory(step("resume", "alpha", "sign-in-required", "expired", 3), empty, stored);
  step("resume", "alpha", "sign-in-required");
  step("resume", "beta", "authenticated");
  console.log("PASS copied ciphertext denied across app users; expiry removed only its owner's key and file");

  inventory(step("sign-out", "beta", "signed-out"), empty, empty);
  step("resume", "beta", "sign-in-required");
  inventory(step("inspect", "alpha", "inspected"), empty, empty);
  assert.equal(text("shell", "run-as", app, "ls", "-A", "no_backup"), "");
  console.log("PASS logout, cold relaunch and scoped alias/file cleanup across", pids.size, "distinct app processes");
} finally {
  assert.match(text("uninstall", app), /Success/);
  assert.equal(packages(), "");
  console.log("Fixture APK uninstalled");
}
