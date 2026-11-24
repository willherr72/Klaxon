import assert from "node:assert/strict";
import test from "node:test";
import { handlePush, publicKeyBytes, receiptCache, testSubscription } from "./receiver/fixture.mjs";

const scope = "https://fixture.invalid/p0/";
const target = "windows-edge";
const occurrenceId = "6f80fd1b-6542-42fe-81ba-f5bffdb56a3c";
const payload = { occurrenceId, revision: 1, target, title: "Klaxon P0 test", body: target + " " + occurrenceId };

function fixture() {
  const rows = new Map();
  const requests = [];
  const deps = { target, scope,
    caches: { async open(name) {
      assert.equal(name, receiptCache(scope));
      return { async put(key, value) {
        assert.ok(key.startsWith(scope + "receipt/"));
        rows.set(key, await value.json());
      } };
    } },
    async showNotification(title, options) {
      assert.ok([...rows.values()].some(r => r.displayRequest === "pending"));
      requests.push({ title, ...options });
    },
  };
  return { rows, requests, deps };
}

test("the worker entry records receipt before the fake display request and preserves duplicate observations", async () => {
  const { rows, requests, deps } = fixture();
  let push;
  const previous = globalThis.self;
  try {
    globalThis.self = { location: new URL("sw.mjs?target=windows-edge", scope),
      registration: { scope, showNotification: deps.showNotification }, caches: deps.caches,
      addEventListener(type, listener) { assert.equal(type, "push"); push = listener; } };
    await import("./receiver/sw.mjs");
    for (let i = 0; i < 2; i++) {
      let task;
      push({ data: { json: () => payload }, waitUntil(promise) { task = promise; } });
      assert.ok(task instanceof Promise);
      await task;
    }
    assert.doesNotThrow(() => push({ data: { json() { throw Error(); } } }));
  } finally {
    if (previous === undefined) delete globalThis.self;
    else globalThis.self = previous;
  }
  assert.equal(rows.size, 2);
  assert.deepEqual(requests, Array(2).fill({ title: payload.title, body: payload.body }));
  for (const receipt of rows.values()) {
    assert.equal(new Date(receipt.receivedAt).toISOString(), receipt.receivedAt);
    assert.deepEqual(receipt, { target, occurrenceId, receivedAt: receipt.receivedAt, displayRequest: "resolved" });
  }
});

test("the receiver preserves worker receipt if the simulated display request fails", async () => {
  const { rows, deps } = fixture();
  deps.showNotification = async () => { throw Error("mock rejection"); };
  await handlePush(payload, deps);
  assert.equal(rows.size, 1);
  assert.equal([...rows.values()][0].displayRequest, "rejected");
});

test("other targets, arbitrary text, unsupported revisions and malformed IDs produce no fixture evidence", async () => {
  const { rows, requests, deps } = fixture();
  for (const change of [{ target: "android-chrome" }, { title: "private text" }, { body: "replacement" },
    { revision: 2 }, { occurrenceId: "incomplete" }]) {
    await handlePush({ ...payload, ...change }, deps);
  }
  assert.equal(rows.size, 0);
  assert.equal(requests.length, 0);
});

test("subscription fixture uses the configured public key and reuses only the matching subscription", async () => {
  // Correct wire shape, inert coordinates. No key pair is created.
  const key = publicKeyBytes(Buffer.from([4, ...Array(64).fill(0)]).toString("base64url"));
  assert.throws(() => publicKeyBytes(""), /Missing disposable public key/);
  let current;
  let calls = 0;
  const registration = { pushManager: {
    async getSubscription() { return current; },
    async subscribe(options) {
      assert.deepEqual(options, { userVisibleOnly: true, applicationServerKey: key });
      calls++;
      current = { options };
      return current;
    },
  } };
  assert.equal(await testSubscription(registration, key), current);
  assert.equal(await testSubscription(registration, key), current);
  await assert.rejects(testSubscription(registration, key.with(2, 1)), /different key/);
  assert.equal(calls, 1);
});
