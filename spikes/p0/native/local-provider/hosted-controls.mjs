import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { ConvexHttpClient } from "convex/browser";
import { anyApi as api } from "convex/server";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const hostedOrigin = /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud$/;
const timeout = 15_000;

const controlSource = `
  import { ConvexClient } from "convex/browser";
  import { anyApi as api } from "convex/server";

  window.startControl = (origin, bearer) => {
    const client = new ConvexClient(origin, {
      logger: false, expectAuth: true, initialAuthTokenReuse: true,
    });
    let authenticated = false;
    let receivedRows = false;
    client.setAuth(async () => bearer, value => { authenticated = value; });
    window.controlReady = () => receivedRows && authenticated && client.connectionState().isWebSocketConnected;
    const list = document.querySelector("ul");
    client.onUpdate(api.tasks.list, {}, rows => {
      list.replaceChildren(...rows.map(task => {
        const row = document.createElement("li");
        row.dataset.id = task._id;
        row.textContent = task.title;
        return row;
      }));
      receivedRows = true;
    }, () => { receivedRows = false; });
  };
`;

async function withControlView(origin, bearer, exercise) {
  const { outputFiles: [script] } = await build({
    stdin: { contents: controlSource, resolveDir: import.meta.dirname },
    bundle: true, platform: "browser", write: false, logLevel: "silent",
  });
  const socketOrigin = "wss://" + new URL(origin).host;
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src " + socketOrigin })
        .end('<!doctype html><ul></ul><script src="/control.js"></script>');
    } else if (request.method === "GET" && request.url === "/control.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(script.contents);
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", timeout });
    const page = await browser.newPage();
    let expectedSocket = false;
    page.on("websocket", socket => {
      if (new URL(socket.url()).origin === socketOrigin) expectedSocket = true;
    });
    await page.goto("http://127.0.0.1:" + server.address().port + "/", { timeout });
    await page.evaluate(([url, token]) => window.startControl(url, token), [origin, bearer]);
    return await exercise(async expected => {
      await page.waitForFunction(task => {
        if (!window.controlReady()) return false;
        const [row, unexpected] = document.querySelectorAll("li");
        if (task === null) return !row;
        const [id, title] = task;
        return row?.dataset.id === id && row.textContent === title && !unexpected;
      }, expected, { timeout });
      if (!expectedSocket) throw Error("Expected the pinned hosted control WebSocket");
    });
  } finally {
    try { await browser?.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}

function client(origin, observeStatus) {
  return new ConvexHttpClient(origin, {
    logger: false,
    fetch: async (url, options) => {
      if (new URL(url).origin !== origin) throw Error("Unexpected hosted provider origin");
      const response = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
      observeStatus?.(response.status);
      return response;
    },
  });
}

const nonempty = value => typeof value === "string" && value.length > 0;
const authenticated = http => http.query(api.auth.isAuthenticated, {});
const list = http => http.query(api.tasks.list, {});

export async function withHostedProviderScenario(origin, accounts, exercise) {
  if (typeof origin !== "string" || !hostedOrigin.test(origin) || new URL(origin).origin !== origin) {
    throw Error("Expected an exact HTTPS Convex cloud origin");
  }
  const { a, b } = accounts ?? {};
  if (![a, b].every(account => nonempty(account?.username) && nonempty(account?.password)) ||
      a.username === b.username || typeof exercise !== "function") {
    throw Error("Expected two distinct hosted fixture credentials and a lifecycle callback");
  }

  const issuer = client(origin);
  const knownGrants = new Map();
  const clients = [];
  let stage;
  let failedStage;
  let failureLocation;
  let task = "not-created";
  let evidence;

  async function signIn({ username, password, owner: expectedOwner }) {
    const result = await issuer.mutation(api.auth.signInWithUsernamePassword, { username, password });
    const { accessToken, refreshToken, userId } = result?.tokens ?? {};
    const reusedRefresh = knownGrants.has(refreshToken);
    const reusedBearer = [...knownGrants.values()].some(bearers => bearers.has(accessToken));
    // Record every returned refresh grant before validating the rest of the response.
    if (nonempty(refreshToken)) {
      if (!reusedRefresh) knownGrants.set(refreshToken, new Set());
      if (nonempty(accessToken)) knownGrants.get(refreshToken).add(accessToken);
    }
    if (result?.status !== "complete" || ![accessToken, refreshToken, userId].every(nonempty) ||
        reusedRefresh || reusedBearer) {
      throw Error("Expected an independent hosted session grant");
    }
    if (expectedOwner !== undefined && userId !== expectedOwner) {
      throw Error("Hosted sign-in returned a different fixture owner");
    }
    const http = client(origin);
    clients.push(http);
    http.setAuth(accessToken);
    return { http, owner: userId, bearer: accessToken };
  }

  try {
    stage = "control sign-in";
    const control = await signIn(a);
    const stranger = await signIn(b);
    stage = "empty distinct fixture owners";
    if (control.owner === stranger.owner) throw Error("Expected two distinct fixture owners");
    for (const { http } of [control, stranger]) {
      if (await authenticated(http) !== true) throw Error("Expected an authenticated fixture owner");
      const rows = await list(http);
      if (!Array.isArray(rows) || rows.length !== 0) throw Error("Expected an empty fixture owner");
    }

    stage = "independent Edge sign-in";
    const edge = await signIn(a);
    if (edge.owner !== control.owner || await authenticated(edge.http) !== true) {
      throw Error("Expected a separate grant for the fixture owner");
    }

    stage = "independent Edge subscription";
    evidence = await withControlView(origin, edge.bearer, async waitForRows => {
      await waitForRows(null);

      stage = "create synthetic task";
      const marker = randomUUID();
      const title = "Hosted provider fixture " + marker;
      const updatedTitle = "Hosted control edit " + marker;
      // A response can be lost after commit. Never retry this non-idempotent write.
      task = "creation-unconfirmed";
      const taskId = await control.http.mutation(api.tasks.create, { title });
      if (!nonempty(taskId)) throw Error("Expected the synthetic task ID");
      task = "retained-no-scoped-delete";

      stage = "verify synthetic task";
      const rows = await list(control.http);
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?._id !== taskId ||
          rows[0].owner !== control.owner || rows[0].title !== title) {
        throw Error("Expected just the freshly created task");
      }
      const waitForControlTitle = expected => waitForRows([taskId, expected]);
      await waitForControlTitle(title);
      stage = "packaged lifecycle";
      const result = await exercise({
        input: { username: a.username, password: a.password, owner: control.owner },
        control: control.http, stranger: stranger.http, taskId, title, updatedTitle, waitForControlTitle,
      });
      stage = "independent Edge close";
      return result;
    });
  } catch (error) {
    // SDK and Playwright errors can contain bearer values or private fixture data.
    failedStage = stage;
    failureLocation = error?.stack?.split("\n").slice(1)
      .map(line => line.match(/[/\\](android-session-preflight|hosted-run|hosted-controls|smoke)\.mjs:(\d+):\d+/))
      .filter(Boolean).slice(0, 4).map(match => match[1] + ":" + match[2]);
  }

  const revoked = await Promise.all([...knownGrants].map(async ([refreshToken, bearers]) => {
    let step = "sign-out mutation";
    let httpStatus;
    const diagnostic = client(origin, status => { httpStatus = status; });
    try {
      if (await diagnostic.mutation(api.auth.signOut, { refreshToken }) !== null) return { step, httpStatus };
      step = "revoked refresh grant";
      const replay = await diagnostic.mutation(api.auth.refreshSession, { refreshToken });
      if (replay?.kind !== "noSession") return { step, httpStatus };
      step = "revoked bearer query";
      for (const bearer of bearers) {
        diagnostic.setAuth(bearer);
        httpStatus = undefined;
        try {
          if (await authenticated(diagnostic) !== false) return { step, httpStatus };
        } catch (error) {
          if (httpStatus !== 401) throw error;
        }
      }
      return { step: "verified" };
    } catch {
      return { step, httpStatus };
    } finally { diagnostic.clearAuth(); }
  }));
  for (const http of clients) http.clearAuth();
  const fixtureCleanup = {
    knownControlSessions: knownGrants.size,
    controlSessionsRevoked: revoked.filter(result => result.step === "verified").length,
    task,
  };
  if (failedStage || fixtureCleanup.controlSessionsRevoked !== fixtureCleanup.knownControlSessions) {
    throw Object.assign(Error("Hosted fixture failed during " + (failedStage ?? "control revocation")),
      { fixtureCleanup, fixtureStage: failedStage ?? "control revocation", fixtureRevocation: revoked, failureLocation });
  }
  return { ...evidence, fixtureCleanup };
}
