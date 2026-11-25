import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright-core";

const origin = "https://synthetic-session-test.convex.cloud";
let browser, directory, artifact;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "klaxon-session-"));
  await promisify(execFile)(process.execPath, ["build-portable.mjs", "--outdir", directory], {
    env: { ...process.env, P0_PUBLIC_DEV_ORIGIN: origin },
  });
  artifact = pathToFileURL(join(directory, "index.html")).href;
  const executablePath = process.env.P0_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } :
    process.platform === "win32" ? { channel: "msedge" } : {});
});
after(async () => {
  await browser?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function tokenBundle(accessToken, refreshToken, userId = "synthetic-owner-1") {
  return { accessToken, refreshToken, refreshTokenExpiresAt: 2_000_000_000_000, userId };
}

// The page runs the bundled Convex SDK. Only the cloud transport is replaced.
async function client(t, respond, onSocketMessage) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  const authenticating = Promise.withResolvers();
  const socketReopened = Promise.withResolvers();
  let connections = 0;
  const errors = [];
  let logins = 0;
  await context.routeWebSocket(/.*/, socket => {
    if (++connections === 2) socketReopened.resolve();
    const transition = socketTransition(socket);
    socket.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === "Authenticate") authenticating.resolve(() => socket.send(JSON.stringify({
        type: "AuthError", baseVersion: message.baseVersion, authUpdateAttempted: true, error: "TEST_EXPIRED",
      })));
      onSocketMessage?.(message, socket, transition);
    });
  });
  await context.route(/^https?:/i, async route => {
    const req = route.request();
    if (!req.url().startsWith(origin + "/api/")) return route.abort("blockedbyclient");
    const { path } = req.postDataJSON();
    const success = value => route.fulfill({ json: { status: "success", value } });
    if (path === "auth:signInWithUsernamePassword") {
      ++logins;
      const tokens = tokenBundle(`access-${logins}`, `refresh-${logins}`, `synthetic-owner-${logins}`);
      await success({ status: "complete", tokens });
    } else {
      await respond(path, route, success);
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4500);
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(artifact);
  async function login(username) {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill("only-a-test");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Read tasks" }).waitFor();
  }
  return { page, login, errors, socketReopened: socketReopened.promise,
    rejectSocketToken: async () => (await authenticating.promise)() };
}

function socketTransition(socket) {
  // Convex sync timestamps are base64-encoded little-endian uint64s.
  const bytes = Buffer.alloc(8);
  let tick = 0n;
  let version = { querySet: 0, identity: 0, ts: bytes.toString("base64") };
  return (changes, modifications = []) => {
    const startVersion = version;
    bytes.writeBigUInt64LE(++tick);
    version = { ...version, ...changes, ts: bytes.toString("base64") };
    socket.send(JSON.stringify({ type: "Transition", startVersion, endVersion: version, modifications }));
  };
}

function updatedTask(queryId, row) {
  return { type: "QueryUpdated", queryId, value: [row], logLines: [], journal: null };
}

test("reloading after an authenticated read requires sign-in and clears the account view", async t => {
  const row = { _id: "test-row", title: "Transient task" };
  const { page, login } = await client(t, async (path, route, success) => {
    assert.equal(path, "tasks:list");
    await success([row]);
  });
  await login("synthetic-a");
  await page.getByRole("button", { name: "Read tasks" }).click();
  await page.getByRole("listitem").getByText(row.title).waitFor();
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(await page.context().cookies(), []);

  await page.reload();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(await page.getByLabel("Password").inputValue(), "");
  assert.equal(await page.getByText(row.title).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Read tasks" }).count(), 0);
});

test("a transport failure during SDK token refresh returns the user to sign-in", { timeout: 20000 }, async t => {
  const { page, login, errors, rejectSocketToken } = await client(t, async (path, route) => {
    assert.equal(path, "auth:refreshSession");
    await route.abort("connectionfailed");
  });
  await login("synthetic-a");
  await rejectSocketToken();
  await page.getByRole("alert").getByText(/reconnect and sign in/i).waitFor();
  await login("synthetic-b");
  assert.deepEqual(errors, []);
});

test("a read finishing after expiry cannot expose the previous account's rows", { timeout: 20000 }, async t => {
  const readStarted = Promise.withResolvers();
  const finishRead = Promise.withResolvers();
  t.after(() => finishRead.resolve());
  const { page, login, rejectSocketToken } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") return success({ kind: "noSession" });
    assert.equal(path, "tasks:list");
    readStarted.resolve();
    await finishRead.promise;
    await success([{ _id: "old-id", title: "Previous synthetic account" }]);
  });
  await login("synthetic-a");
  await page.getByRole("button", { name: "Read tasks" }).click();
  await readStarted.promise;
  await rejectSocketToken();
  await page.getByRole("alert").getByText(/expired/i).waitFor();
  await login("synthetic-b");
  const received = page.waitForResponse(res => res.url().endsWith("/api/query"));
  finishRead.resolve();
  await (await received).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText("Previous synthetic account").count(), 0);
  await page.getByText("Waiting for tasks.").waitFor();
});

