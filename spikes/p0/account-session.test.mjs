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
async function client(t, respond) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  const authenticating = Promise.withResolvers();
  const errors = [];
  let logins = 0;
  await context.routeWebSocket(/.*/, socket => {
    socket.onMessage(data => {
      const message = JSON.parse(data);
      if (message.type === "Authenticate") authenticating.resolve(() => socket.send(JSON.stringify({
        type: "AuthError", baseVersion: message.baseVersion, authUpdateAttempted: true, error: "TEST_EXPIRED",
      })));
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
  return { page, login, errors, rejectSocketToken: async () => (await authenticating.promise)() };
}

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
