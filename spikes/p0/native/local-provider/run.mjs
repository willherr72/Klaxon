import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { chromium } from "playwright-core";
import { withWindowsHost } from "../smoke.mjs";
import { withLocalBackend } from "./backend.mjs";
import { buildLocalProvider, controlScript, executable } from "./build.mjs";
import { exerciseLocalProvider } from "./check.mjs";
import { withSubscriptionRelay } from "./relay.mjs";

const origin = "http://127.0.0.1:3210";
let stage = "build";

async function withControlView(token, taskId, action) {
  stage = "independent Edge control startup";
  // Serve a real loopback document. An intercepted navigation lacks a peer
  // address and Edge's local network access check rejects its WebSocket.
  const script = await readFile(controlScript);
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !["/", "/control.js"].includes(request.url)) {
      response.writeHead(404).end();
    } else if (request.url === "/control.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(script);
    } else {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; connect-src ws://127.0.0.1:3210" })
        .end('<!doctype html><ul></ul><script src="/control.js"></script>');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge" });
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.evaluate(bearer => window.startControl(bearer), token);
    const waitForTitle = async title => {
      try {
        await page.waitForFunction(([id, text]) =>
          [...document.querySelectorAll("li")].some(row => row.dataset.id === id && row.textContent === text),
          [taskId, title], { timeout: 15000 });
      } catch (error) {
        console.error("Control subscription", await page.evaluate(() => window.controlState()));
        throw error;
      }
    };
    return await action(waitForTitle);
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}

function client() {
  return new ConvexHttpClient(origin, {
    logger: false,
    fetch: (url, options) => {
      if (new URL(url).origin !== origin) throw Error("Unexpected provider origin");
      return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
    },
  });
}

async function enroll(issuer) {
  const credentials = { username: "probe" + randomUUID().replaceAll("-", ""), password: randomUUID() };
  const result = await issuer.mutation(api.auth.signUpWithUsernamePassword, credentials);
  assert.ok(result.status === "complete" && result.tokens?.refreshToken && result.tokens?.accessToken,
    "Local signup did not produce a grant");
  const http = client();
  http.setAuth(result.tokens.accessToken);
  return { credentials, http, grant: result.tokens };
}

async function run(url, relay) {
  assert.equal(url, origin);
  const issuer = client();
  const accounts = [];
  const tempParent = await realpath(tmpdir());
  const root = await mkdtemp(join(tempParent, "klaxon-p0-session-"));
  const profile = join(root, "webview");
  const slot = join(root, "packaged.bin");
  const capture = { hosts: new Set(), browsers: new Set(), runName: basename(root) };
  try {
    await mkdir(profile);
    stage = "local synthetic enrollment";
    accounts.push(await enroll(issuer));
    accounts.push(await enroll(issuer));
    const [a, b] = accounts;
    assert.ok(a.grant.userId !== b.grant.userId, "Expected two distinct owners");
    stage = "control task and account isolation";
    for (const { http } of accounts) {
      assert.equal(await http.query(api.auth.isAuthenticated, {}), true);
      assert.equal((await http.query(api.tasks.list, {})).length, 0);
    }
    const title = "Local provider fixture";
    const updatedTitle = "Control edit after revocation";
    const taskId = await a.http.mutation(api.tasks.create, { title });
    stage = "packaged session";
    let launches = 0;
    async function launch(action) {
      const first = launches++ === 0;
      const env = { TEMP: tempParent, TMP: tempParent, KLAXON_P0_LOCAL_OWNER_ID: a.grant.userId };
      if (first) {
        env.KLAXON_P0_LOCAL_USER = a.credentials.username;
        env.KLAXON_P0_LOCAL_PASSWORD = a.credentials.password;
      }
      await withWindowsHost(executable, profile, action, capture, env);
      if (first) {
        const sealed = await readFile(slot);
        assert.ok(sealed.length > 0 && !sealed.includes(a.credentials.password),
          "Expected a protected session record from the first host");
      }
    }
    const result = await withControlView(a.grant.accessToken, taskId, async waitForTitle => {
      stage = "initial control subscription render";
      await waitForTitle(title);
      stage = "packaged host exercise";
      return exerciseLocalProvider({
        launch, control: a.http, stranger: b.http, taskId, title, updatedTitle, relay,
        verifySlotCleared: () => assert.rejects(access(slot), { code: "ENOENT" }),
        waitForControlTitle: waitForTitle,
      });
    });
    if (result.status !== "passed") return result;
    assert.equal(capture.hosts.size, 2);
    assert.equal(capture.browsers.size, 2);
    await assert.rejects(access(slot), { code: "ENOENT" });
    return { ...result, nativeHosts: capture.hosts.size, webViews: capture.browsers.size, protectedSlotCleared: true };
  } finally {
    // Revoke every issued control grant, even if the second enrollment or the run failed.
    try {
      const revoked = await Promise.allSettled(accounts.map(async ({ http, grant }) => {
        try {
          assert.equal(await issuer.mutation(api.auth.signOut, { refreshToken: grant.refreshToken }), null);
          assert.equal(await http.query(api.auth.isAuthenticated, {}), false);
        } finally { http.clearAuth(); }
      }));
      if (revoked.some(r => r.status === "rejected")) throw Error("Control session cleanup failed");
    } finally {
      assert.equal(dirname(root), tempParent);
      assert.ok(/^klaxon-p0-session-[a-z0-9]{6}$/i.test(basename(root)));
      const entry = await lstat(root);
      assert.ok(entry.isDirectory() && !entry.isSymbolicLink() && await realpath(root) === root);
      await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
    }
  }
}

try {
  const args = process.argv.slice(2);
  const reconnect = args.length === 1 && args[0] === "--reconnect";
  if (args.length && !reconnect) throw Error("Expected --reconnect or no argument");
  if (!reconnect) await buildLocalProvider();
  // The native child inherits only platform settings and its dedicated test inputs.
  const platformEnv = new Set([
    "systemroot", "windir", "systemdrive", "comspec", "pathext", "path", "temp", "tmp",
    "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata",
    "processor_architecture", "number_of_processors",
  ]);
  for (const key of Object.keys(process.env)) if (!platformEnv.has(key.toLowerCase())) delete process.env[key];
  stage = "isolated local backend startup or cleanup";
  const evidence = await withLocalBackend(async ({ url }) => {
    // The fixed upstream belongs to our isolated backend before the relay listens.
    const result = reconnect ? await withSubscriptionRelay(async relay => {
      stage = "packaged reconnect build";
      await buildLocalProvider(relay.port);
      return run(url, relay);
    }) : await run(url);
    stage = "isolated local backend cleanup";
    return result;
  });
  console.log("Packaged local provider evidence", evidence);
  if (evidence.status !== "passed") process.exitCode = 1;
} catch (error) {
  // SDK and Playwright failures can include live data. Emit only fixture source locations.
  const locations = (error.stack ?? "").split("\n").slice(1)
    .map(line => line.match(/[\\/](backend|check|run|smoke|client)\.m?js:(\d+):\d+\)?$/))
    .filter(Boolean).map(match => match[1] + ":" + match[2]);
  console.error("Local provider exercise failed during", stage, locations.join(", "));
  process.exitCode = 1;
}