for (const source of ["subscription", "HTTP", "continuously changing subscription"]) {
  test("a manual read overlapping a subscription reconciles the latest " + source + " rows",
    { timeout: 20000 }, t => checkOverlappingRead(t, source));
}

async function checkOverlappingRead(t, source) {
  const oldRow = { _id: "test-row", title: "Original task title" };
  const newRow = { ...oldRow, title: "Updated task title" };
  const latest = source === "subscription" ? newRow : { ...oldRow, title: "Latest HTTP title" };
  let rotations = 0;
  let reads = 0;
  const readStarted = Promise.withResolvers();
  const finishRead = Promise.withResolvers();
  const followupStarted = Promise.withResolvers();
  const finishFollowup = Promise.withResolvers();
  const subscribed = Promise.withResolvers();
  t.after(() => finishRead.resolve());
  t.after(() => finishFollowup.resolve());

  const { page, login, errors } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") {
      // The SDK checks for a fresh token immediately after confirming the cached token.
      return success({ kind: "rotated", tokens: tokenBundle("access-1", `rotated-refresh-${++rotations}`) });
    }
    assert.equal(path, "tasks:list");
    assert.equal(route.request().headers().authorization, "Bearer access-1");
    if (++reads === 2) {
      followupStarted.resolve();
      if (source === "continuously changing subscription") await finishFollowup.promise;
      return success([source === "continuously changing subscription" ? newRow : latest]);
    }
    readStarted.resolve();
    await finishRead.promise;
    await success([source === "subscription" ? oldRow : latest]);
  }, (message, _socket, transition) => {
    if (message.type === "Authenticate") {
      transition({ identity: message.baseVersion + 1 });
    }
    if (message.type === "ModifyQuerySet") {
      const query = message.modifications.find(mod => mod.type === "Add" && mod.udfPath === "tasks:list");
      assert.ok(query, "expected the task subscription");
      transition({ querySet: message.newVersion }, [updatedTask(query.queryId, oldRow)]);
      subscribed.resolve(row => transition({}, [updatedTask(query.queryId, row)]));
    }
  });

  await login("synthetic-a");
  await page.getByText("Subscription connected", { exact: true }).waitFor();
  const tasks = page.getByRole("list", { name: "Synthetic tasks" });
  await tasks.getByText(oldRow.title, { exact: true }).waitFor();
  const read = page.getByRole("button", { name: "Read tasks" });
  await read.click();
  await readStarted.promise;
  (await subscribed.promise)(newRow);
  await tasks.getByText(newRow.title, { exact: true }).waitFor();

  finishRead.resolve();
  let notice = "Read from the server.";
  if (source === "continuously changing subscription") {
    await followupStarted.promise;
    (await subscribed.promise)(latest);
    await tasks.getByText(latest.title, { exact: true }).waitFor();
    finishFollowup.resolve();
    notice = "Tasks changed during both reads. Showing subscription updates.";
  }
  await page.getByRole("status").getByText(notice).waitFor();
  assert.equal(await tasks.locator("strong").textContent(), latest.title);
  assert.equal(reads, 2);
  assert.deepEqual(errors, []);
}

for (const source of ["subscription", "manual read"]) {
  test(`reopened transport keeps stale tasks read-only until a fresh ${source} result`,
    { timeout: 20000 }, t => checkReconnect(t, source));
}

test("browser network recovery needs a fresh read while the subscription stays open",
  { timeout: 20000 }, t => checkReconnect(t, "browser network"));

