import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Playwright and Node configure protocol logging and proxies at process startup.
// Create the provider accounts only inside a fresh process with platform settings.
const platformKeys = new Set([
  "systemroot", "windir", "systemdrive", "comspec", "pathext", "path", "temp", "tmp",
  "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata",
  "processor_architecture", "number_of_processors", "adb", "java_home", "android_home",
  "homedrive", "homepath", "logonserver", "userdomain", "username",
]);

export function androidAcceptanceEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => platformKeys.has(key.toLowerCase())));
}

export function providerWorkerEnvironmentIsClean() {
  return process.execArgv.length === 0 && Object.keys(process.env).every(key => platformKeys.has(key.toLowerCase()));
}

export function launchAndroidAcceptance(args) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    env: androidAcceptanceEnv(process.env), stdio: "inherit", windowsHide: true,
  });
  if (child.error || child.signal) throw Error("Android acceptance worker did not finish");
  return child.status ?? 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] !== "android-provider-acceptance" || !providerWorkerEnvironmentIsClean()) {
    throw Error("Use the isolated Android acceptance entry point in native/smoke.mjs");
  }
  const { android } = await import("../smoke.mjs");
  await android(process.argv[3]);
}
