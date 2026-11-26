import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { backend, cleanup, designatedTarget, stage, stageEnvironment } from "./staging.mjs";

const fixtureSubject = "klaxon-dot-fixture";
const originalTitle = "Dot fixture ready for rename";
const updatedTitle = "Dot fixture renamed";
const reason = "Verify the authorized synthetic task edit";
const scopes = ["tasks:read", "tasks:write"];
const oauthVars = ["DOT_OAUTH_ENABLED", "DOT_OAUTH_SETUP_ORIGIN", "DOT_OAUTH_ORIGIN", "DOT_OAUTH_CLIENT_ID", "DOT_OAUTH_REDIRECT_URI",
  "DOT_OAUTH_PRIVATE_JWK", "DOT_OAUTH_PASSPHRASE_SHA256", "DOT_OAUTH_REFRESH", "DOT_OAUTH_EXPIRES_AT",
  "DOT_OAUTH_WORKSPACE_ID", "DOT_OAUTH_TASK_ID", "DOT_OAUTH_CREATE_ID", "DOT_OAUTH_UPDATE_ID", "KLAXON_OAUTH_ISSUER",
  "KLAXON_OAUTH_JWKS_URL", "KLAXON_OAUTH_RESOURCE", "KLAXON_OAUTH_BINDINGS"];

function check(ok, message) {
  if (!ok) throw new Error(message);
}

export function freshSnapshot({ tablesOut, tablesErr, envOut, envErr, spec }, url) {
  return tablesOut.trim() === "" && /There are no tables in the (?:[^\r\n]+ )?database\./.test(tablesErr) &&
    envOut.trim() === "" && /No environment variables set/.test(envErr) &&
    spec.url === url && Array.isArray(spec.functions) && spec.functions.length === 0;
}

function cli(project, target, args, input) {
  const result = spawnSync(process.execPath, [join(backend, "node_modules", "convex", "bin", "main.js"), ...args], {
    cwd: project, env: { ...stageEnvironment(), CI: "1", NO_COLOR: "1", CONVEX_DEPLOY_KEY: target.key },
    input, windowsHide: true, timeout: 150_000, encoding: "utf8", maxBuffer: 1_048_576,
  });
  check(result.status === 0, "The pinned Convex CLI could not complete an operator command");
  return result;
}

function readFixtureConfig(target) {
  const { DOT_OAUTH_CLIENT_ID: clientId, DOT_OAUTH_REDIRECT_URI: redirect,
    DOT_OAUTH_PRIVATE_JWK: privateJwk, DOT_OAUTH_PASSPHRASE_SHA256: passphraseHash,
    DOT_OAUTH_REFRESH: refresh, DOT_OAUTH_EXPIRES_AT: expiresAtText } = process.env;
  const expiresAt = Number(expiresAtText);
  let callback, jwk, privateKey;
  try {
    callback = new URL(redirect);
    jwk = JSON.parse(privateJwk);
    privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  } catch {
    throw new Error("Valid synthetic OAuth callback and fixture signing key are required");
  }
  check(callback.protocol === "https:" && callback.href === redirect && !callback.username && !callback.password &&
    !callback.hash && !callback.search && !callback.port && redirect.length <= 512 &&
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(callback.hostname) &&
    !/\.(?:local|localhost|internal|test|invalid|example)$/.test(callback.hostname) && !/[?#*\s]|%(?:25)*2a/i.test(redirect) &&
    typeof clientId === "string" && /^[A-Za-z0-9_.~-]{1,128}$/.test(clientId) &&
    /^[a-f0-9]{64}$/.test(passphraseHash ?? "") && jwk.kty === "RSA" &&
    privateKey.asymmetricKeyDetails.modulusLength >= 2048 && /^[A-Za-z0-9_-]{1,64}$/.test(jwk.kid ?? "") &&
    (jwk.alg === undefined || jwk.alg === "RS256") &&
    (refresh === undefined || refresh === "true"), "Synthetic OAuth configuration is outside fixture bounds");
  check(/^\d{13}$/.test(expiresAtText ?? "") && Number.isSafeInteger(expiresAt) &&
    expiresAt > Date.now() + 120_000 && expiresAt <= Date.now() + 60 * 60_000,
    "Synthetic OAuth cutoff must be between two minutes and one hour from now");
  const resource = target.site + "/mcp";
  return { clientId, privateKey, kid: jwk.kid, resource, expiresAt, values: {
    DOT_OAUTH_ORIGIN: target.site, DOT_OAUTH_CLIENT_ID: clientId, DOT_OAUTH_REDIRECT_URI: redirect,
    DOT_OAUTH_PRIVATE_JWK: JSON.stringify(jwk), DOT_OAUTH_PASSPHRASE_SHA256: passphraseHash, DOT_OAUTH_REFRESH: refresh,
    DOT_OAUTH_EXPIRES_AT: expiresAtText,
    KLAXON_OAUTH_ISSUER: target.site, KLAXON_OAUTH_JWKS_URL: target.site + "/dot-oauth/jwks",
    KLAXON_OAUTH_RESOURCE: resource,
  } };
}

function tokenFor(target, config) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = [encode({ alg: "RS256", typ: "at+jwt", kid: config.kid }), encode({
    iss: target.site, aud: config.resource, sub: fixtureSubject, client_id: config.clientId,
    scope: scopes.join(" "), iat: now, exp: Math.min(now + 300, Math.floor(config.expiresAt / 1000)),
  })].join(".");
  return data + "." + sign("RSA-SHA256", Buffer.from(data), config.privateKey).toString("base64url");
}