async function checkReconnect(t, source) {
  const oldRow = { _id: "test-row", title: "Before the outage" };
  const browserNetwork = source === "browser network";
  const freshRow = browserNetwork ? oldRow : { ...oldRow, title: "After the outage" };
  const outdatedRow = { ...oldRow, title: "Read before the outage" };
  const resubscribed = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const finishOldRead = Promise.withResolvers();
  t.after(() => finishOldRead.resolve());
  const writes = [];
  let rotations = 0;
  let reads = 0;
  let firstSocket;
  let reconnected = false;

  const { page, login, errors } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") {
      return success({ kind: "rotated", tokens: tokenBundle("access-1", `rotated-refresh-${++rotations}`) });
    }
    if (path === "tasks:create" || path === "tasks:rename") {
      writes.push(path);
      return success(null);
    }
    assert.equal(path, "tasks:list");
    assert.notEqual(source, "subscription", "subscription recovery should issue no HTTP read");
    assert.equal(route.request().headers().authorization, "Bearer access-1");
    ++reads;
    if (source === "manual read" && reads === 1) {
      readStarted.resolve();
      await finishOldRead.promise;
      return success([outdatedRow]);
    }
    await success([freshRow]);
  }, (message, socket, transition) => {
    if (message.type === "Connect") {
      firstSocket ??= socket;
      reconnected = socket !== firstSocket;
    }
    if (message.type === "Authenticate") {
      transition({ identity: message.baseVersion + 1 });
    }
    if (message.type === "ModifyQuerySet") {
      const query = message.modifications.find(mod => mod.type === "Add" && mod.udfPath === "tasks:list");
      if (!query) return;
      const sendRows = row => transition({ querySet: message.newVersion }, [updatedTask(query.queryId, row)]);
      if (socket === firstSocket) sendRows(oldRow);
      else resubscribed.resolve(sendRows);
    }
  });

  await page.clock.install();
  await login("synthetic-a");
  await page.getByText("Subscription connected", { exact: true }).waitFor();
  const tasks = page.getByRole("list", { name: "Synthetic tasks" });
  await tasks.getByText(oldRow.title, { exact: true }).waitFor();
  const timestamp = page.locator("time");
  const lastReadAt = await timestamp.getAttribute("datetime");
  await page.getByLabel("Task title").fill("Pending draft");
  const create = page.getByRole("button", { name: "Create task" });
  const rename = tasks.getByRole("button", { name: "Rename" });
  const read = page.getByRole("button", { name: "Read tasks" });
  const stale = page.getByText(/^Last available rows/);
  async function assertReadOnly(message) {
    assert.deepEqual({
      lastAvailable: await stale.count(),
      createDisabled: await create.isDisabled(),
      renameDisabled: await rename.isDisabled(),
    }, { lastAvailable: 1, createDisabled: true, renameDisabled: true }, message);
  }
  assert.equal(await create.isEnabled(), true);
  assert.equal(await rename.isEnabled(), true);

  if (source === "manual read") {
    await read.click();
    await readStarted.promise;
  }

  if (browserNetwork) {
    await page.context().setOffline(true);
    await page.getByText("Browser network offline", { exact: true }).waitFor();
  } else {
    // Hold the retry timer so disconnection stays observable independently of reconnect jitter.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 1000);
    await firstSocket.close();
  }
  await page.getByText("Subscription disconnected", { exact: true }).waitFor();
  await assertReadOnly("The disconnected task list must stay read-only.");
  await create.evaluate(button => button.click());
  await rename.evaluate(button => button.click());
  assert.deepEqual(writes, []);

  let sendFreshRows;
  if (browserNetwork) {
    await page.context().setOffline(false);
    await page.getByText("Browser network online", { exact: true }).waitFor();
    assert.equal(reconnected, false);
  } else {
    await page.clock.resume();
    sendFreshRows = await resubscribed.promise;
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await tasks.locator("strong").textContent(), oldRow.title);
  await assertReadOnly("Cached tasks must stay read-only while fresh data is pending.");
  await create.evaluate(button => button.form.requestSubmit());

  if (source === "manual read") {
    finishOldRead.resolve();
    await page.getByRole("status").getByText("Connection changed during the read. Read tasks again.").waitFor();
    assert.equal(await tasks.locator("strong").textContent(), oldRow.title);
    assert.equal(await timestamp.getAttribute("datetime"), lastReadAt);
    await assertReadOnly("An interrupted read must leave cached tasks read-only.");
  }
  if (source === "subscription") {
    sendFreshRows(freshRow);
  } else {
    await read.click();
    await page.getByRole("status").getByText("Read from the server.").waitFor();
  }
  await tasks.getByText(freshRow.title, { exact: true }).waitFor();
  await page.getByText(/^Last read/).waitFor();
  assert.equal(await tasks.getByRole("listitem").getAttribute("data-task-id"), oldRow._id);
  assert.equal(await create.isEnabled(), true);
  assert.equal(await rename.isEnabled(), true);
  assert.equal(reads, source === "subscription" ? 0 : source === "manual read" ? 2 : 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
}

