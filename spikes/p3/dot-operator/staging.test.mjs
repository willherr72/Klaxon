import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkDiscovery, freshSnapshot } from "./operator.mjs";
import { cleanup, designatedTarget, stage, stageEnvironment } from "./staging.mjs";

test("discovery verifies the public challenge, pinned issuer and exact task scopes before handoff", async () => {
  const site = "https://fixture.example";
  const path = "/.well-known/oauth-protected-resource/mcp";
  const resource = { resource: site + "/mcp", authorization_servers: [site], scopes_supported: ["tasks:read", "tasks:write"] };
  const issuer = { issuer: site, authorization_endpoint: site + "/dot-oauth/authorize",
    token_endpoint: site + "/dot-oauth/token", code_challenge_methods_supported: ["S256"] };
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url === resource.resource) return new Response(null, { status: 401,
      headers: { "WWW-Authenticate": 'Bearer resource_metadata="' + site + path + '"' } });
    if (url === site + path) return Response.json(resource);
    assert.equal(url, site + "/.well-known/oauth-authorization-server");
    return Response.json(issuer);
  };
  await checkDiscovery(site, resource.resource, fetcher);
  resource.scopes_supported.push("planning:apply");
  await assert.rejects(checkDiscovery(site, resource.resource, fetcher), /resource metadata/);
});

test("designation accepts only an explicit matching Development deployment and padded standard Base64", () => {
  const values = {
    KLAXON_DOT_DEV_NAME: "fixture-testing",
    KLAXON_DOT_CONFIRM_FRESH: "fixture-testing",
    KLAXON_DOT_DEV_KEY: "dev:fixture-testing|test+/==",
  };
  assert.equal(designatedTarget(values).site, "https://fixture-testing.convex.site");
  assert.equal(designatedTarget(values).url, "https://fixture-testing.convex.cloud");
  for (const overrides of [
    { KLAXON_DOT_CONFIRM_FRESH: "different" }, { KLAXON_DOT_DEV_KEY: "prod:fixture-testing|test+/==" },
    { KLAXON_DOT_DEV_KEY: "dev:different-site|test+/==" }, { KLAXON_DOT_DEV_KEY: "dev:fixture-testing|wrong\nvalue" },
    { KLAXON_DOT_DEV_NAME: "fixture-testing.evil.example" },
  ]) assert.throws(() => designatedTarget({ ...values, ...overrides }), /explicitly designated/);
  assert.equal(Object.hasOwn(stageEnvironment(), "KLAXON_DOT_DEV_KEY"), false);
  assert.equal(Object.hasOwn(stageEnvironment(), "CONVEX_DEPLOY_KEY"), false);
});

test("preflight fails closed for any tables, functions, environment, or canonical origin mismatch", () => {
  const url = "https://fixture-testing.convex.cloud";
  const clean = { tablesOut: "", tablesErr: "There are no tables in the database.", envOut: "",
    envErr: "No environment variables set.", spec: { url, functions: [] } };
  assert.equal(freshSnapshot(clean, url), true);
  assert.equal(freshSnapshot({ ...clean, tablesOut: "tasks" }, url), false);
  assert.equal(freshSnapshot({ ...clean, envOut: "PROVIDER_SECRET" }, url), false);
  assert.equal(freshSnapshot({ ...clean, spec: { ...clean.spec, functions: [{}] } }, url), false);
  assert.equal(freshSnapshot(clean, "https://other-fixture.convex.cloud"), false);
});

test("temporary staging adds verification tools and removes only its marked directory", async () => {
  const root = await realpath(tmpdir());
  const neighbor = await mkdtemp(join(root, "klaxon-p3-dot-neighbor-"));
  await writeFile(join(neighbor, "keep"), "survives");
  const staged = await stage({ stageFixture: async project => {
    await mkdir(join(project, "convex"), { recursive: true });
    await writeFile(join(project, "convex", "schema.ts"), "export default defineSchema({});");
  } });
  try {
    assert.match(await readFile(join(staged.project, "convex", "schema.ts"), "utf8"), /dotOperatorState/);
    assert.match(await readFile(join(staged.project, "convex", "dotOperator.ts"), "utf8"), /export const requireEmpty/);
    await assert.rejects(() => cleanup(neighbor));
    await cleanup(staged.directory);
    await assert.rejects(() => stat(staged.directory), { code: "ENOENT" });
    assert.equal(await readFile(join(neighbor, "keep"), "utf8"), "survives");
  } finally {
    assert.equal(await realpath(neighbor), neighbor);
    await rm(join(neighbor, "keep"));
    await rm(neighbor, { recursive: true });
  }
});

test("staging refuses a scheduled cron module and removes its temporary directory", async () => {
  let directory;
  await assert.rejects(stage({ stageFixture: async project => {
    directory = join(project, "..");
    await mkdir(join(project, "convex"), { recursive: true });
    await writeFile(join(project, "convex", "schema.ts"), "export default defineSchema({});");
    await writeFile(join(project, "convex", "crons.ts"), "synthetic cron");
  } }), /omit all scheduled cron jobs/);
  await assert.rejects(() => stat(directory), { code: "ENOENT" });
});
