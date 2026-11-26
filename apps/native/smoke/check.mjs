import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { withAndroidFixture } from "../../../spikes/p0/native/android-install.mjs";
import { withAndroidActivity, withWindowsHost } from "../../../spikes/p0/native/smoke.mjs";

const appId = "dev.klaxon.v2";
const assetUrl = "http://tauri.localhost/";
const usage = "Usage: node apps/native/smoke/check.mjs windows <exe> | android <apk> <emulator-serial>";

async function checkPage(page) {
  await page.waitForURL(assetUrl, { timeout: 20_000 });
  const heading = page.locator("h1").filter({ hasText: /^\s*Klaxon\s*$/ });
  await heading.waitFor({ state: "visible", timeout: 20_000 });
  assert.equal(page.url(), assetUrl);
  assert.equal(await page.locator("main").evaluate(main => getComputedStyle(main).display), "grid",
    "Expected the bundled foundation stylesheet to load");
  assert.ok(await page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), "Expected the native Tauri bridge");
  return page.url();
}

async function windows(exe) {
  assert.equal(process.platform, "win32", "Run the Windows smoke on Windows");
  const profile = await mkdtemp(join(tmpdir(), "klaxon-v2-smoke-"));
  try {
    return await withWindowsHost(exe, profile, checkPage, { hosts: new Set(), browsers: new Set() });
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
}

async function android(apk, serial) {
  const badging = execFileSync(process.env.AAPT ?? "aapt", ["dump", "badging", apk], {
    encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  assert.equal(/^package: name='([^']+)'/m.exec(badging)?.[1], appId, "Unexpected APK package identifier");

  const adb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: args[0] === "push" ? 120_000 : 30_000, windowsHide: true,
  }).trim();
  const avd = adb("emu", "avd", "name").split(/\r?\n/)[0].trim();
  assert.match(avd, /^(KlaxonV2Smoke_[A-Za-z0-9]+|klaxon-p1-foundation)$/, "Select a disposable Klaxon v2 smoke AVD");
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1", "Expected an Android emulator");
  assert.equal(adb("shell", "getprop", "sys.boot_completed"), "1", "Wait for the emulator to boot");
  assert.equal(adb("shell", "settings", "get", "global", "airplane_mode_on"), "1", "Enable airplane mode");
  assert.equal(adb("shell", "settings", "get", "global", "wifi_on"), "0", "Disable Wi-Fi");
  assert.match(adb("shell", "dumpsys", "connectivity"), /Active default network:\s*none/i, "Expected an offline AVD");

  function assertNoMappings() {
    const forwards = adb("forward", "--list").split(/\r?\n/);
    assert.ok(!forwards.some(line => line.trim().split(/\s+/)[0] === serial), "Expected an AVD without ADB forwards");
    assert.equal(adb("reverse", "--list"), "", "Expected an AVD without ADB reverse routes");
  }

  assertNoMappings();
  try {
    return await withAndroidFixture(adb, apk, appId, async () => {
      try {
        return await withAndroidActivity(adb, serial, appId, checkPage, { primaryUser: true });
      } finally {
        adb("shell", "am", "force-stop", "--user", "0", appId);
      }
    });
  } finally {
    assertNoMappings();
  }
}

const [platform, artifactPath, serial, ...extra] = process.argv.slice(2);
assert.ok(artifactPath && extra.length === 0 && (
  (platform === "windows" && serial === undefined) || (platform === "android" && /^emulator-\d+$/.test(serial ?? ""))
), usage);
const artifact = resolve(artifactPath);
const extension = platform === "windows" ? ".exe" : ".apk";
assert.equal(extname(artifact).toLowerCase(), extension, `Pass a built ${extension} artifact`);
assert.ok((await stat(artifact)).isFile(), "Pass a file as the artifact path");
const url = platform === "windows" ? await windows(artifact) : await android(artifact, serial);
console.log(`PASS ${platform}${serial ? ` (${serial})` : ""} rendered a visible h1 "Klaxon" at ${url}`);