export async function readInitialization(response) {
  if (response.headers.get("content-type")?.split(";")[0].trim() === "text/event-stream") {
    const blocks = (await response.text()).split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (data) {
        const rpc = JSON.parse(data);
        if (rpc.id === 1) return rpc;
      }
    }
    throw new Error("Missing streamed MCP initialization");
  }
  return response.json();
}

async function mcpStatus(resource, token) {
  const response = await fetch(resource, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-operator", version: "1" },
    } }),
  });
  if (response.ok) {
    const rpc = await readInitialization(response);
    check(rpc.id === 1 && rpc.result?.protocolVersion === "2025-11-25" &&
      rpc.result?.serverInfo?.name === "klaxon" && rpc.result?.capabilities?.tools,
      "Unexpected MCP initialization response");
  } else {
    await response.body?.cancel();
  }
  return response.status;
}

export async function checkDiscovery(site, resource, fetcher = fetch) {
  const get = path => fetcher(site + path, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const protectedResourcePath = "/.well-known/oauth-protected-resource/mcp";
  const challenge = await get("/mcp");
  await challenge.body?.cancel();
  check(challenge.status === 401 && challenge.headers.get("www-authenticate")?.includes(
    'resource_metadata="' + site + protectedResourcePath + '"'), "Missing protected resource challenge");
  async function metadata(path) {
    const response = await get(path);
    check(response.ok, "OAuth discovery request failed");
    return response.json();
  }
  const protectedResource = await metadata(protectedResourcePath);
  check(protectedResource.resource === resource && protectedResource.authorization_servers?.length === 1 &&
    protectedResource.authorization_servers[0] === site && protectedResource.scopes_supported?.length === scopes.length &&
    scopes.every(scope => protectedResource.scopes_supported.includes(scope)), "Unexpected resource metadata");
  const issuer = await metadata("/.well-known/oauth-authorization-server");
  check(issuer.issuer === site && issuer.authorization_endpoint === site + "/dot-oauth/authorize" &&
    issuer.token_endpoint === site + "/dot-oauth/token" && issuer.code_challenge_methods_supported?.includes("S256"),
    "Unexpected OAuth issuer metadata");
}

function disable(project, target) {
  const names = new Set(cli(project, target, ["env", "list", "--names-only"]).stdout.trim().split(/\s+/));
  const failures = [];
  for (const name of oauthVars) {
    if (!names.has(name)) continue;
    try { cli(project, target, ["env", "unset", name]); }
    catch { failures.push(name); }
  }
  check(failures.length === 0, "Disposable OAuth environment cleanup was incomplete");
}

async function prompt(message, expiresAt) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(message, { signal: AbortSignal.timeout(Math.max(0, expiresAt - Date.now())) });
  } catch (error) {
    if (error.name === "AbortError") return "";
    throw error;
  }
  finally { terminal.close(); }
}

