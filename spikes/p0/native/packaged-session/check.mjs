import assert from "node:assert/strict";
import { checkSessionPage, containsMarker } from "./web-check.mjs";

export async function exerciseSession(withActivity, adb, app) {
  const pids = new Set();
  let replies = 0;
  async function launch(actions) {
    adb("shell", "am", "force-stop", app);
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "expected a fresh app process");
      pids.add(pid);
      await checkSessionPage(page, actions);
      replies += actions.length;
    });
  }

  await launch([["Resume session", "signed-out"], ["Start synthetic session", "fixture-ready"],
    ["Start synthetic session", "unavailable"]]); // Existing record: also inspect the rejection payload.
  const readRecord = () => Buffer.from(adb("shell", "run-as", app, "base64", "no_backup/packaged.bin"), "base64");
  const sealed = readRecord();
  assert.ok(sealed.length > 28 && !containsMarker(sealed.toString("latin1")), "expected protected native record");
  const outage = "cache/p0-provider-offline";
  adb("shell", "run-as", app, "touch", outage);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await launch([["Resume session", "retry-required"]]);
      assert.ok(readRecord().equals(sealed), "denied resume changed the protected record");
    }
  } finally {
    adb("shell", "run-as", app, "rm", "-f", outage);
  }
  await launch([["Resume session", "authenticated"]]);
  const expiry = "cache/p0-provider-expired";
  adb("shell", "run-as", app, "touch", expiry);
  try {
    await launch([["Resume session", "signed-out"]]);
    assert.equal(adb("shell", "run-as", app, "ls", "-A", "no_backup"), "",
      "definitive expiry must remove the protected record");
  } finally {
    adb("shell", "run-as", app, "rm", "-f", expiry);
  }
  // Explicit fresh sign-in must work after definitive expiry.
  await launch([["Resume session", "signed-out"], ["Start synthetic session", "fixture-ready"]]);
  await launch([["Resume session", "authenticated"], ["Sign out", "signed-out"]]);
  await launch([["Resume session", "signed-out"]]);
  assert.equal(adb("shell", "run-as", app, "ls", "-A", "no_backup"), "");
  let logLines = 0;
  for (const pid of pids) {
    const log = adb("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash", "--pid=" + pid);
    const count = log.split("\n").filter(line => new RegExp("\\s" + pid + "\\s+\\d+\\s+[VDIWEF]\\s").test(line)).length;
    assert.ok(count > 0 && !containsMarker(log), "expected app logs without marker");
    logLines += count;
  }
  console.log("PASS packaged session:", pids.size, "app PIDs,", replies,
    "status-only replies,", logLines, "app log lines; outage preserved ciphertext, expiry cleared the native slot, only a fresh seed restored access, sign-out survived relaunch");
}
