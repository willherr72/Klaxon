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
    socket.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === "Authenticate") authenticating.resolve(() => socket.send(JSON.stringify({
        type: "AuthError", baseVersion: message.baseVersion, authUpdateAttempted: true, error: "TEST_EXPIRED",
      })));
      onSocketMessage?.(message, socket);
    });
  });
  await context.route(/^https?:/i, async route => {
    const req = route.request();
    if (!req.url().startsWith(origin + "/api/")) return route.abort("blockedbyclient");
    const { path } = req.postDataJSON();
    const success = value => route.fulfill({ json: { status: "success", value } });
    if (path === "auth:signInWithUsernamePassword") {
      ++logins;
      await success({ status: "complete", tokens: { accessToken: "access-" + logins, refreshToken: "refresh-" + logins } });
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
  let reads = 0;
  const readStarted = Promise.withResolvers();
  const finishRead = Promise.withResolvers();
  const followupStarted = Promise.withResolvers();
  const finishFollowup = Promise.withResolvers();
  const subscribed = Promise.withResolvers();
  t.after(() => finishRead.resolve());
  t.after(() => finishFollowup.resolve());

  // Convex sync timestamps are base64-encoded little-endian uint64s.
  function timestamp(tick) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(tick));
    return bytes.toString("base64");
  }
  let tick = 0;
  let version = { querySet: 0, identity: 0, ts: timestamp(tick) };
  function transition(socket, changes, modifications = []) {
    const startVersion = version;
    version = { ...version, ...changes, ts: timestamp(++tick) };
    socket.send(JSON.stringify({ type: "Transition", startVersion, endVersion: version, modifications }));
  }

  const { page, login, errors } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") {
      // The SDK checks for a fresh token immediately after confirming the cached token.
      return success({ kind: "rotated", tokens: { accessToken: "access-1", refreshToken: "rotated-refresh" } });
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
  }, (message, socket) => {
    if (message.type === "Authenticate") {
      transition(socket, { identity: message.baseVersion + 1 });
    }
    if (message.type === "ModifyQuerySet") {
      const query = message.modifications.find(mod => mod.type === "Add" && mod.udfPath === "tasks:list");
      assert.ok(query, "expected the task subscription");
      const result = row => [{ type: "QueryUpdated", queryId: query.queryId, value: [row], logLines: [], journal: null }];
      transition(socket, { querySet: message.newVersion }, result(oldRow));
      subscribed.resolve(row => transition(socket, {}, result(row)));
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

test("a negative auth check after explicit token rotation ends the session", async t => {
  const { page, login } = await client(t, async (path, route, success) => {
    if (path === "auth:refreshSession") return success({ kind: "rotated", tokens: {
      accessToken: "renewed-a", refreshToken: "renewed-r",
    } });
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
