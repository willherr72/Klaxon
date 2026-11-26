import { makeFunctionReference, type HttpRouter } from "convex/server";
import { env, httpAction } from "../_generated/server";
import { fixtureConfig, publicCallbackUrl, routes, setupClientId, setupOrigin, tasks, type FixtureConfig } from "./config";
import { boundedForm, digest, escapeHtml, opaque, opaquePattern, requestedScopes, signAccess, validPassphrase, verifierPattern } from "./protocol";

type RequestFields = { clientId: string; callback: string; resource: string; challenge: string; scopes: string[]; state: string; hash: string };
const begin = makeFunctionReference<"mutation", RequestFields, boolean>("dotOAuth:begin");
const agree = makeFunctionReference<"mutation", { nonceHash: string; codeHash: string },
  { callback: string; state: string } | null>("dotOAuth:agree");
const exchange = makeFunctionReference<"mutation", {
  kind: "code" | "refresh"; hash: string; nextHash: string; callback?: string; challenge?: string;
}, { scopes: string[]; refresh: boolean } | null>("dotOAuth:exchange");
const revoke = makeFunctionReference<"mutation", { hash: string }, null>("dotOAuth:revoke");
const noStore = { "Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer" };

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: noStore });
}

function failure(error: string, status = 400) {
  return json({ error }, status);
}

function configFor(request: Request) {
  const config = fixtureConfig(env);
  return config?.origin === new URL(request.url).origin ? config : undefined;
}

function setupFor(request: Request) {
  const origin = setupOrigin(env);
  return origin === new URL(request.url).origin ? origin : undefined;
}

export function setupMcpResponse(request: Request) {
  const origin = setupFor(request);
  if (!origin) return;
  return Response.json({ error: { code: "AGENT_UNAUTHORIZED" } }, {
    status: 401, headers: { ...noStore,
      "WWW-Authenticate": 'Bearer resource_metadata="' + origin + '/.well-known/oauth-protected-resource/mcp"' },
  });
}

export const dotResourceMetadata = httpAction(async (_ctx, request) => {
  const origin = configFor(request)?.origin ?? setupFor(request);
  return origin ? json({ resource: origin + "/mcp", authorization_servers: [origin],
    scopes_supported: [...tasks], bearer_methods_supported: ["header"] }) : failure("not_found", 404);
});

function metadata(config: Pick<FixtureConfig, "origin" | "refresh">) {
  return {
    issuer: config.origin, authorization_endpoint: config.origin + routes.authorize,
    token_endpoint: config.origin + routes.token, jwks_uri: config.origin + routes.jwks,
    revocation_endpoint: config.origin + routes.revoke, revocation_endpoint_auth_methods_supported: ["none"],
    token_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"],
    grant_types_supported: config.refresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
    scopes_supported: config.refresh ? [...tasks, "offline_access"] : [...tasks],
    code_challenge_methods_supported: ["S256"],
  };
}

