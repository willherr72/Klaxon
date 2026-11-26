import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { hashAgentToken } from "../convex/model/agentCredentials";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

const bearer = "klx_" + "b".repeat(64);

async function fixture(scopes: string[] = ["tasks:read"]) {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/http.ts": () => import("../convex/http"),
    "../convex/agentCredentials.ts": () => import("../convex/agentCredentials"),
    "../convex/agentPlanningContext.ts": () => import("../convex/agentPlanningContext"),
    "../convex/agentTasks.ts": () => import("../convex/agentTasks"),
  } });
  const tokenHash = await hashAgentToken(bearer);
  const credentialId = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, "mcp-workspace");
    const { ownerId: userId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId, role: "owner", publicId: "owner", ...recordVersion });
    await db.insert("tasks", taskRecord(workspaceId, "sample-task", { title: "Review sample" }));
    return db.insert("agentCredentials", { workspaceId, userId, label: "MCP test", publicId: "mcp-grant",
      scopes, tokenHash, expiresAt: Date.now() + 60_000, ...recordVersion });
  });
  const post = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) =>
    t.fetch("/mcp", { method: "POST", headers: {
      accept: "application/json, text/event-stream", "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25", authorization: `Bearer ${bearer}`, ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { t, credentialId, post };
}

async function message(response: Response) {
  expect(response.status).toBe(200);
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
  const body = await response.text();
  return JSON.parse(body.split("\n").find(line => line.startsWith("data: "))!.slice(6));
}

test("the MCP resource accepts a signed access token only for the bound client and authorized scopes", async () => {
  const { t, credentialId, post } = await fixture(["tasks:read","tasks:write"]);
  const issuer = "https://issuer.example.test", resource = "https://planner.example.test/mcp";
  const subject = "test-agent", clientId = "dot-test-client";
  const principal = { issuer, subject, clientId };
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = { keys: [{ ...await exportJWK(publicKey), kid: "integration", use: "sig" }] };
  const sign = (client: string) => new SignJWT({ client_id: client, scope: "tasks:read" })
    .setProtectedHeader({ typ: "at+jwt", alg: "RS256", kid: "integration" })
    .setIssuer(issuer).setAudience(resource).setSubject(subject).setIssuedAt().setExpirationTime("4m").sign(privateKey);
  vi.stubEnv("KLAXON_OAUTH_ISSUER", issuer);
  vi.stubEnv("KLAXON_OAUTH_RESOURCE", resource);
  vi.stubEnv("KLAXON_OAUTH_JWKS_URL", issuer + "/keys");
  vi.stubEnv("KLAXON_OAUTH_BINDINGS", JSON.stringify([{ ...principal, workspacePublicId: "mcp-workspace", credentialPublicId: "mcp-grant" }]));
  vi.stubGlobal("fetch", async (url: RequestInfo | URL) => {
    expect(String(url)).toBe(issuer + "/keys");
    return Response.json(keys);
  });
  try {
    const headers = { authorization: "Bearer " + await sign(clientId) };
    const unbound = await post("tools/list", {}, headers);
    expect(unbound.status).toBe(401);
    expect(unbound.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp");
    await t.run(({db}) => db.patch(credentialId, { oauthPrincipal: principal }));
    const list = await message(await post("tools/list", {}, headers));
    expect(list.result.tools.map((tool: {name: string}) => tool.name)).toEqual(["list_tasks","get_task"]);
    const result = await message(await post("tools/call", { name: "get_task", arguments: {publicId:"sample-task"} }, headers));
    expect(result.result.structuredContent.title).toBe("Review sample");
    expect((await post("tools/list", {}, {authorization: "Bearer " + await sign("other-client")})).status).toBe(401);
    await t.run(({db}) => db.patch(credentialId, { revokedAt: Date.now() }));
    expect((await post("tools/list", {}, headers)).status).toBe(401);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test("lists only tools allowed by the current grant", async () => {
  const { post } = await fixture();
  const { result } = await message(await post("tools/list", {}));
  expect(result.tools.map(({ name }: { name: string }) => name)).toEqual(["list_tasks", "get_task"]);
  expect(result.tools[1].inputSchema).toMatchObject({ properties: { publicId: { type: "string" } },
    required: ["publicId"], additionalProperties: false });
});

test("uses bearer-derived workspace to read and rejects a forged workspace argument", async () => {
  const { post } = await fixture();
  const invoke = (args: Record<string, string>) => post("tools/call", { name: "get_task", arguments: args });
  expect((await message(await invoke({ publicId: "sample-task" }))).result.structuredContent)
    .toMatchObject({ publicId: "sample-task", title: "Review sample" });
  const rejected = await message(await invoke({ publicId: "sample-task", workspacePublicId: "forged" }));
  expect(rejected.result?.isError ?? !!rejected.error).toBe(true);
});

test("rejects foreign origins and revocation applies on the next request", async () => {
  const { t, credentialId, post } = await fixture();
  expect((await post("tools/list", {}, { origin: "https://example.invalid" })).status).toBe(403);
  await t.run(({ db }) => db.patch("agentCredentials", credentialId, { revokedAt: Date.now() }));
  const result = await post("tools/list", {});
  expect(result.status).toBe(401);
  expect(result.headers.get("www-authenticate")).toMatch(/^Bearer\b/);
});

test("an MCP write and its HTTPS retry share a receipt and audit the original transport", async () => {
  const { t, post } = await fixture(["tasks:write"]);
  const args = { publicId: "agent-created", operationId: "ff5bbb77-8143-46a6-838d-6ff5c22b0ad0",
    reason: "Record synthetic action", task: { title: "Review terms" } };
  const call = await message(await post("tools/call", { name: "create_task", arguments: args }));
  expect(call.result.structuredContent).toMatchObject({ publicId: "agent-created", revision: 1 });
  const retry = await t.fetch("/api/v1/tasks/create", { method: "POST",
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: JSON.stringify({ workspacePublicId: "mcp-workspace", ...args }),
  });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(call.result.structuredContent);
  const activity = await t.run(({ db }) => db.query("activityEvents").collect());
  expect(activity).toHaveLength(1);
  expect(activity[0]).toMatchObject({ actor: { kind: "agent" }, origin: "mcp", reason: args.reason });
});

test("planning context is separately scoped on both HTTPS and MCP", async () => {
  const { t, post } = await fixture(["planning:read"]);
  const { result: discovery } = await message(await post("tools/list", {}));
  expect(discovery.tools.map(({ name }: { name: string }) => name)).toEqual(["get_planning_context"]);
  const args = { date: "2028-03-12", timezone: "America/Chicago" };
  const { result } = await message(await post("tools/call", { name: "get_planning_context", arguments: args }));
  expect(result.structuredContent).toMatchObject({ ...args, workspacePublicId: "mcp-workspace",
    tasks: { items: [{ publicId: "sample-task", revision: 1 }] } });
  const https = (backend = t, workspacePublicId = "mcp-workspace") => backend.fetch("/api/v1/planning/context", { method: "POST",
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: JSON.stringify({ workspacePublicId, ...args }),
  });
  expect(await (await https()).json()).toMatchObject({ ...args, startAt: result.structuredContent.startAt, timezone: args.timezone });
  expect((await https(t, "foreign")).status).toBe(401);
  expect((await https((await fixture(["tasks:read"])).t)).status).toBe(403);
});

test("charges discovery, rejected tool input and a successful read once each", async () => {
  const { t, credentialId, post } = await fixture();
  await message(await post("tools/list", {}));
  await message(await post("tools/call", { name: "get_task", arguments: {} }));
  await message(await post("tools/call", { name: "get_task", arguments: { publicId: "sample-task" } }));
  expect((await t.run(({db}) => db.get(credentialId)))?.rateWindowRequests).toBe(3);
  await t.run(({db}) => db.patch(credentialId, { rateWindowStartedAt: Date.now(), rateWindowRequests: 60 }));
  expect((await post("tools/list", {})).status).toBe(429);
});
