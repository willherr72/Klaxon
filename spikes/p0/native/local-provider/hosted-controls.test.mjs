import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { withHostedProviderScenario } from "./hosted-controls.mjs";

const origin = "https://fixture-test.convex.cloud";
const accounts = {
  a: { username: "fixture-a", password: "inert-a" },
  b: { username: "fixture-b", password: "inert-b" },
};

function scriptedControls(t, { occupied = false, lostCreate = false, sharedOwner = false, failedRevocation,
  edgeUnavailable = false, unauthorizedAfterRevocation = false } = {}) {
  const calls = [];
  const sessions = new Map();
  let task;
  t.mock.method(globalThis, "fetch", async (url, { body, headers, redirect }) => {
    assert.equal(new URL(url).origin, origin);
    assert.equal(redirect, "error");
    const { path, args: [args] } = JSON.parse(body);
    calls.push(path);
    const bearer = new Headers(headers).get("authorization")?.replace(/^Bearer /i, "");
    const session = sessions.get(bearer);
    const active = session && !session.revoked;
    let value;
    switch (path) {
      case "auth:signInWithUsernamePassword": {
        assert.equal(bearer, undefined);
        const account = Object.values(accounts).find(account => account.username === args.username);
        assert.deepEqual(args, account);
        const userId = account === accounts.a || sharedOwner ? "owner-a" : "owner-b";
        const accessToken = "access-" + (sessions.size + 1);
        const refreshToken = "refresh-" + (sessions.size + 1);
        sessions.set(accessToken, { userId, refreshToken, revoked: false });
        value = { status: "complete", tokens: { accessToken, refreshToken, userId } };
        break;
      }
      case "auth:isAuthenticated":
        if (unauthorizedAfterRevocation && session?.revoked) return Response.json({}, { status: 401 });
        value = Boolean(active);
        break;
      case "tasks:list":
        value = active && session.userId === "owner-a" ?
          task ? [task] : occupied ? [{ _id: "preexisting", title: "other task" }] : [] : [];
        break;
      case "tasks:create":
        assert.ok(active && session.userId === "owner-a");
        assert.equal(task, undefined);
        task = { _id: "fresh-task", owner: session.userId, title: args.title };
        if (lostCreate) throw Error("private response details");
        value = task._id;
        break;
      case "auth:signOut": {
        assert.equal(bearer, undefined);
        if (args.refreshToken === failedRevocation) throw Error("private revocation details");
        const grant = [...sessions.values()].find(grant => grant.refreshToken === args.refreshToken);
        assert.ok(grant);
        grant.revoked = true;
        value = null;
        break;
      }
      case "auth:refreshSession": {
        assert.equal(bearer, undefined);
        const grant = [...sessions.values()].find(grant => grant.refreshToken === args.refreshToken);
        assert.ok(grant?.revoked);
        value = { kind: "noSession" };
        break;
      }
      default:
        assert.fail("Unexpected fixture operation " + path);
    }
    return Response.json({ status: "success", value });
  });
  let edgeClosed = false;
  let edgeBearer;
  const observed = [];
  t.mock.method(chromium, "launch", async ({ channel }) => {
    assert.equal(channel, "msedge");
    if (edgeUnavailable) throw Error("private browser startup details");
    let websocket;
    return {
      newPage: async () => ({
        on: (event, handler) => {
          assert.equal(event, "websocket");
          websocket = handler;
        },
        goto: async url => assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/),
        evaluate: async (start, [selectedOrigin, bearer]) => {
          assert.equal(selectedOrigin, origin);
          assert.equal(bearer, "access-3");
          edgeBearer = bearer;
          websocket({ url: () => "wss://fixture-test.convex.cloud/api/1.51.0/sync" });
        },
        waitForFunction: async (_predicate, expected) => {
          assert.equal(edgeBearer, "access-3");
          if (expected === null) {
            assert.equal(task, undefined);
          } else {
            const [id, title] = expected;
            assert.equal(id, task._id);
            observed.push(title);
          }
        },
      }),
      close: async () => { edgeClosed = true; },
    };
  });
  return { calls, sessions, observed, edgeClosed: () => edgeClosed };
}

