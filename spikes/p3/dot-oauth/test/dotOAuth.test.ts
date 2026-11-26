import { convexTest } from "convex-test";
import { base64url, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import schema from "../convex/schema";

const origin = "https://some.convex.site";
const redirect = "https://connector.example.com/oauth/callback";
const clientId = "synthetic-fixture-client";
const resource = origin + "/mcp";
const workspacePublicId = "synthetic-workspace";
const taskId = "synthetic-task";
const createId = crypto.randomUUID();
const updateId = crypto.randomUUID();
const reason = "Verify the authorized synthetic task edit";
const state = "state-fixture";
const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
const passphrase = crypto.randomUUID();
const hash = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
let privateJwk: string;

beforeAll(async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  privateJwk = JSON.stringify({ ...await exportJWK(privateKey), kid: "fixture-test" });
});

beforeEach(async () => {
  vi.stubEnv("DOT_OAUTH_ENABLED", "true");
  vi.stubEnv("DOT_OAUTH_ORIGIN", origin);
  vi.stubEnv("DOT_OAUTH_CLIENT_ID", clientId);
  vi.stubEnv("DOT_OAUTH_REDIRECT_URI", redirect);
  vi.stubEnv("DOT_OAUTH_PRIVATE_JWK", privateJwk);
  vi.stubEnv("DOT_OAUTH_PASSPHRASE_SHA256", Array.from(await hash(passphrase), b => b.toString(16).padStart(2, "0")).join(""));
  vi.stubEnv("DOT_OAUTH_REFRESH", "true");
  vi.stubEnv("DOT_OAUTH_EXPIRES_AT", String(Date.now() + 1_800_000));
  vi.stubEnv("DOT_OAUTH_WORKSPACE_ID", workspacePublicId);
  vi.stubEnv("DOT_OAUTH_TASK_ID", taskId);
  vi.stubEnv("DOT_OAUTH_CREATE_ID", createId);
  vi.stubEnv("DOT_OAUTH_UPDATE_ID", updateId);
  vi.stubEnv("KLAXON_OAUTH_ISSUER", origin);
  vi.stubEnv("KLAXON_OAUTH_RESOURCE", resource);
  vi.stubEnv("KLAXON_OAUTH_JWKS_URL", origin + "/dot-oauth/jwks");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function fixture() {
  return convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/http.ts": () => import("../convex/http"),
    "../convex/dotOAuth.ts": () => import("../convex/dotOAuth"),
    "../convex/agentCredentials.ts": () => import("../convex/agentCredentials"),
    "../convex/agentTasks.ts": () => import("../convex/agentTasks"),
  } });
}
async function authorization(overrides: Record<string, string> = {}) {
  return "/dot-oauth/authorize?" + new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code",
    resource, scope: "tasks:read tasks:write offline_access", state, code_challenge_method: "S256",
    code_challenge: base64url.encode(await hash(verifier)), ...overrides });
}
const form = (values: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST", headers, body: new URLSearchParams(values),
});
function redeem(code: string, overrides: Record<string, string> = {}) {
  return form({ client_id: clientId, grant_type: "authorization_code", code, redirect_uri: redirect,
    code_verifier: verifier, resource, ...overrides });
}
async function consent(t: ReturnType<typeof fixture>, path: string, overrides?: Record<string, string>) {
  const response = await t.fetch(path);
  expect(response.status).toBe(200);
  const body = await response.text();
  const scopes = new URL(path, origin).searchParams.get("scope")!.split(" ");
  expect([...body.matchAll(/<li><code>([^<]+)<\/code><\/li>/gu)].map(match => match[1])).toEqual(scopes);
  const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/u.exec(body)?.[1];
  expect(nonce).toBeDefined();
  return t.fetch("/dot-oauth/authorize", form({ nonce: nonce!, passphrase, decision: "approve", ...overrides }, { Origin: origin }));
}

