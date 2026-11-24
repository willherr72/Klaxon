import assert from "node:assert/strict";
import { checkSessionPage, containsMarker, containsSdkAccess } from "./web-check.mjs";
import { exerciseSdkHandoff } from "./sdk-check.mjs";

export async function exerciseAndroidSdkHandoff(withActivity, adb, adbBytes, app) {
  const pids = new Set();
  let webview;
  async function launch(actions) {
    adb("shell", "am", "force-stop", app);
    await withActivity(async (page, pid) => {
      assert.ok(!pids.has(pid), "expected a fresh Android app process");
      pids.add(pid);
      page.setDefaultTimeout(20000);
      await page.goto("http://tauri.localhost/#sdk");
      await page.reload();
      assert.equal(await page.evaluate(() => window.p0Replies === undefined), true, "expected a fresh WebView");
      const policy = page.locator('meta[http-equiv="Content-Security-Policy"]').first();
      assert.match(await policy.getAttribute("content"), /connect-src 'none'/);
      webview = await page.evaluate(() => navigator.userAgent);
      await checkSessionPage(page, actions, "android");
    });
  }

  const record = "no_backup/packaged.bin";
  const outage = "cache/p0-provider-offline";
  const runAs = (...args) => adb("shell", "run-as", app, ...args);
  await exerciseSdkHandoff(launch, {
    read: () => {
      const bytes = adbBytes(["shell", "-T", "run-as", app, "cat", record]);
      assert.ok(bytes.length > 28, "expected an IV, ciphertext and GCM tag");
      return bytes;
    },
    write: bytes => adbBytes(["shell", "-T", "run-as", app, "sh", "-c", "'base64 -d > " + record + "'"],
      bytes.toString("base64")),
    outage: offline => offline ? runAs("touch", outage) : runAs("rm", outage),
    expiry: expired => runAs(expired ? "touch" : "rm", "cache/p0-provider-expired"),
    assertEmpty: () => assert.equal(runAs("ls", "-A", "no_backup"), "", "expected an empty Keystore record directory"),
  }, { verifyAndroidKeystore: true });
  adb("shell", "am", "force-stop", app);

  let logLines = 0;
  for (const pid of pids) {
    const log = adb("logcat", "-d", "-v", "threadtime", "-b", "main,system,crash", "--pid=" + pid);
    const appLine = new RegExp("\\s" + pid + "\\s+\\d+\\s+[VDIWEF]\\s");
    const count = log.split("\n").filter(line => appLine.test(line)).length;
    assert.ok(count > 0 && !containsMarker(log) && !containsSdkAccess(log), "expected app logs without session material");
    logLines += count;
  }
  console.log("PASS packaged Android Keystore-to-SDK", pids.size, "fresh app processes and WebViews,", logLines,
    "app log lines; SDK read, subscription, outage recovery, forced expiry and alias/file cleanup checked;", webview);
}
