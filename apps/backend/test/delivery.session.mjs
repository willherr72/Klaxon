import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { withLocalProvider } from "./provider.local.mjs";

function keyPair() {
  const pair = createECDH("prime256v1");
  const publicKey = pair.generateKeys().toString("base64url");
  const privateKey = Buffer.alloc(32);
  const scalar = pair.getPrivateKey();
  scalar.copy(privateKey, 32 - scalar.length);
  return { publicKey, privateKey: privateKey.toString("base64url") };
}

// Report only known error codes. Raw provider errors can contain fixture inputs.
async function call(label, request, expectedError) {
  let result;
  let errorCode;
  try {
    result = await request();
  } catch (error) {
    const code = error?.data?.code;
    errorCode = ["INVALID_SUBSCRIPTION", "DELIVERY_UNAVAILABLE", "SUBSCRIPTION_IN_USE",
      "DELIVERY_NOT_ENABLED", "REVISION_CONFLICT"].includes(code) ? code : "unclassified provider error";
  }
  assert.equal(errorCode, expectedError, label);
  return result;
}

test("pinned Convex runtime enrolls, replays and revokes Web Push", { timeout: 180_000 }, async () => {
  await withLocalProvider(async ({ url, adminKey }) => {
    const vapid = keyPair();
    const variables = {
      ENABLED: "true",
      STORAGE_KEY: randomBytes(32).toString("base64url"),
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: "mailto:fixture@example.invalid",
    };
    await call("set fixture environment", async () => {
      const response = await fetch(new URL("/api/update_environment_variables", url), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: "Convex " + adminKey, "Content-Type": "application/json" },
        body: JSON.stringify({ changes: Object.entries(variables).map(([name, value]) =>
          ({ name: "KLAXON_WEB_PUSH_" + name, value })) }),
      });
      assert.ok(response.ok);
    });

    const admin = new ConvexHttpClient(url, { logger: false });
    admin.setAdminAuth(adminKey);
    const anonymous = new ConvexHttpClient(url, { logger: false });
    const credentials = { username: "push-" + randomUUID(), password: randomBytes(24).toString("base64url") };
    await call("enroll user", () => admin.function("auth:enrollWithUsernamePassword", undefined, credentials));
    const session = await call("sign in", () => anonymous.mutation(ref("auth:signInWithUsernamePassword"), credentials));
    assert.ok(session.status === "complete");
    const client = new ConvexHttpClient(url, { auth: session.tokens.accessToken, logger: false });
    const mutate = (name, args, expectedError) => call(name, () => client.mutation(ref(name), args), expectedError);
    try {
      const workspace = await mutate("workspaces:ensurePersonal", {});
      const scope = { workspaceId: workspace._id };
      const device = { ...scope, deviceId: randomUUID() };
      const change = expectedRevision => ({ expectedRevision, operationId: randomUUID() });
      const status = () => call("delivery status", () => client.query(ref("delivery:status"), device));
      const initial = await status();
      assert.ok(initial.available && initial.publicKey === vapid.publicKey);
      assert.equal(initial.enabled, false);
      const grant = await mutate("delivery:setEnabled", { ...scope, ...change(0), enabled: true });

      // This randomized path never represented a real FCM subscription. The fixture creates no reminder.
      const request = { ...device, ...change(0), permission: "granted", subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/fixture-" + randomUUID(),
        keys: { p256dh: keyPair().publicKey, auth: randomBytes(16).toString("base64url") },
      } };
      const offCurve = Buffer.alloc(65);
      offCurve[0] = 4;
      await mutate("delivery:register", { ...request, subscription: { ...request.subscription,
        keys: { ...request.subscription.keys, p256dh: offCurve.toString("base64url") } } }, "INVALID_SUBSCRIPTION");
      const enrolled = await mutate("delivery:register", request);
      assert.deepEqual(await mutate("delivery:register", request), enrolled);
      const current = await status();
      assert.equal(current.enabled, true);
      assert.equal(current.device?.active, true);
      assert.equal(current.device?.revision, enrolled.revision);

      // A new operation with the same subscription must decrypt the saved envelope to stay at this revision.
      const unchanged = await mutate("delivery:register", { ...request, ...change(enrolled.revision) });
      assert.equal(unchanged.revision, enrolled.revision);
      await mutate("delivery:register", { ...request, deviceId: randomUUID(), ...change(0) }, "SUBSCRIPTION_IN_USE");

      await mutate("delivery:revoke", { ...device, ...change(enrolled.revision) });
      assert.equal((await status()).device?.active, false);
      await mutate("delivery:setEnabled", { ...scope, ...change(grant.revision), enabled: false });
      assert.equal((await status()).enabled, false);
    } finally {
      await call("sign out", () => anonymous.mutation(ref("auth:signOut"), { refreshToken: session.tokens.refreshToken }));
    }
  });
});