for (const [failure, response] of [
  ["an unknown outcome", { kind: "unknown" }],
  ["a malformed grant", { kind: "rotated", tokens: {
    ...tokenBundle("unaccepted-access", "unaccepted-refresh"), refreshTokenExpiresAt: "invalid-expiry",
  } }],
  ["a malformed no-session response", { kind: "noSession", unexpected: true }],
  ["a grant for a different owner", { kind: "rotated", tokens: tokenBundle(
    "unaccepted-access", "unaccepted-refresh", "synthetic-owner-2",
  ) }],
  ["a grant reusing the presented token", { kind: "rotated", tokens: tokenBundle("unaccepted-access", "refresh-1") }],
]) {
  test(`an explicit refresh keeps the same retry token after ${failure}`, { timeout: 30000 }, async t => {
    const presented = [];
    const authChecks = [];
    const socketTokens = [];
    const socketAuthenticating = Promise.withResolvers();
    const { page, login, errors } = await client(t, async (path, route, success) => {
      if (path === "auth:refreshSession") {
        presented.push(route.request().postDataJSON().args[0].refreshToken);
        return success(presented.length === 1 ? response : {
          kind: "rotated", tokens: tokenBundle("renewed-access", "renewed-refresh"),
        });
      }
      assert.equal(path, "auth:isAuthenticated");
      authChecks.push(route.request().headers().authorization);
      await success(true);
    }, message => {
      if (message.type === "Authenticate" && message.tokenType === "User") {
        socketTokens.push(message.value);
        socketAuthenticating.resolve();
      }
    });
    await login("synthetic-a");
    await socketAuthenticating.promise;
    assert.deepEqual(socketTokens, ["access-1"]);
    const refresh = page.getByRole("button", { name: "Refresh session" });
    await refresh.click();
    await page.getByRole("alert").getByText(/retry or sign out/i).waitFor();
    assert.deepEqual(authChecks, [], "an invalid response must not authorize an HTTP check");
    assert.equal(await page.getByText("Session refreshed.", { exact: true }).count(), 0);

    await refresh.click();
    await page.getByRole("status").getByText("Session refreshed.", { exact: true }).waitFor();
    assert.deepEqual(presented, ["refresh-1", "refresh-1"]);
    assert.deepEqual(authChecks, ["Bearer renewed-access"]);
    assert.equal(socketTokens.includes("unaccepted-access"), false);
    assert.deepEqual(errors, []);
  });
}

test("the SDK returns to sign-in when forced rotation names another owner", async t => {
  const socketTokens = [];
  const requests = [];
  const { page, login, rejectSocketToken, errors } = await client(t, async (path, route, success) => {
    requests.push(path);
    assert.equal(path, "auth:refreshSession");
    assert.deepEqual(route.request().postDataJSON().args, [{ refreshToken: "refresh-1" }]);
    await success({ kind: "rotated", tokens: tokenBundle("other-access", "other-refresh", "other-owner") });
  }, message => {
    if (message.type === "Authenticate" && message.value) socketTokens.push(message.value);
  });
  await login("synthetic-a");
  await rejectSocketToken();
  await page.getByRole("alert").getByText(/refresh could not be confirmed/i).waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.deepEqual(requests, ["auth:refreshSession"]);
  assert.deepEqual(socketTokens, ["access-1"]);
  assert.deepEqual(errors, []);
});