test("disabled fixture publishes no discovery or keys", async () => {
  vi.stubEnv("DOT_OAUTH_ENABLED", "");
  const t = fixture();
  expect((await t.fetch("/.well-known/oauth-authorization-server")).status).toBe(404);
  expect((await t.fetch("/dot-oauth/jwks")).status).toBe(404);
  expect((await t.fetch("/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
});

test("setup discovery displays just a public callback and leaves OAuth storage empty", async () => {
  const t = fixture();
  vi.stubEnv("DOT_OAUTH_ENABLED", "");
  vi.stubEnv("DOT_OAUTH_SETUP_ORIGIN", origin);
  vi.stubEnv("KLAXON_OAUTH_ISSUER", undefined);
  vi.stubEnv("KLAXON_OAUTH_RESOURCE", undefined);
  vi.stubEnv("KLAXON_OAUTH_JWKS_URL", undefined);
  const challenge = await t.fetch("/mcp", { method: "POST" });
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("WWW-Authenticate"))
    .toBe('Bearer resource_metadata="https://some.convex.site/.well-known/oauth-protected-resource/mcp"');
  expect(await (await t.fetch("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({
    resource, authorization_servers: [origin], scopes_supported: ["tasks:read", "tasks:write"],
  });
  expect(await (await t.fetch("/.well-known/oauth-authorization-server")).json()).toMatchObject({
    issuer: origin, token_endpoint_auth_methods_supported: ["none"],
  });
  const candidate = redirect + "&callback";
  const path = await authorization({ client_id: "klaxon-dot-test", redirect_uri: candidate,
    state: "do-not-render", unknown_connector_param: "do-not-render-either" });
  const response = await t.fetch(path);
  expect(response.status).toBe(200);
  expect(response.headers.get("Location")).toBeNull();
  const body = await response.text();
  expect(body).toContain("<pre>" + redirect + "&amp;callback</pre>");
  expect(body).not.toMatch(/do-not-render|<form|<a |name="nonce"|code_challenge/u);
  expect((await t.fetch("/dot-oauth/authorize", form({ passphrase }, { Origin: origin }))).status).toBe(404);
  expect((await t.fetch("/dot-oauth/jwks")).status).toBe(404);
  expect((await t.fetch("/dot-oauth/token", form({ client_id: "klaxon-dot-test" }))).status).toBe(404);
  expect((await t.fetch("/dot-oauth/revoke", form({ client_id: "klaxon-dot-test" }))).status).toBe(404);
  expect(await t.run(async ({ db }) => [
    (await db.query("dotOAuthRequests").collect()).length,
    (await db.query("dotOAuthGrants").collect()).length,
    (await db.query("dotOAuthFamilies").collect()).length,
  ])).toEqual([0, 0, 0]);
});

test("setup only displays an exact public URI, and active authorization takes precedence", async () => {
  const t = fixture();
  vi.stubEnv("DOT_OAUTH_ENABLED", "");
  vi.stubEnv("DOT_OAUTH_SETUP_ORIGIN", origin);
  for (const candidate of [redirect + "?private-value=1", redirect + "#x", redirect + "%252a",
    "http://connector.example.com/callback", "https://name:credential@connector.example.com/callback"]) {
    const response = await t.fetch(await authorization({ client_id: "klaxon-dot-test", redirect_uri: candidate }));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual({ error: "invalid_request" });
  }
  vi.stubEnv("DOT_OAUTH_SETUP_ORIGIN", "https://other.convex.site");
  expect((await t.fetch("/.well-known/oauth-authorization-server")).status).toBe(404);
  vi.stubEnv("DOT_OAUTH_SETUP_ORIGIN", origin);
  vi.stubEnv("DOT_OAUTH_ENABLED", "true");
  expect((await t.fetch(await authorization({ client_id: "klaxon-dot-test" }))).status).toBe(400);
  expect((await t.fetch(await authorization())).status).toBe(200);
});

test("discovery and public keys verify an access token bound to one client, resource and PKCE exchange", async () => {
  const t = fixture();
  const metadata = await (await t.fetch("/.well-known/oauth-authorization-server")).json();
  expect(metadata).toMatchObject({ issuer: origin, token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"], jwks_uri: origin + "/dot-oauth/jwks" });
  expect(await (await t.fetch("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({
    resource, authorization_servers: [origin], scopes_supported: ["tasks:read", "tasks:write"],
  });
  const reply = await consent(t, await authorization());
  expect(reply.status).toBe(303);
  const location = new URL(reply.headers.get("Location")!);
  expect(location.origin + location.pathname).toBe(redirect);
  expect(location.searchParams.get("state")).toBe(state);
  const code = location.searchParams.get("code")!;
  expect((await t.fetch("/dot-oauth/token", redeem(code, { code_verifier: "x".repeat(43) }))).status).toBe(400);
  const token = await (await t.fetch("/dot-oauth/token", redeem(code))).json() as { access_token: string; refresh_token: string };
  const jwks = await (await t.fetch("/dot-oauth/jwks")).json();
  expect(Object.keys(jwks.keys[0]).sort()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  expect((await jwtVerify(token.access_token, createLocalJWKSet(jwks), {
    algorithms: ["RS256"], issuer: origin, audience: resource, typ: "at+jwt",
  })).payload).toMatchObject({ sub: "klaxon-dot-fixture", client_id: clientId, scope: "tasks:read tasks:write" });
  expect(/^[A-Za-z0-9_-]{43}$/u.test(token.refresh_token)).toBe(true);
  expect((await t.fetch("/dot-oauth/token", redeem(code))).status).toBe(400);
});

test("wrong callbacks, other resources and unsupported scopes cannot get a consent nonce", async () => {
  const t = fixture();
  const invalid: Record<string, string>[] = [{ redirect_uri: redirect + "?next=elsewhere" }, { resource: origin + "/other" },
    { scope: "planning:apply" }, { code_challenge_method: "plain" }];
  for (const overrides of invalid) {
    const response = await t.fetch(await authorization(overrides));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  }
  const badConsent = await consent(t, await authorization(), { passphrase: crypto.randomUUID() });
  expect(badConsent.status).toBe(400);
});

test("invalid configured redirects or an unapproved lifetime keep the issuer disabled", async () => {
  const t = fixture();
  for (const callback of [redirect + "?target=elsewhere", redirect + "#x", redirect + "%252a",
    "https://user@connector.example.com/callback", "https://*.example.com/callback"]) {
    vi.stubEnv("DOT_OAUTH_REDIRECT_URI", callback);
    expect((await t.fetch("/.well-known/oauth-authorization-server")).status).toBe(404);
  }
  vi.stubEnv("DOT_OAUTH_REDIRECT_URI", redirect);
  for (const expiration of [Date.now() - 1, Date.now() + 3_700_000]) {
    vi.stubEnv("DOT_OAUTH_EXPIRES_AT", String(expiration));
    expect((await t.fetch("/.well-known/oauth-authorization-server")).status).toBe(404);
  }
});

test("consent requires an explicit same-origin POST and consumes its nonce once", async () => {
  const t = fixture();
  const authorizationPage = await t.fetch(await authorization());
  const nonce = /name="nonce" value="([A-Za-z0-9_-]+)"/u.exec(await authorizationPage.text())![1]!;
  const post = (requestOrigin: string) => t.fetch("/dot-oauth/authorize", form(
    { nonce, passphrase, decision: "approve" }, { Origin: requestOrigin }));
  expect((await post("https://outside.example.com")).status).toBe(400);
  expect((await post(origin)).status).toBe(303);
  expect((await post(origin)).status).toBe(400);
});

test("a staged MCP session exposes four tools and enforces the exact two synthetic writes at dispatch", async () => {
  const t = fixture();
  const credentialPublicId = "synthetic-credential";
  await t.run(async ({ db }) => {
    const now = Date.now();
    const fields = { revision: 1, createdAt: now, updatedAt: now };
    const userId = await db.insert("users", {});
    const workspaceId = await db.insert("workspaces", { ownerId: userId, name: "Synthetic", publicId: workspacePublicId, ...fields });
    await db.insert("memberships", { userId, workspaceId, role: "owner", publicId: "owner", ...fields });
    await db.insert("agentCredentials", { userId, workspaceId, label: "Synthetic", publicId: credentialPublicId, ...fields,
      tokenHash: "unused-test-only", scopes: ["tasks:read", "tasks:write"],
      oauthPrincipal: { issuer: origin, subject: "klaxon-dot-fixture", clientId }, expiresAt: now + 600_000 });
  });
  vi.stubEnv("KLAXON_OAUTH_BINDINGS", JSON.stringify([{ issuer: origin, subject: "klaxon-dot-fixture", clientId,
    workspacePublicId, credentialPublicId }]));
  const granted = await consent(t, await authorization());
  const code = new URL(granted.headers.get("Location")!).searchParams.get("code")!;
  const token = await (await t.fetch("/dot-oauth/token", redeem(code))).json();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) !== origin + "/dot-oauth/jwks") throw new Error("Test fetch blocked");
    return t.fetch("/dot-oauth/jwks");
  });
  let id = 0;
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const response = await t.fetch("/mcp", { method: "POST", headers: {
      Authorization: "Bearer " + token.access_token, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
      const data = (await response.text()).split("\n").find(line => line.startsWith("data: "));
      if (!data) throw new Error("Missing MCP result");
      return JSON.parse(data.slice(6));
    }
    return response.json();
  }
  const list = await rpc("tools/list");
  expect(list.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["create_task", "get_task", "list_tasks", "update_task"]);
  const call = (name: string, args: object) => rpc("tools/call", { name, arguments: args });
  const listReady = () => call("list_tasks", { filter: { kind: "status", status: "ready" } });
  const create = { publicId: taskId, operationId: createId, reason,
    task: { title: "Dot fixture ready for rename", status: "ready" } };
  const update = { publicId: taskId, operationId: updateId, reason, expectedRevision: 1, patch: { title: "Dot fixture renamed" } };
  expect((await listReady()).result.structuredContent).toEqual({ items: [], nextCursor: null });
  expect((await call("create_task", { ...create, publicId: "unexpected" })).result.isError).toBe(true);
  const created = await call("create_task", create);
  expect(created.result.structuredContent).toMatchObject({ publicId: taskId, revision: 1 });
  expect((await call("update_task", { ...update, patch: { ...update.patch, description: "unexpected" } })).result.isError).toBe(true);
  expect((await call("update_task", update)).result.structuredContent).toMatchObject({ publicId: taskId, revision: 2 });
  expect((await call("create_task", create)).result.structuredContent).toEqual(created.result.structuredContent);
  expect((await listReady()).result.structuredContent.items.map((task: { publicId: string }) => task.publicId)).toEqual([taskId]);
  expect(await t.run(async ({ db }) => ({ tasks: (await db.query("tasks").collect()).length,
    events: (await db.query("activityEvents").collect()).length }))).toEqual({ tasks: 1, events: 2 });
  await t.run(async ({ db }) => {
    const unrelated = (await db.query("tasks").unique())!;
    const { _creationTime, _id, ...copy } = unrelated;
    await db.insert("tasks", { ...copy, publicId: "unexpected", title: "Unrelated", rank: -10 });
  });
  expect((await listReady()).result.isError).toBe(true);
  vi.stubEnv("DOT_OAUTH_EXPIRES_AT", String(Date.now() - 1));
  expect((await rpc("tools/list")).error.code).toBe("AGENT_UNAUTHORIZED");
});

test("refresh rotation is single-use and refresh revocation prevents future grants", async () => {
  const t = fixture();
  const response = await consent(t, await authorization());
  const code = new URL(response.headers.get("Location")!).searchParams.get("code")!;
  const initial = await (await t.fetch("/dot-oauth/token", redeem(code))).json();
  const refresh = (token: string) => form({ client_id: clientId, grant_type: "refresh_token", refresh_token: token, resource });
  const rotated = await (await t.fetch("/dot-oauth/token", refresh(initial.refresh_token))).json();
  expect(rotated.refresh_token !== initial.refresh_token).toBe(true);
  expect((await t.fetch("/dot-oauth/token", refresh(initial.refresh_token))).status).toBe(400);
  expect((await t.fetch("/dot-oauth/token", refresh(rotated.refresh_token))).status).toBe(400);
  const second = await consent(t, await authorization());
  const secondCode = new URL(second.headers.get("Location")!).searchParams.get("code")!;
  const issued = await (await t.fetch("/dot-oauth/token", redeem(secondCode))).json();
  expect((await t.fetch("/dot-oauth/revoke", form({ client_id: clientId, token: issued.refresh_token }))).status).toBe(200);
  expect((await t.fetch("/dot-oauth/token", refresh(issued.refresh_token))).status).toBe(400);
});