function callbackPage(request: Request, origin: string) {
  const url = new URL(request.url);
  const params = url.searchParams;
  const callback = publicCallbackUrl(params.get("redirect_uri") ?? undefined);
  if (url.search.length > 4096 || !callback ||
      params.getAll("redirect_uri").length !== 1 || params.getAll("client_id").length !== 1 ||
      params.getAll("response_type").length !== 1 || params.get("client_id") !== setupClientId ||
      params.get("response_type") !== "code" || params.getAll("resource").length > 1 ||
      (params.has("resource") && params.get("resource") !== origin + "/mcp")) return failure("invalid_request");
  return new Response('<!doctype html><meta charset="utf-8"><title>Verify redirect URI</title><pre>' +
    escapeHtml(callback.href) + '</pre>', {
    headers: { ...noStore, "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function consentPage(config: FixtureConfig, scopes: string[], nonce: string) {
  const scopeList = scopes.map(scope => '<li><code>' + escapeHtml(scope) + '</code></li>').join("");
  const body = '<!doctype html><meta charset="utf-8"><title>Klaxon synthetic fixture consent</title>' +
    '<main><h1>Approve the Klaxon synthetic test connection</h1><p>Only synthetic test data belongs here.</p>' +
    '<dl><dt>Client</dt><dd><code>' + escapeHtml(config.clientId) + '</code></dd><dt>MCP target</dt><dd><code>' +
    escapeHtml(config.resource) + '</code></dd><dt>Return to</dt><dd><code>' + escapeHtml(config.callback) +
    '</code></dd></dl><p>Requested access</p><ul>' + scopeList + '</ul>' +
    '<form method="post" action="' + routes.authorize + '"><input type="hidden" name="nonce" value="' + nonce + '">' +
    '<label>Fixture passphrase <input name="passphrase" type="password" maxlength="128" required autocomplete="off"></label>' +
    '<button name="decision" value="approve">Approve this exact access</button></form></main>';
  return new Response(body, { headers: { ...noStore, "Referrer-Policy": "same-origin",
    "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

export function registerDotOAuth(http: HttpRouter) {
  http.route({ path: routes.discovery, method: "GET", handler: httpAction(async (_ctx, request) => {
    const config = configFor(request);
    if (config) return json(metadata(config));
    const origin = setupFor(request);
    return origin ? json(metadata({ origin, refresh: false })) : failure("not_found", 404);
  }) });
  http.route({ path: routes.jwks, method: "GET", handler: httpAction(async (_ctx, request) => {
    const config = configFor(request);
    return config ? json({ keys: [config.publicKey] }) : failure("not_found", 404);
  }) });
  http.route({ path: routes.authorize, method: "GET", handler: httpAction(async (ctx, request) => {
    const config = configFor(request);
    if (!config) {
      const origin = setupFor(request);
      return origin ? callbackPage(request, origin) : failure("not_found", 404);
    }
    const url = new URL(request.url);
    const p = url.searchParams;
    const supported = new Set(["client_id", "redirect_uri", "response_type", "resource", "scope", "state",
      "code_challenge_method", "code_challenge"]);
    const state = p.get("state");
    const challenge = p.get("code_challenge");
    const scopes = requestedScopes(p.get("scope"), config);
    if (url.search.length > 4096 || new Set(p.keys()).size !== [...p].length || [...p.keys()].some(key => !supported.has(key)) ||
        p.get("client_id") !== config.clientId || p.get("redirect_uri") !== config.callback ||
        p.get("response_type") !== "code" || p.get("resource") !== config.resource ||
        p.get("code_challenge_method") !== "S256" || !challenge || !opaquePattern.test(challenge) ||
        !state || state.length > 512 || /[\x00-\x1f\x7f]/u.test(state) || !scopes) return failure("invalid_request");

    const nonce = opaque();
    const opened = await ctx.runMutation(begin, { hash: await digest(nonce), clientId: config.clientId,
      callback: config.callback, resource: config.resource, scopes, challenge, state });
    return opened ? consentPage(config, scopes, nonce) : failure("temporarily_unavailable", 429);
  }) });
  http.route({ path: routes.authorize, method: "POST", handler: httpAction(async (ctx, request) => {
    const config = configFor(request);
    if (!config) return failure("not_found", 404);
    if (request.headers.get("Origin") !== config.origin) return failure("invalid_request");
    const p = await boundedForm(request);
    const nonce = p?.get("nonce");
    if (!p || [...p].length !== 3 || p.get("decision") !== "approve" || !nonce || !opaquePattern.test(nonce) ||
        !await validPassphrase(p.get("passphrase") ?? "", config.passphraseHash)) return failure("invalid_request");
    const code = opaque();
    const granted = await ctx.runMutation(agree, { nonceHash: await digest(nonce), codeHash: await digest(code) });
    if (!granted || granted.callback !== config.callback) return failure("invalid_request");
    const redirect = new URL(config.callback);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", granted.state);
    return new Response(null, { status: 303, headers: { ...noStore, Location: redirect.href } });
  }) });
  http.route({ path: routes.token, method: "POST", handler: httpAction(async (ctx, request) => {
    const config = configFor(request);
    if (!config) return failure("not_found", 404);
    const p = await boundedForm(request);
    if (!p || request.headers.has("Authorization") || p.get("client_id") !== config.clientId) return failure("invalid_client");
    // Some configured clients omit the repeated token-request resource. The
    // grant already binds the only resource, and any different value is denied.
    if (p.has("resource") && p.get("resource") !== config.resource) return failure("invalid_target");
    const type = p.get("grant_type");
    const next = opaque();
    const nextHash = await digest(next);
    let granted;
    if (type === "authorization_code") {
      const code = p.get("code");
      const verifier = p.get("code_verifier");
      const callback = p.get("redirect_uri");
      if ([...p.keys()].some(key => !["grant_type", "client_id", "resource", "code", "code_verifier", "redirect_uri"].includes(key)) ||
          !code || !opaquePattern.test(code) || !verifier || !verifierPattern.test(verifier) || callback !== config.callback) {
        return failure("invalid_grant");
      }
      granted = await ctx.runMutation(exchange, { kind: "code", hash: await digest(code), nextHash,
        challenge: await digest(verifier), callback });
    } else if (type === "refresh_token" && config.refresh) {
      const previous = p.get("refresh_token");
      if ([...p.keys()].some(key => !["grant_type", "client_id", "resource", "refresh_token"].includes(key)) ||
          !previous || !opaquePattern.test(previous)) return failure("invalid_grant");
      granted = await ctx.runMutation(exchange, { kind: "refresh", hash: await digest(previous), nextHash });
    } else {
      return failure("unsupported_grant_type");
    }
    if (!granted) return failure("invalid_grant");
    try {
      return json({ ...await signAccess(config, granted.scopes), ...(granted.refresh ? { refresh_token: next } : {}) });
    } catch {
      return failure("server_error", 500);
    }
  }) });
  http.route({ path: routes.revoke, method: "POST", handler: httpAction(async (ctx, request) => {
    const config = configFor(request);
    if (!config) return failure("not_found", 404);
    const p = await boundedForm(request);
    if (!p || request.headers.has("Authorization") || p.get("client_id") !== config.clientId) return failure("invalid_client");
    const token = p.get("token");
    if (!token || [...p.keys()].some(key => !["client_id", "token", "token_type_hint"].includes(key))) {
      return failure("invalid_request");
    }
    if (opaquePattern.test(token)) await ctx.runMutation(revoke, { hash: await digest(token) });
    return new Response(null, { headers: noStore });
  }) });
}
