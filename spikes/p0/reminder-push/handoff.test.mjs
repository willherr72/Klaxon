import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateRequestDetails } from "web-push";
import { dispatchOnce, mockInput } from "./sender.mjs";
import { handlePush } from "./receiver/fixture.mjs";

test("the two sender payloads reach the matching mock workers independently of provider acceptance", async t => {
  const runDirectory = await mkdtemp(join(tmpdir(), "klaxon-p0-reminder-handoff-"));
  t.after(() => rm(runDirectory, { recursive: true, force: true }));
  const queued = [];
  // Public, deterministic test scalars only. No key is provisioned or saved.
  const publicPoint = scalar => {
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(Buffer.from([scalar]));
    return curve.getPublicKey().toString("base64url");
  };
  const input = mockInput();
  const dummyScalar = Buffer.alloc(32);
  dummyScalar[31] = 1;
  input.vapidDetails.privateKey = dummyScalar.toString("base64url");
  input.vapidDetails.publicKey = publicPoint(1);
  for (const [index, sub] of Object.values(input.subscriptions).entries()) {
    sub.keys = { p256dh: publicPoint(2 + index), auth: Buffer.alloc(16, index).toString("base64url") };
  }
  const report = await dispatchOnce({
    input, runDirectory, rehearsal: true,
    prepareNotification(subscription, wirePayload, options) {
      // Use the pinned library's offline request builder; no HTTP transport exists in this test.
      const request = generateRequestDetails(subscription, wirePayload, options);
      assert.equal(request.endpoint, subscription.endpoint);
      assert.equal(request.headers["Content-Encoding"], "aes128gcm");
      assert.ok(request.headers.Authorization.startsWith("vapid "));
      assert.ok(Buffer.isBuffer(request.body) && !request.body.includes(Buffer.from(wirePayload)));
    },
    async sendNotification(_subscription, wirePayload) {
      queued.push(JSON.parse(wirePayload));
      return { statusCode: 201 };
    },
  });
  assert.deepEqual(queued.map(message => message.target).sort(), ["android-chrome", "windows-edge"]);
  assert.equal(new Set(queued.map(message => message.occurrenceId)).size, 1);
  for (const message of queued) {
    const rows = new Map();
    const displays = [];
    const worker = {
      target: message.target,
      scope: "https://receiver.invalid/p0/",
      caches: { async open() {
        return { async put(key, value) { rows.set(key, await value.json()); } };
      } },
      async showNotification(title, options) {
        displays.push({ title, body: options.body });
        if (message.target === "android-chrome") throw new Error("simulated display rejection");
      },
    };
    await handlePush(message, worker);
    assert.deepEqual(displays, [{ title: "Klaxon P0 test", body: message.target + " " + report.occurrenceId }]);
    assert.equal(rows.size, 1);
    const [receipt] = rows.values();
    assert.equal(receipt.occurrenceId, report.occurrenceId);
    assert.equal(receipt.target, message.target);
    assert.equal(receipt.displayRequest, message.target === "android-chrome" ? "rejected" : "resolved");
    const attempt = report.targets.find(result => result.target === message.target);
    assert.equal(attempt.transportStatus, "accepted");
    assert.equal(attempt.workerReceipt, "unobserved");
    assert.equal(attempt.visibleReceipt, "unobserved");
  }
});
