import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const dir = "/data/local/tmp/klaxon-p0-install-active";
const publicFailureCodes = new Set([
  "INSTALL_FAILED_INSUFFICIENT_STORAGE",
  "INSTALL_FAILED_INVALID_APK",
  "INSTALL_FAILED_NO_MATCHING_ABIS",
  "INSTALL_FAILED_TEST_ONLY",
  "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
  "INSTALL_FAILED_USER_RESTRICTED",
  "INSTALL_FAILED_VERSION_DOWNGRADE",
]);

function readInstallOutcome(adb) {
  try {
    if (!adb("shell", "ls", "-1", dir).split(/\r?\n/).includes("status")) return;
    const status = adb("shell", "head", "-c", "16", dir + "/status");
    if (status === "0") return "success";
    if (status !== "1" && status !== "255") return;

    // A shell error or killed worker may leave a PackageInstaller session in flight.
    const result = adb("shell", "head", "-c", "2048", dir + "/result");
    // API 36 rejects an explicit trailing "-" while parsing the CLI, before creating an install session.
    if (status === "255" && /^java\.lang\.IllegalArgumentException: Unknown option -\s*$/m.test(result)) {
      return "unsupported stdin option";
    }
    if (status !== "1") return;
    const failure = /^Failure \[(?:([A-Z_]+)(?=[:\]]))?/m.exec(result.slice(0, 2048));
    if (failure) return publicFailureCodes.has(failure[1]) ? failure[1] : "package-manager rejection";
  } catch {
    // A transport error leaves the outcome unknown. Poll again until the deadline.
  }
}

export async function withAndroidFixture(adb, apk, appId, exercise, {
  now = () => performance.now(), pause = delay, timeoutMs = 120000,
} = {}) {
  const size = (await stat(apk)).size;
  const listPackages = () => adb("shell", "pm", "list", "packages", appId);
  try {
    // Keep this reservation for the whole run. A different host can see it even
    // if this process loses its connection or exits without an acknowledgment.
    adb("shell", "mkdir", dir);
  } catch {
    throw new Error("Cannot reserve Android fixture install directory. Check for an existing install receipt at " +
      dir + " before retrying");
  }

  let state = "reserved";
  try {
    assert.equal(listPackages(), "", "Use an AVD without a previous probe installation");
    state = "pending";
    try {
      adb("push", apk, dir + "/base.apk");
    } catch {
      throw new Error("Android APK staging unconfirmed; inspect " + dir + " before retrying");
    }

    const worker = `pm install -S ${size} >${dir}/result 2>&1 <${dir}/base.apk; echo $? >${dir}/status.tmp; mv ${dir}/status.tmp ${dir}/status`;
    try {
      adb("shell", `nohup sh -c '${worker}' </dev/null >/dev/null 2>&1 &`);
    } catch {
      // Launch may have reached the device. The receipt is the source of truth.
    }

    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const outcome = readInstallOutcome(adb);
      if (outcome) {
        state = "settled";
        if (outcome !== "success") throw new Error("Android fixture installation failed (" + outcome + ")");
        return await exercise();
      }
      await pause(250);
    }
    throw new Error("Android install outcome unconfirmed; inspect " + dir + "/status on the disposable emulator before retrying");
  } finally {
    if (state === "settled") {
      try {
        if (listPackages() === "package:" + appId) assert.equal(adb("uninstall", appId), "Success");
        assert.equal(listPackages(), "");
      } catch {
        throw new Error("Android fixture package cleanup unconfirmed; inspect " + dir + " before retrying");
      }
    }
    if (state !== "pending") {
      try {
        adb("shell", "rm", "-f", dir + "/base.apk", dir + "/result", dir + "/status.tmp", dir + "/status");
        adb("shell", "rmdir", dir);
      } catch {
        throw new Error("Android install receipt cleanup unconfirmed; inspect " + dir + " before retrying");
      }
    }
  }
}
