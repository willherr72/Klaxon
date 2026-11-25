import assert from "node:assert/strict";
import { withPreflightReverse } from "./android-preflight.mjs";
import { withAndroidTarget } from "./android-session-preflight.mjs";
import { withScriptedAndroidProvider } from "./scripted-android-provider.mjs";

// Call inside the disposable Android install guard, using a loopback-only preflight build.
export async function runAndroidRenewal(platform) {
  return withScriptedAndroidProvider(({ port, input, taskId, title, renewedTitle, phase, publishRenewedTask,
    providerRequests, verify }) => withPreflightReverse(platform.adb, port, async () => {
    let requestsAfterRevoke;
    const result = await withAndroidTarget(platform, input, async coldLaunch => {
      await coldLaunch(async page => {
        await page.evaluate(() => window.p0LocalProvider.signIn());
        await page.waitForFunction(() => window.p0LocalProvider.signInResult !== undefined);
        assert.equal(await page.evaluate(() => window.p0LocalProvider.signInResult), "fixture-ready");
      });
      let observation;
      await coldLaunch(async page => {
        const requestsBeforeResume = providerRequests();
        const coldForcedRefreshDenied = await page.evaluate(async () => {
          try { await window.__TAURI__.core.invoke("local_access", { forceRefresh: true }); }
          catch (error) { return error === "signed-out"; }
          return false;
        });
        assert.ok(coldForcedRefreshDenied, "Forced SDK access must be denied before cold resume");
        assert.equal(providerRequests(), requestsBeforeResume, "Forced SDK access before resume contacted the issuer");
        assert.ok(await page.evaluate(() => typeof window.p0LocalProvider.observeRenewal === "function"),
          "Android preflight build has no renewal observer");
        await page.evaluate(expected => window.p0LocalProvider.observeRenewal(expected), { taskId, title, renewedTitle });
        await page.waitForFunction(() => window.p0LocalProvider.renewalProgress?.phase === "renewed" ||
          window.p0LocalProvider.renewalResult !== undefined, undefined, { timeout: 40_000 });
        observation = await page.evaluate(() => window.p0LocalProvider.renewalResult);
        if (observation !== undefined) return;

        assert.equal(phase(), "successor-authenticated",
          "Original socket must authenticate with the exact successor before the task changes");
        publishRenewedTask();
        await page.waitForFunction(() => window.p0LocalProvider.renewalResult !== undefined, undefined, { timeout: 30_000 });
        observation = await page.evaluate(() => window.p0LocalProvider.renewalResult);
      });
      requestsAfterRevoke = providerRequests();
      return observation;
    });
    assert.equal(providerRequests(), requestsAfterRevoke, "Cold logout should deny access without contacting the issuer");
    verify();
    return { ...result, issuerVerified: true, coldForcedRefreshDenied: true, coldLogoutProviderRequests: 0 };
  }), { renewal: true });
}
