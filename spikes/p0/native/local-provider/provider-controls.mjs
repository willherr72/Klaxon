import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { chromium } from "playwright-core";
import { controlScript } from "./build.mjs";

const origin = "http://127.0.0.1:3210";

async function withControlView(token, taskId, action) {
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

export function localProviderClient() {
  return new ConvexHttpClient(origin, {
    logger: false,
    fetch: (url, options) => {
      if (new URL(url).origin !== origin) throw Error("Unexpected provider origin");
      return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
    },
  });
}

export async function enrollLocalProviderAccount(issuer) {
  const credentials = { username: "probe" + randomUUID().replaceAll("-", ""), password: randomUUID() };
  const result = await issuer.mutation(api.auth.signUpWithUsernamePassword, credentials);
  assert.ok(result.status === "complete" && result.tokens?.refreshToken && result.tokens?.accessToken,
    "Local signup did not produce a grant");
  const http = localProviderClient();
  http.setAuth(result.tokens.accessToken);
  return { credentials, http, grant: result.tokens };
}

export async function withLocalProviderScenario(url, exercise) {
  assert.equal(url, origin);
  const issuer = localProviderClient();
  const accounts = [];
  try {
    accounts.push(await enrollLocalProviderAccount(issuer));
    accounts.push(await enrollLocalProviderAccount(issuer));
    const [a, b] = accounts;
    assert.ok(a.grant.userId !== b.grant.userId, "Expected two distinct owners");
    for (const { http } of accounts) {
      assert.equal(await http.query(api.auth.isAuthenticated, {}), true);
      assert.equal((await http.query(api.tasks.list, {})).length, 0);
    }
    const title = "Local provider fixture";
    const updatedTitle = "Control edit after revocation";
    const taskId = await a.http.mutation(api.tasks.create, { title });
    return await withControlView(a.grant.accessToken, taskId, async waitForControlTitle => {
      await waitForControlTitle(title);
      return exercise({
        input: { ...a.credentials, owner: a.grant.userId },
        control: a.http, stranger: b.http, taskId, title, updatedTitle, waitForControlTitle,
      });
    });
  } finally {
    const revoked = await Promise.allSettled(accounts.map(async ({ http, grant }) => {
      try {
        assert.equal(await issuer.mutation(api.auth.signOut, { refreshToken: grant.refreshToken }), null);
        assert.equal(await http.query(api.auth.isAuthenticated, {}), false);
      } finally { http.clearAuth(); }
    }));
    if (revoked.some(r => r.status === "rejected")) throw Error("Control session cleanup failed");
  }
}