test("a definitive no-session response to explicit refresh clears the account view", async t => {
  const row = { _id: "test-row", title: "Cached task before expiration" };
  const { page, login, errors } = await client(t, async (path, route, success) => {
    if (path === "tasks:list") return success([row]);
    assert.equal(path, "auth:refreshSession");
    assert.deepEqual(route.request().postDataJSON().args, [{ refreshToken: "refresh-1" }]);
    await success({ kind: "noSession" });
  });
  await login("synthetic-a");
  await page.getByRole("button", { name: "Read tasks" }).click();
  await page.getByRole("listitem").getByText(row.title).waitFor();
  await page.getByRole("button", { name: "Refresh session" }).click();
  await page.getByRole("alert").getByText(/expired/i).waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(await page.getByText(row.title, { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Refresh session" }).count(), 0);
  assert.deepEqual(errors, []);
});

test("an invalid auth check after valid rotation leaves the successor available for retry", async t => {
  const presented = [];
  const authChecks = [];
  const { page, login, errors } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") {
      presented.push(route.request().postDataJSON().args[0].refreshToken);
      const attempt = presented.length;
      return success({ kind: "rotated", tokens: tokenBundle(`renewed-access-${attempt}`, `renewed-refresh-${attempt}`) });
    }
    assert.equal(path, "auth:isAuthenticated");
    authChecks.push(route.request().headers().authorization);
    await success(authChecks.length === 1 ? { authenticated: true } : true);
  });
  await login("synthetic-a");
  const refresh = page.getByRole("button", { name: "Refresh session" });
  await refresh.click();
  await page.getByRole("alert").getByText(/retry or sign out/i).waitFor();
  assert.equal(await page.getByText("Session refreshed.", { exact: true }).count(), 0);

  await refresh.click();
  await page.getByRole("status").getByText("Session refreshed.", { exact: true }).waitFor();
  assert.deepEqual(presented, ["refresh-1", "renewed-refresh-1"]);
  assert.deepEqual(authChecks, ["Bearer renewed-access-1", "Bearer renewed-access-2"]);
  assert.deepEqual(errors, []);
});

test("a negative auth check after explicit token rotation ends the session", async t => {
  const { page, login } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") return success({
      kind: "rotated", tokens: tokenBundle("renewed-a", "renewed-r"),
    });
    assert.equal(path, "auth:isAuthenticated");
    await success(false);
  });
  await login("synthetic-a");
  await page.getByRole("button", { name: "Refresh session" }).click();
  await page.getByRole("alert").getByText(/expired/i).waitFor();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Read tasks" }).count(), 0);
});

test("portable sign-out retains the refresh token until the provider acknowledges with null", async t => {
  const presented = [];
  const { page, login } = await client(t, async (path, route, success) => {
    assert.equal(path, "auth:signOut");
    presented.push(route.request().postDataJSON().args);
    await success(presented.length === 1 ? { unexpected: true } : null);
  });
  await login("synthetic-a");
  const signOut = page.getByRole("button", { name: "Sign out" });
  await signOut.click();
  await page.getByText(/sign-out could not be confirmed|signed out\./i).waitFor();
  assert.equal(await signOut.count(), 1, "a malformed success must leave sign-out retryable");
  await signOut.click();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.deepEqual(presented, [[{ refreshToken: "refresh-1" }], [{ refreshToken: "refresh-1" }]]);
});

test("socket auth loss during a failed revocation leaves sign-out retryable", { timeout: 20000 }, async t => {
  const revoking = Promise.withResolvers();
  const failRevocation = Promise.withResolvers();
  let attempts = 0;
  t.after(() => failRevocation.resolve());
  const { page, login, rejectSocketToken, socketReopened } = await client(t, async (path, route, success) => {
    assert.equal(path, "auth:signOut");
    if (++attempts > 1) return success(null);
    revoking.resolve();
    await failRevocation.promise;
    await route.abort("connectionfailed");
  });
  await login("synthetic-a");
  await page.getByRole("button", { name: "Sign out" }).click();
  await revoking.promise;
  await rejectSocketToken();
  // Convex closes and then reopens its socket after the null-token response.
  await socketReopened;
  failRevocation.resolve();
  await page.getByRole("alert").getByText(/sign-out could not be confirmed/i).waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(attempts, 2);
});

test("a refresh already in flight can fail during sign-out without dropping the revocation token", { timeout: 20000 }, async t => {
  const refreshing = Promise.withResolvers();
  const finishRefresh = Promise.withResolvers();
  t.after(() => finishRefresh.resolve());
  let revoked;
  const { page, login, rejectSocketToken } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") {
      refreshing.resolve();
      await finishRefresh.promise;
      return route.abort("connectionfailed");
    }
    assert.equal(path, "auth:signOut");
    revoked = route.request().postDataJSON().args[0].refreshToken;
    await success(null);
  });
  await login("synthetic-a");
  await rejectSocketToken();
  await refreshing.promise;
  await page.getByRole("button", { name: "Sign out" }).click();
  finishRefresh.resolve();
  await page.getByRole("alert").getByText(/sign-out could not be confirmed/i).waitFor();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor();
  assert.equal(revoked, "refresh-1");
});
