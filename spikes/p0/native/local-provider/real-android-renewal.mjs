import assert from "node:assert/strict";
import { anyApi as api } from "convex/server";
import { withPreflightReverse } from "./android-preflight.mjs";
import { withAndroidTarget } from "./android-session-preflight.mjs";
import { withLocalBackend } from "./backend.mjs";
import { enrollLocalProviderAccount, localProviderClient } from "./provider-controls.mjs";

const providerPort = 3210;
const providerOrigin = "http://127.0.0.1:" + providerPort;
const providerAccessTtlSeconds = 60;

function protectedSlotDigest({ adb, appId }) {
  const [digest] = adb("shell", "run-as", appId, "sha256sum", "no_backup/localprovider.bin").split(/\s+/, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(digest), "Expected a device-side digest of the protected slot");
  return digest;
}

// Call inside the disposable Android install guard with the loopback-only APK.
export async function runRealAndroidRenewal(platform) {
  let stage = "isolated Convex backend setup";
  try {
    return await withLocalBackend(async ({ url }) => {
      assert.equal(url, providerOrigin);
      stage = "Android reverse setup";
      const result = await withPreflightReverse(platform.adb, providerPort, async () => {
        stage = "owner enrollment and task creation";
        const issuer = localProviderClient();
        const { credentials, grant, http: control } = await enrollLocalProviderAccount(issuer);
        const owner = grant.userId;
        let controlGrant = grant;
        try {
          assert.ok(typeof owner === "string" && owner.length > 0);
          assert.equal(await control.query(api.auth.isAuthenticated, {}), true);
          assert.equal((await control.query(api.tasks.list, {})).length, 0);
          const title = "Local renewal fixture";
          const renewedTitle = "Control edit after renewal";
          const taskId = await control.mutation(api.tasks.create, { title });
          assert.ok(typeof taskId === "string" && taskId.length > 0);

          stage = "Android credential handoff and sign-in";
          const session = await withAndroidTarget(platform, { ...credentials, owner }, async coldLaunch => {
            await coldLaunch(async page => {
              assert.ok(await page.evaluate(origin => window.p0LocalProvider.origin === origin &&
                window.p0LocalProvider.localRenewalVersion === 1 &&
                typeof window.p0LocalProvider.observeRenewal === "function", url));
              await page.evaluate(() => window.p0LocalProvider.signIn());
              await page.waitForFunction(() => window.p0LocalProvider.signInResult !== undefined,
                undefined, { timeout: 30_000 });
              assert.ok(await page.evaluate(() => window.p0LocalProvider.signInResult === "fixture-ready"));
            });

            stage = "Android resume and initial authenticated subscription";
            let observation;
            await coldLaunch(async page => {
              await page.evaluate(expected => window.p0LocalProvider.observeRenewal(expected),
                { taskId, title, renewedTitle, realProvider: true });
              await page.waitForFunction(() => window.p0LocalProvider.renewalProgress?.phase === "subscribed" ||
                window.p0LocalProvider.renewalResult !== undefined, undefined, { timeout: 30_000 });
              assert.ok(await page.evaluate(() => window.p0LocalProvider.renewalProgress?.phase === "subscribed"));
              stage = "protected Android slot before renewal";
              const initialDigest = protectedSlotDigest(platform);

              stage = "scheduled SDK renewal";
              await page.waitForFunction(() => window.p0LocalProvider.renewalProgress?.phase === "renewed" ||
                window.p0LocalProvider.renewalResult !== undefined, undefined, { timeout: 80_000 });
              assert.ok(await page.evaluate(() => window.p0LocalProvider.renewalProgress?.phase === "renewed" &&
                window.p0LocalProvider.renewalResult === undefined));
              stage = "protected Android slot after renewal";
              assert.ok(protectedSlotDigest(platform) !== initialDigest);

              stage = "independent control refresh and task rename";
              // The control started before Android. Refresh its own grant before the edit.
              const rotated = await issuer.mutation(api.auth.refreshSession, { refreshToken: grant.refreshToken });
              const next = rotated?.tokens;
              assert.ok(rotated?.kind === "rotated" && next?.userId === owner &&
                typeof next.accessToken === "string" && next.accessToken && next.accessToken !== grant.accessToken &&
                typeof next.refreshToken === "string" && next.refreshToken && next.refreshToken !== grant.refreshToken);
              controlGrant = next;
              control.setAuth(next.accessToken);
              await control.mutation(api.tasks.rename, { id: taskId, title: renewedTitle });

              stage = "Android original subscription, successor HTTP read and revoke";
              await page.waitForFunction(() => window.p0LocalProvider.renewalResult !== undefined,
                undefined, { timeout: 30_000 });
              observation = await page.evaluate(() => window.p0LocalProvider.renewalResult);
              assert.ok(observation?.status === "passed" && observation.revokedHttpDenied === true);
              assert.equal(observation.initialBearerTtlSeconds, providerAccessTtlSeconds);
              assert.equal(observation.successorBearerTtlSeconds, providerAccessTtlSeconds);
            });
            stage = "Android protected slot cleanup and cold logout";
            return observation;
          });

          stage = "independent control read after Android revoke";
          assert.equal(await control.query(api.auth.isAuthenticated, {}), true);
          const rows = await control.query(api.tasks.list, {});
          assert.ok(rows.length === 1 && rows[0]._id === taskId && rows[0].owner === owner &&
            rows[0].title === renewedTitle);
          return { ...session, provider: "local-convex", independentControlRename: true,
            survivingControlRows: rows.length, protectedSlotRotated: true, protectedSlotCleared: true };
        } finally {
          try {
            const { refreshToken } = controlGrant;
            assert.equal(await issuer.mutation(api.auth.signOut, { refreshToken }), null);
            assert.equal((await issuer.mutation(api.auth.refreshSession, { refreshToken }))?.kind, "noSession");
          } catch {
            stage = "independent control session cleanup";
            throw new Error(stage);
          } finally {
            control.clearAuth();
          }
        }
      });
      stage = "isolated Convex backend cleanup";
      return { ...result, controlSessionRevoked: true };
    });
  } catch {
    // Browser, provider and ADB exceptions may contain credentials or private fixture data.
    throw new Error("Real Android provider renewal failed during " + stage + ".");
  }
}
