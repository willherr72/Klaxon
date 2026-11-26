import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { withLocalBackend } from "./native/local-provider/backend.mjs";

const origin = "http://127.0.0.1:3210";
const socketOrigin = "ws://127.0.0.1:3210";
const timeout = 10_000;
const tempPrefix = "klaxon-p0-renewal-";
const signInPath = "auth:signInWithUsernamePassword";
const refreshPath = "auth:refreshSession";
const signOutPath = "auth:signOut";
const tasksPath = "tasks:list";
let stage = "startup";

function client() {
  return new ConvexHttpClient(origin, {
    logger: false,
    fetch: (url, options) => {
      assert.ok(new URL(url).origin === origin);
      return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
    },
  });
}

async function withPortablePage(action) {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(join(parent, tempPrefix));
  let server, browser;
  try {
    stage = "portable build";
    await promisify(execFile)(process.execPath, ["build-portable.mjs", "--loopback-account", "--outdir", directory], {
      cwd: fileURLToPath(new URL("./", import.meta.url)), timeout: 30_000, windowsHide: true,
    });
    const html = await readFile(join(directory, "index.html"));
    server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
      } else response.writeHead(404).end();
    });
    stage = "portable listener and Edge";
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge", timeout: 30_000 });
    const page = await browser.newPage();
    page.setDefaultTimeout(timeout);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText("Convex account", { exact: true }).waitFor();
    return await action(page);
  } finally {
    try { await browser?.close(); }
    finally {
      try {
        if (server?.listening) await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        });
      } finally {
        const entry = await lstat(directory);
        assert.ok(dirname(directory) === parent && basename(directory).startsWith(tempPrefix) &&
          entry.isDirectory() && !entry.isSymbolicLink() && await realpath(directory) === directory);
        await rm(directory, { recursive: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
}

function callPath(request) {
  if (request.method() === "POST" && [`${origin}/api/mutation`, `${origin}/api/query`].includes(request.url())) {
    try { return request.postDataJSON()?.path; }
    catch { return undefined; }
  }
}

function socketFrame(payload) {
  try { return JSON.parse(payload.toString()); }
  catch { return undefined; }
}

function bearerHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function observe(page, grants) {
  const calls = [];
  const sockets = [];
  const replies = new WeakMap();
  const pendingGrants = [];
  page.on("request", request => {
    const path = callPath(request);
    if (path) calls.push({ path, at: performance.now(), wallTime: Date.now() });
  });
  page.on("response", response => {
    const path = callPath(response.request());
    if (path !== signInPath && path !== refreshPath) return;
    const value = response.json().then(body => {
      if (response.ok() && body.status === "success") {
        const token = body.value?.tokens?.refreshToken;
        if (typeof token === "string" && token) grants.add(token);
        return body.value;
      }
    }).catch(() => undefined);
    replies.set(response, value);
    pendingGrants.push(value);
  });
  page.on("websocket", socket => {
    if (new URL(socket.url()).origin !== socketOrigin) return;
    const seen = { auth: [], queries: [], identity: 0, rows: new Map(), closed: false };
    sockets.push(seen);
    socket.on("close", () => { seen.closed = true; });
    socket.on("framesent", ({ payload }) => {
      const frame = socketFrame(payload);
      if (frame?.type === "Authenticate" && frame.tokenType === "User" && typeof frame.value === "string") {
        seen.auth.push({ hash: bearerHash(frame.value), baseVersion: frame.baseVersion });
      }
      if (frame?.type === "ModifyQuerySet") seen.queries.push(...(frame.modifications ?? []));
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = socketFrame(payload);
      if (frame?.type !== "Transition") return;
      seen.identity = frame.endVersion?.identity;
      for (const change of frame.modifications ?? []) {
        if (change?.type === "QueryUpdated") seen.rows.set(change.queryId, change.value);
      }
    });
  });
  return {
    calls, sockets, replies,
    settleGrants: () => Promise.all(pendingGrants),
    response: (path, wait = timeout) => page.waitForResponse(
      response => callPath(response.request()) === path, { timeout: wait }),
  };
}

async function waitFor(condition) {
  const deadline = performance.now() + timeout;
  while (!condition() && performance.now() < deadline) await delay(50);
  assert.ok(condition());
}

async function verifyBrowser(page, issuer, grants) {
  const observation = observe(page, grants);
  const { calls, sockets, replies, response } = observation;
  const callsTo = path => calls.filter(call => call.path === path);
  const button = name => page.getByRole("button", { name, exact: true });
  const status = text => page.getByRole("status").getByText(text, { exact: true }).waitFor();
  const titleVisible = title => page.getByRole("list", { name: "Synthetic tasks" })
    .getByText(title, { exact: true }).waitFor();

  try {
    stage = "independent local control grant";
    const credentials = { username: "probe" + randomUUID().replaceAll("-", ""), password: randomUUID() };
    const enrollment = await issuer.mutation(api.auth.signUpWithUsernamePassword, credentials);
    assert.ok(enrollment.status === "complete" && enrollment.tokens?.refreshToken);
    const originalControl = enrollment.tokens;
    grants.add(originalControl.refreshToken);
    const control = client();
    control.setAuth(originalControl.accessToken);
    const initialTitle = "Browser renewal fixture";
    const id = await control.mutation(api.tasks.create, { title: initialTitle });

    stage = "sign-in and initial subscription";
    await page.getByLabel("Username").fill(credentials.username);
    await page.getByLabel("Password").fill(credentials.password);
    const [loginResponse] = await Promise.all([response(signInPath), button("Sign in").click()]);
    const login = await replies.get(loginResponse);
    const initial = login?.tokens;
    assert.ok(login?.status === "complete" && initial.userId === originalControl.userId &&
      initial.refreshToken !== originalControl.refreshToken);
    const { iat, exp } = JSON.parse(Buffer.from(initial.accessToken.split(".")[1], "base64url"));
    assert.equal(exp - iat, 60);
    await page.getByText("Subscription connected", { exact: true }).waitFor();
    await titleVisible(initialTitle);
    const beforeTitle = "Control edit before scheduled renewal";
    await control.mutation(api.tasks.rename, { id, title: beforeTitle });
    await titleVisible(beforeTitle);
    assert.equal(callsTo(refreshPath).length, 0);
    const originalSocket = sockets[0];
    const taskQuery = originalSocket?.queries.find(query => query.type === "Add" && query.udfPath === tasksPath);
    assert.ok(taskQuery && originalSocket.auth[0]?.hash === bearerHash(initial.accessToken));

    stage = "automatic renewal on the real clock";
    // Auth 2.1.0 issues 60-second bearers. Convex 1.51.0 renews about 10 seconds early.
    const rotationResponse = await response(refreshPath, 75_000);
    const rotation = await replies.get(rotationResponse);
    const rotated = rotation?.tokens;
    assert.ok(rotation?.kind === "rotated" && rotated.userId === initial.userId &&
      rotated.refreshToken !== initial.refreshToken && rotated.accessToken !== initial.accessToken);
    assert.ok(rotationResponse.request().postDataJSON().args[0].refreshToken === initial.refreshToken);
    const firstRefresh = callsTo(refreshPath)[0];
    const elapsedMs = Math.round(firstRefresh.at - callsTo(signInPath)[0].at);
    const msBeforeExpiry = exp * 1000 - firstRefresh.wallTime;
    // Sign-in itself can take time. Score the refresh against the issuer's clock.
    assert.ok(msBeforeExpiry > 0 && firstRefresh.wallTime >= iat * 1000 + 40_000);
    const successorHash = bearerHash(rotated.accessToken);
    await waitFor(() => originalSocket.auth.some(auth => auth.hash === successorHash &&
      originalSocket.identity > auth.baseVersion));

    stage = "same subscription receives a second control edit";
    const controlRotation = await issuer.mutation(api.auth.refreshSession, { refreshToken: originalControl.refreshToken });
    if (controlRotation.tokens?.refreshToken) grants.add(controlRotation.tokens.refreshToken);
    assert.ok(controlRotation.kind === "rotated" && controlRotation.tokens.userId === initial.userId);
    control.setAuth(controlRotation.tokens.accessToken);
    const afterTitle = "Control edit after scheduled renewal";
    await control.mutation(api.tasks.rename, { id, title: afterTitle });
    await titleVisible(afterTitle);
    assert.ok(originalSocket.rows.get(taskQuery.queryId)?.some(row => row._id === id && row.title === afterTitle));
    assert.equal(sockets.length, 1);
    assert.equal(originalSocket.queries.filter(query => query.udfPath === tasksPath || query.queryId === taskQuery.queryId).length, 1);
    assert.equal(originalSocket.closed, false);
    assert.equal(callsTo(tasksPath).length, 0);

    stage = "fresh read uses the successor bearer";
    const [readResponse] = await Promise.all([response(tasksPath), button("Read tasks").click()]);
    assert.ok(await readResponse.request().headerValue("authorization") === `Bearer ${rotated.accessToken}`);
    const read = await readResponse.json();
    assert.ok(readResponse.ok() && read.status === "success" &&
      read.value.some(row => row._id === id && row.title === afterTitle));
    await status("Read from the server.");

    stage = "sign-out and retired grant replay";
    const [signOutResponse] = await Promise.all([response(signOutPath), button("Sign out").click()]);
    // Count through the sign-out response so an intervening rotation cannot pass the credential check.
    assert.equal(callsTo(refreshPath).length, 1);
    assert.ok(signOutResponse.request().postDataJSON().args[0].refreshToken === rotated.refreshToken);
    const acknowledgment = await signOutResponse.json();
    assert.ok(signOutResponse.ok() && acknowledgment.status === "success" && acknowledgment.value === null);
    await status("Signed out.");
    await button("Sign in").waitFor();
    const replay = await issuer.mutation(api.auth.refreshSession, { refreshToken: rotated.refreshToken });
    if (replay.tokens?.refreshToken) grants.add(replay.tokens.refreshToken);
    assert.ok(replay.kind === "noSession" && Object.keys(replay).length === 1);
    assert.ok(await control.query(api.auth.isAuthenticated, {}));

    stage = "browser and grant cleanup";
    return {
      signedIn: true, automaticRenewals: 1, msFromSignInRequest: elapsedMs, msBeforeExpiry,
      accessTokenLifetimeSeconds: exp - iat,
      sameOwner: true, rotatedGrant: true, originalSubscriptionDeliveredControlEdit: true,
      websocketCount: 1, taskSubscriptionCount: 1, readWithSuccessorBearer: true,
      signedOutWithSuccessorGrant: true, revokedGrantReplayNoSession: true,
    };
  } finally {
    await observation.settleGrants();
  }
}

function backendFailureLabels(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(backendFailureLabels);
  const commandFailure = /^(Convex listener check|Convex source inventory|Convex source copy|Local Convex admin key generation|Local Convex function push) failed \((ETIMEDOUT|ENOENT|EACCES|EPERM|SIGTERM|SIGKILL|unknown|\d+)\)$/.exec(error?.message);
  if (commandFailure) return [commandFailure[1] + " " + commandFailure[2]];
  const staticFailures = [
    "The local Convex fixture requires Windows and its cached backend",
    "Convex fixture ports 3210 or 3211 are already in use",
    "The pinned Convex binary and spikes/p0 node_modules must be installed",
    "Convex ports are not exclusively bound to the fixture process on loopback",
    "Local Convex backend exited before it was ready",
    "Local Convex backend did not become ready on both fixture ports",
    "Unexpected Convex instance on the fixture port",
    "The deployed Convex tasks query did not return an empty anonymous result",
    "Local Convex generated an invalid admin key",
    "Local Convex listener disappeared after the push",
    "The fixture Convex process did not stop",
    "Convex fixture ports still have listeners after cleanup",
    "Could not verify ownership of the Convex fixture directory for cleanup",
    "Could not remove the Convex fixture directory",
  ];
  return staticFailures.filter(label => label === error?.message);
}

try {
  if (process.argv.length !== 2) throw Error("Unexpected arguments");
  // In particular, do not inherit Playwright or Node diagnostics that can print request data.
  const platform = new Set([
    "systemroot", "windir", "systemdrive", "comspec", "pathext", "path", "temp", "tmp",
    "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata",
    "processor_architecture", "number_of_processors",
  ]);
  for (const key of Object.keys(process.env)) if (!platform.has(key.toLowerCase())) delete process.env[key];
  stage = "isolated local backend startup";
  const evidence = await withLocalBackend(async ({ url }) => {
    assert.ok(url === origin);
    const issuer = client();
    const grants = new Set();
    try { return await withPortablePage(page => verifyBrowser(page, issuer, grants)); }
    finally {
      const revoked = await Promise.allSettled([...grants].map(async refreshToken => {
        assert.ok(await issuer.mutation(api.auth.signOut, { refreshToken }) === null);
      }));
      assert.ok(revoked.every(result => result.status === "fulfilled"));
      if (stage === "browser and grant cleanup") stage = "isolated local backend cleanup";
    }
  });
  console.log(JSON.stringify(evidence));
} catch (error) {
  // Convex and Playwright errors may include live strings. Emit only the fixed phase label.
  console.error(["Browser renewal probe failed during " + stage, ...backendFailureLabels(error)].join(". "));
  process.exitCode = 1;
}
