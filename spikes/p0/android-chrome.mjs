import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

export async function androidChrome(serverPort, mappings, loopbackBackend) {
  const serial = process.env.KLAXON_PROBE_AVD;
  if (!/^emulator-\d+$/.test(serial ?? "")) {
    throw new Error("Set KLAXON_PROBE_AVD to a disposable emulator serial");
  }
  const adb = (...args) => execFileSync(process.env.ADB ?? "adb", ["-s", serial, ...args],
    { encoding: "utf8", timeout: 15000 }).trim();
  if (adb("shell", "getprop", "ro.kernel.qemu") !== "1") throw new Error("Expected emulator");
  for (const port of loopbackBackend ? [3210, serverPort] : [serverPort]) {
    adb("reverse", "--no-rebind", "tcp:" + port, "tcp:" + port);
    mappings.push(() => adb("reverse", "--remove", "tcp:" + port));
  }
  adb("shell", "am", "start", "-n", "com.android.chrome/com.google.android.apps.chrome.Main");
  const port = adb("forward", "tcp:0", "localabstract:chrome_devtools_remote");
  mappings.push(() => adb("forward", "--remove", "tcp:" + port));
  const endpoint = "http://127.0.0.1:" + port;
  for (let attempt = 0; attempt < 60; attempt++) {
    const ready = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(1000) }).catch(() => null);
    await ready?.body?.cancel();
    if (ready?.ok) return chromium.connectOverCDP(endpoint, { timeout: 20000 });
    await delay(500);
  }
  throw new Error("Chrome debugging socket did not become available on the disposable emulator");
}
