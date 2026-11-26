import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as provision from "./hosted-provision.mjs";

const origin = "https://fixture.convex.cloud";
const key = "dev:fixture|dummy-key-material";
const retirement = {
  ownersRetired: 2, sessionsRevoked: 0, tasksDeleted: 1, usernamesDeleted: 2, usersDeleted: 2,
  passwordRowsRetained: 2, authUserIdRowsRetained: 2,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function fixture(t, { enroll, retire, keyContents = key } = {}) {
  const tempRoot = await mkdtemp(join(await realpath(tmpdir()), "klaxon-hosted-provision-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const keyFile = join(tempRoot, "dummy-key.txt");
  await writeFile(keyFile, `${keyContents}\n`);
  const events = [];
  const enrollments = [];
  const dependencies = {
      tempRoot,
      createAdminClient(clientOrigin) {
        assert.equal(clientOrigin, origin);
        events.push("create admin");
        return {
          setAdminAuth(adminKey) {
            assert.equal(adminKey, key);
            events.push("authorize");
          },
          async function(name, componentPath, args) {
            assert.equal(componentPath, undefined);
            if (name === "authFixtures:enrollDisposable") {
              events.push("enroll");
              assert.match(args.runId, uuid);
              assert.match(args.password, uuid);
              const suffix = enrollments.length === 0 ? "a" : "b";
              assert.equal(args.username, `p0-hosted-${args.runId}-${suffix}`);
              enrollments.push(args);
              return enroll ? enroll(args, suffix) : `owner-${suffix}`;
            }
            assert.equal(name, "authFixtures:retireDisposable");
            events.push("retire");
            assert.deepEqual(args, { runId: enrollments[0].runId });
            return retire ? retire() : retirement;
          },
          clearAuth() { events.push("clear auth"); },
        };
      },
  };
  const call = action => provision.withHostedFixtureAccounts({ origin, keyFile }, action, dependencies);
  const retry = retirementReceipt => provision.retryHostedFixtureRetirement({ origin, keyFile, retirementReceipt }, dependencies);
  async function receiptFile() {
    const entries = (await readdir(tempRoot)).filter(entry => entry !== "dummy-key.txt");
    assert.equal(entries.length, 1);
    assert.match(entries[0], /^klaxon-p0-hosted-[a-z0-9]{6}$/i);
    const directory = join(tempRoot, entries[0]);
    assert.deepEqual(await readdir(directory), ["retirement.json"]);
    return join(directory, "retirement.json");
  }
  return { call, retry, enrollments, events, receiptFile, tempRoot };
}

test("receipts precede enrollment and the shared action receives two accounts in memory", async t => {
  const run = await fixture(t, {
    async enroll({ runId }, suffix) {
      assert.deepEqual(JSON.parse(await readFile(await run.receiptFile(), "utf8")), { origin, runId });
      return `owner-${suffix}`;
    },
    retire: () => ({ ...retirement, unexpected: "remote payload" }),
  });

  const result = await run.call(async (...args) => {
    run.events.push("action");
    await run.receiptFile();
    const [a, b] = run.enrollments.map(({ username, password }, index) =>
      ({ username, password, owner: index === 0 ? "owner-a" : "owner-b" }));
    assert.notEqual(a.password, b.password);
    assert.deepEqual(args, [{ a, b }]);
    return { observed: true };
  });

  assert.deepEqual(result, { evidence: { observed: true }, retirement });
  assert.deepEqual(run.events, ["create admin", "authorize", "enroll", "enroll", "action", "retire", "clear auth"]);
  assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
});

test("a lost first enrollment acknowledgement retires the run without handing off credentials", async t => {
  const run = await fixture(t, {
    enroll() { throw new Error("remote details include dummy-key-material"); },
    retire: () => ({
      ...retirement, ownersRetired: 1, usersDeleted: 1, usernamesDeleted: 1, tasksDeleted: 0,
      passwordRowsRetained: 1, authUserIdRowsRetained: 1,
    }),
  });

  await assert.rejects(run.call(() => assert.fail("Action ran without two acknowledgements")), error => {
    assert.match(error.message, /hosted fixture enrollment failed/i);
    assert.doesNotMatch(error.stack, /dummy-key-material/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(run.events, ["create admin", "authorize", "enroll", "retire", "clear auth"]);
  assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
});

for (const [description, owner] of [
  ["a missing", undefined],
  ["an empty", ""],
  ["a duplicate", "owner-a"],
]) {
  test(`${description} second owner acknowledgement retires the run without handing off credentials`, async t => {
    const run = await fixture(t, { enroll: (_args, suffix) => suffix === "a" ? "owner-a" : owner });
    let actionRan = false;
    await assert.rejects(run.call(() => { actionRan = true; }), /hosted fixture enrollment failed/i);
    assert.equal(actionRan, false);
    assert.deepEqual(run.events, ["create admin", "authorize", "enroll", "enroll", "retire", "clear auth"]);
    assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
  });
}

test("retirement runs before propagating a failed action", async t => {
  const run = await fixture(t);
  const failure = new Error("action failed");
  await assert.rejects(run.call(() => {
    run.events.push("action");
    throw failure;
  }), error => error === failure);
  assert.deepEqual(run.events, ["create admin", "authorize", "enroll", "enroll", "action", "retire", "clear auth"]);
  assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
});

for (const [description, retire] of [
  ["a lost retirement acknowledgement", () => { throw new Error("remote dummy-key-material"); }],
  ["a malformed retirement acknowledgement", () => ({ ...retirement, usernamesDeleted: -1 })],
]) {
  test(`${description} preserves the nonsecret retry receipt`, async t => {
    const run = await fixture(t, { retire });
    let retryPath;
    await assert.rejects(run.call(() => { throw new Error("callback dummy-password"); }), error => {
      assert.match(error.message, /retirement unconfirmed/i);
      assert.doesNotMatch(error.stack, /dummy-key-material|dummy-password/);
      assert.equal(error.cause, undefined);
      retryPath = error.retirementReceipt;
      return true;
    });
    const receiptFile = await run.receiptFile();
    assert.equal(retryPath, receiptFile);
    assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")), {
      origin, runId: run.enrollments[0].runId, expected: { minOwners: 2, complete: false },
    });
    assert.deepEqual(run.events, ["create admin", "authorize", "enroll", "enroll", "retire", "clear auth"]);
  });
}

test("an inconsistent retirement keeps the completed-run requirements for retry", async t => {
  let response = { ...retirement, tasksDeleted: 0 };
  const run = await fixture(t, { retire: () => response });
  let receipt;
  await assert.rejects(run.call(() => ({ observed: true })), error => {
    receipt = error.retirementReceipt;
    return Boolean(receipt);
  });
  assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")).expected, { minOwners: 2, complete: true });
  await assert.rejects(run.retry(receipt), error => error.retirementReceipt === receipt);
  assert.equal(await run.receiptFile(), receipt);
  response = retirement;
  assert.deepEqual(await run.retry(receipt), retirement);
  assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
});

test("a lost second enrollment response cannot retire fewer than the confirmed owner count", async t => {
  const zeroCounts = Object.fromEntries(Object.keys(retirement).map(field => [field, 0]));
  const run = await fixture(t, {
    enroll(_args, suffix) {
      if (suffix === "b") throw Error("second enrollment reply lost");
      return "owner-a";
    },
    retire: () => zeroCounts,
  });
  await assert.rejects(run.call(assert.fail), error => Boolean(error.retirementReceipt));
  assert.deepEqual(JSON.parse(await readFile(await run.receiptFile(), "utf8")).expected,
    { minOwners: 1, complete: false });
});

test("HTTP 202 with successful-looking retirement counts keeps the retry receipt", async t => {
  const tempRoot = await mkdtemp(join(await realpath(tmpdir()), "klaxon-hosted-provision-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const keyFile = join(tempRoot, "dummy-key.txt");
  await writeFile(keyFile, key);
  let enrollments = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.redirect, "error");
    const { path } = JSON.parse(options.body);
    if (path === "authFixtures:enrollDisposable") {
      enrollments++;
      return Response.json({ status: "success", value: "owner-" + enrollments });
    }
    assert.equal(path, "authFixtures:retireDisposable");
    return Response.json({ status: "success", value: retirement }, { status: 202 });
  });
  await assert.rejects(provision.withHostedFixtureAccounts({ origin, keyFile }, () => ({ observed: true }),
    { tempRoot }), error => Boolean(error.retirementReceipt));
  assert.equal(enrollments, 2);
});

test("a key for a different deployment never initializes the admin client", async t => {
  const run = await fixture(t, { keyContents: "dev:other|dummy-key-material" });
  await assert.rejects(run.call(() => assert.fail("Action ran with the wrong key")), error => {
    assert.match(error.message, /development key/i);
    assert.doesNotMatch(error.stack, /dummy-key-material/);
    return true;
  });
  assert.deepEqual(run.events, []);
  assert.deepEqual(await readdir(run.tempRoot), ["dummy-key.txt"]);
});