async function operate(mode) {
  const target = designatedTarget(process.env);
  const config = ["run", "connect", "retry"].includes(mode) ? readFixtureConfig(target) : null;
  const { project, directory } = await stage({ recovery: mode === "retire" });
  const require = createRequire(pathToFileURL(join(backend, "package.json")));
  const { ConvexHttpClient } = require("convex/browser");
  const { makeFunctionReference: ref } = require("convex/server");
  const admin = new ConvexHttpClient(target.url, { logger: false });
  admin.setAdminAuth(target.key);
  let phase = "fresh-deployment preflight";
  let deployed = false;
  let owner, grant, credential, workspace;
  async function teardown() {
    const checks = { grantRevoked: false, ownerSessionsRevoked: false, fixtureConfigurationRemoved: false };
    try {
      const retired = await admin.function("dotOperator:retire", undefined, {});
      checks.grantRevoked = retired.grantRevoked === true;
      checks.ownerSessionsRevoked = retired.ownerSessionsRevoked === true;
      if (owner) checks.ownerSessionsRevoked &&= !(await owner.query(ref("auth:isAuthenticated"), {}));
    } catch { checks.ownerSessionsRevoked = false; }
    try {
      disable(project, target);
      checks.fixtureConfigurationRemoved = true;
    } catch { /* Report the redacted status and continue local cleanup. */ }
    console.log(JSON.stringify(checks));
    check(Object.values(checks).every(Boolean), "Fixture retirement was incomplete; use the documented recovery command");
  }
  try {
    if (mode === "retire") {
      phase = "emergency fixture retirement";
      check(await admin.function("dotOperator:retirementMarker", undefined, {}) === "klaxon-dot-disposable-v1",
        "The designated deployment does not contain the disposable fixture");
      await teardown();
      return;
    }
    const env = cli(project, target, ["env", "list", "--names-only"]);
    if (mode === "connect" || mode === "setup-discovery" || mode === "retry") {
      const names = env.stdout.trim();
      const dormant = !names && /No environment variables set/.test(env.stderr);
      const setupOnly = names === "DOT_OAUTH_SETUP_ORIGIN" &&
        cli(project, target, ["env", "get", "DOT_OAUTH_SETUP_ORIGIN"]).stdout.trim() === target.site;
      check((dormant || setupOnly) &&
        await admin.function("dotOperator:retirementMarker", undefined, {}) === "klaxon-dot-disposable-v1",
        "Expected an inactive disposable fixture");
      if (mode === "retry") {
        check(dormant, "Expected completed configuration teardown");
        cli(project, target, ["deploy", "--yes", "--typecheck", "enable"]);
      }
    } else {
      const tables = cli(project, target, ["data"]);
      const spec = JSON.parse(cli(project, target, ["function-spec"]).stdout);
      check(freshSnapshot({ spec, tablesOut: tables.stdout, tablesErr: tables.stderr,
        envOut: env.stdout, envErr: env.stderr }, target.url), "Fresh deployment verification failed");
      phase = "staged deployment";
      deployed = true;
      cli(project, target, ["deploy", "--yes", "--typecheck", "enable"]);
    }
    if (mode !== "retry") {
      check(await admin.function("dotOperator:requireEmpty", undefined, {}) === true, "Fresh database verification failed");
    }
    if (mode === "setup-discovery") {
      deployed = true;
      cli(project, target, ["deploy", "--yes", "--typecheck", "enable"]);
      check(await admin.function("dotOperator:requireEmpty", undefined, {}) === true, "Expected an empty setup fixture");
      cli(project, target, ["env", "set", "DOT_OAUTH_SETUP_ORIGIN"], target.site);
      await checkDiscovery(target.site, target.site + "/mcp");
      deployed = false;
      console.log(JSON.stringify({ discoveryReady: true, issuerEnabled: false, serverUrl: target.site + "/mcp" }));
      return;
    }
    if (mode === "stage-only") {
      deployed = false;
      console.log(JSON.stringify({ staged: true, issuerEnabled: false, tasks: 0, serverUrl: target.site + "/mcp" }));
      return;
    }
    deployed = true;

    phase = "synthetic owner and scoped grant setup";
    const account = { username: "dot-owner-" + randomUUID(), password: randomBytes(32).toString("hex") };
    let userId;
    if (mode === "retry") {
      const recovered = await admin.function("dotOperator:recoverBeforeConsent", undefined, { password: account.password });
      account.username = recovered.username;
      userId = recovered.userId;
    } else {
      userId = await admin.function("dotOperator:enroll", undefined, account);
    }
    const anonymous = new ConvexHttpClient(target.url, { logger: false });
    grant = await anonymous.mutation(ref("auth:signInWithUsernamePassword"), account);
    check(grant.status === "complete" && grant.tokens.userId === userId, "Synthetic owner session verification failed");
    owner = new ConvexHttpClient(target.url, { auth: grant.tokens.accessToken, logger: false });
    workspace = await owner.mutation(ref("workspaces:ensurePersonal"), {});
    check(workspace.ownerId === userId, "Synthetic owner workspace verification failed");
    credential = await owner.mutation(ref("agentCredentials:issue"), { workspaceId: workspace._id, scopes,
      tokenHash: createHash("sha256").update(randomBytes(32)).digest("hex"), label: "Dot disposable task fixture",
      expiresAt: config.expiresAt });
    const taskPublicId = randomUUID();
    const createOperationId = randomUUID();
    const updateOperationId = randomUUID();

    phase = "operator-enforced OAuth binding";
    const expectedPrincipal = { issuer: target.site, subject: fixtureSubject, clientId: config.clientId };
    const values = { ...config.values, DOT_OAUTH_WORKSPACE_ID: workspace.publicId, DOT_OAUTH_TASK_ID: taskPublicId,
      DOT_OAUTH_CREATE_ID: createOperationId, DOT_OAUTH_UPDATE_ID: updateOperationId, KLAXON_OAUTH_BINDINGS: JSON.stringify([{
      ...expectedPrincipal, workspacePublicId: workspace.publicId, credentialPublicId: credential.publicId,
    }]) };
    for (const [name, value] of Object.entries(values)) if (value !== undefined) cli(project, target, ["env", "set", name], value);
    const result = await owner.mutation(ref("agentCredentials:bindOAuth"), {
      workspaceId: workspace._id, publicId: credential.publicId, expectedPrincipal,
    });
    check(result.oauthBound === true, "Synthetic owner could not bind the grant");
    const inspect = (updated, revoked) => admin.function("dotOperator:inspect", undefined, {
      workspaceId: workspace._id, userId, credentialPublicId: credential.publicId, taskPublicId,
      title: updated ? updatedTitle : originalTitle, updated, revoked, clientId: config.clientId, issuer: target.site,
      createOperationId, updateOperationId,
    });
    const baseline = await inspect(false, false);
    phase = "hosted issuer discovery";
    cli(project, target, ["env", "set", "DOT_OAUTH_ENABLED"], "true");
    await checkDiscovery(target.site, config.resource);
    phase = "authenticated MCP initialization";
    check(await mcpStatus(config.resource, tokenFor(target, config)) === 200, "Independent OAuth MCP verification failed");
    console.log(JSON.stringify({ ...baseline, serverUrl: config.resource, title: originalTitle, updatedTitle, reason,
      createOperationId, updateOperationId }));
    phase = "one-task audit and retirement";
    const response = await prompt("Enter VERIFY after the one-task check, or press Enter to retire: ", config.expiresAt);
    if (response !== "VERIFY") return;
    const observed = await inspect(true, false);
    const token = tokenFor(target, config);
    check(await mcpStatus(config.resource, token) === 200, "Active OAuth grant verification failed");
    await owner.mutation(ref("agentCredentials:revoke"), { workspaceId: workspace._id, publicId: credential.publicId });
    const denied = await mcpStatus(config.resource, token);
    check(denied === 401, "Previously valid OAuth grant was still accepted");
    console.log(JSON.stringify({ ...observed, ...(await inspect(true, true)), revokedMcpStatus: denied }));
    await prompt("Have Dot retry its MCP read with the revoked grant. Press Enter afterward to remove the fixture configuration: ", config.expiresAt);
  } catch {
    throw new Error(`Operator check failed during ${phase}; details are suppressed to protect credentials`);
  } finally {
    try {
      if (deployed) await teardown();
    } finally {
      await cleanup(directory);
    }
  }
}

async function checkStage() {
  const { directory, project } = await stage();
  try {
    const result = spawnSync(process.execPath, [join(backend, "node_modules", "typescript", "bin", "tsc"), "--noEmit"], {
      cwd: project, env: stageEnvironment(), stdio: "inherit", windowsHide: true, timeout: 120_000,
    });
    check(result.status === 0, "The offline staged type check failed");
  } finally {
    await cleanup(directory);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, ...extra] = process.argv.slice(2);
  try {
    check(["check-stage", "stage-only", "setup-discovery", "connect", "run", "retry", "retire"].includes(mode) && !extra.length,
      "Expected check-stage, stage-only, setup-discovery, connect, run, or retire");
    if (mode === "check-stage") await checkStage();
    else await operate(mode);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(/^(Operator check failed during|An explicitly designated|Valid synthetic OAuth|Synthetic OAuth|Expected check-stage|The offline staged type check failed|Fixture retirement was incomplete)/.test(message)
      ? message : "Operator setup or cleanup failed; use the documented fixture retirement procedure");
    process.exitCode = 1;
  }
}