test("pins the hosted origin before performing any work", async t => {
  const fixture = scriptedControls(t);
  for (const url of ["http://fixture-test.convex.cloud", origin + "/", origin + ".invalid",
    origin + "@different.convex.cloud", origin + ":443"]) {
    await assert.rejects(withHostedProviderScenario(url, accounts, assert.fail), /origin/i);
  }
  assert.deepEqual(fixture.calls, []);
});

test("verifies sign-out when hosted HTTP rejects the old bearer with 401", async t => {
  const fixture = scriptedControls(t, { unauthorizedAfterRevocation: true });
  const result = await withHostedProviderScenario(origin, accounts, async () => ({ status: "passed" }));
  assert.equal(result.fixtureCleanup.controlSessionsRevoked, 3);
  assert.equal(fixture.calls.filter(call => call === "auth:refreshSession").length, 3);
});

test("preflights distinct empty owners and tracks the separate Edge grant", async t => {
  const fixture = scriptedControls(t);
  const result = await withHostedProviderScenario(origin, accounts, async controls => {
    assert.deepEqual(controls.input, { ...accounts.a, owner: "owner-a" });
    assert.equal(controls.control.url, origin);
    assert.equal(controls.stranger.url, origin);
    assert.equal(controls.taskId, "fresh-task");
    assert.notEqual(controls.title, controls.updatedTitle);
    assert.deepEqual(fixture.observed, [controls.title]);
    return { status: "passed" };
  });
  assert.deepEqual(result, { status: "passed", fixtureCleanup: {
    knownControlSessions: 3, controlSessionsRevoked: 3, task: "retained-no-scoped-delete",
  } });
  assert.equal(fixture.edgeClosed(), true);
  assert.ok([...fixture.sessions.values()].every(session => session.revoked));
  assert.equal(fixture.calls.filter(call => call === "tasks:create").length, 1);
});

for (const [condition, options] of [["an occupied owner", { occupied: true }],
  ["an aliased owner", { sharedOwner: true }]]) {
  test("does not create a task for " + condition, async t => {
    const fixture = scriptedControls(t, options);
    await assert.rejects(withHostedProviderScenario(origin, accounts, assert.fail), error => {
      assert.deepEqual(error.fixtureCleanup, {
        knownControlSessions: 2, controlSessionsRevoked: 2, task: "not-created",
      });
      return true;
    });
    assert.equal(fixture.calls.includes("tasks:create"), false);
  });
}

test("leaves the fixture empty when the Edge control cannot start", async t => {
  const fixture = scriptedControls(t, { edgeUnavailable: true });
  await assert.rejects(withHostedProviderScenario(origin, accounts, assert.fail), error => {
    assert.deepEqual(error.fixtureCleanup, {
      knownControlSessions: 3, controlSessionsRevoked: 3, task: "not-created",
    });
    return true;
  });
  assert.equal(fixture.calls.includes("tasks:create"), false);
});

test("never retries a create with an ambiguous response", async t => {
  const fixture = scriptedControls(t, { lostCreate: true });
  await assert.rejects(withHostedProviderScenario(origin, accounts, assert.fail), error => {
    assert.match(error.message, /create/i);
    assert.doesNotMatch(error.stack, /private response details/);
    assert.equal(error.fixtureCleanup.task, "creation-unconfirmed");
    assert.equal(error.fixtureCleanup.controlSessionsRevoked, 3);
    return true;
  });
  assert.equal(fixture.calls.filter(call => call === "tasks:create").length, 1);
});

test("reports failing revocation without leaking exercise or provider errors", async t => {
  const fixture = scriptedControls(t, { failedRevocation: "refresh-2" });
  await assert.rejects(withHostedProviderScenario(origin, accounts, async () => {
    throw Error("private exercise details");
  }), error => {
    assert.match(error.message, /lifecycle/);
    assert.doesNotMatch(error.stack, /private .* details/);
    assert.deepEqual(error.fixtureCleanup, {
      knownControlSessions: 3, controlSessionsRevoked: 2, task: "retained-no-scoped-delete",
    });
    return true;
  });
  assert.equal(fixture.edgeClosed(), true);
});
