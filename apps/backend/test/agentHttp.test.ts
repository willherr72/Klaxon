import { internalMutationGeneric, internalQueryGeneric } from "convex/server";
import { convexTest } from "convex-test";
import { ConvexError, v } from "convex/values";
import { describe, expect, it, vi } from "vitest";
import schema from "../convex/schema";

const bearer = "klx_" + "a".repeat(64);
const hash = "c3803cb4df291c7b84c3cff95b79177b282aea3c8f1ffa470f346abcf24e4771";

function client(quota = 60) {
  let remaining = quota;
  return convexTest({
    schema,
    modules: {
      "../convex/_generated/inline-only.ts": async () => ({}),
      "../convex/http.ts": () => import("../convex/http"),
      "../convex/agentCredentials.ts": async () => ({
        chargeAgentRequest: internalMutationGeneric({
          args: { tokenHash: v.string(), workspacePublicId: v.string(), scope: v.string() },
          handler: (_, args) => {
            if (args.tokenHash !== hash || args.workspacePublicId !== "workspace") throw new ConvexError("AGENT_UNAUTHORIZED");
            if (remaining === 0) throw new ConvexError("AGENT_RATE_LIMITED");
            remaining--;
            return { workspacePublicId: args.workspacePublicId };
          },
        }),
      }),
      "../convex/agentTasks.ts": async () => ({
        get: internalQueryGeneric({
          args: { tokenHash: v.string(), workspacePublicId: v.string(), publicId: v.string() },
          handler: (_, args) => {
            if (args.tokenHash !== hash) throw new ConvexError("AGENT_UNAUTHORIZED");
            return { publicId: args.publicId, revision: 5 };
          },
        }),
        update: internalMutationGeneric({
          args: {
            tokenHash: v.string(), workspacePublicId: v.string(), publicId: v.string(),
            operationId: v.string(), reason: v.string(), expectedRevision: v.number(), patch: v.any(),
          },
          handler: () => {
            throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision: 5, diagnostic: bearer });
          },
        }),
      }),
    },
  });
}

const task = { workspacePublicId: "workspace", publicId: "task" };
const fields = { ...task, operationId: "operation", reason: "fixture", expectedRevision: 4 };
function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("agent task HTTP routes", () => {
  it("hashes the bearer before passing it to the task query", async () => {
    const res = await client().fetch("/api/v1/tasks/get", jsonRequest(task));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ publicId: "task", revision: 5 });
  });

  it.each([
    ["Basic " + bearer],
    ["Bearer " + bearer + ", Bearer " + bearer],
    ["Bearer klx_a"],
  ])("rejects malformed authorization headers", async (authorization) => {
    const res = await client().fetch("/api/v1/tasks/get", {
      ...jsonRequest(task), headers: { authorization, "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toEqual({ error: { code: "AGENT_UNAUTHORIZED" } });
  });

  it("rejects query strings on task routes", async () => {
    const res = await client().fetch("/api/v1/tasks/get?workspacePublicId=workspace", jsonRequest(task));
    expect(res.status).toBe(400);
  });

  it.each([
    { ...task, tokenHash: "forged" },
    { ...task, publicId: 123 },
    ["workspace", "task"],
  ])("rejects invalid JSON field shapes", async (body) => {
    const res = await client().fetch("/api/v1/tasks/get", jsonRequest(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "INVALID_ARGUMENT" } });
  });

  it("rejects oversized request bodies without needing Content-Length", async () => {
    const res = await client().fetch("/api/v1/tasks/get", jsonRequest({ ...task, padding: "a".repeat(32768) }));
    expect(res.status).toBe(413);
  });

  it("redacts conflict diagnostics and retains the current revision", async () => {
    const res = await client().fetch("/api/v1/tasks/update", jsonRequest({ ...fields, patch: { title: "Rename" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "REVISION_CONFLICT", currentRevision: 5 } });
  });

  it("returns a quota error after the budget is spent on a conflicting update", async () => {
    const app = client(1);
    const path = "/api/v1/tasks/update";
    const request = jsonRequest({ ...fields, patch: { title: "Rename" } });
    expect((await app.fetch(path, request)).status).toBe(409);
    const res = await app.fetch(path, request);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "AGENT_RATE_LIMITED" } });
  });
});

it("advertises configured OAuth resource metadata on the MCP unauthorized challenge", async () => {
  vi.stubEnv("KLAXON_OAUTH_ISSUER", "https://issuer.example");
  vi.stubEnv("KLAXON_OAUTH_JWKS_URL", "https://issuer.example/keys");
  vi.stubEnv("KLAXON_OAUTH_RESOURCE", "https://klaxon.example/mcp");
  try {
    const app = client();
    const challenge = await app.fetch("/mcp");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://klaxon.example/.well-known/oauth-protected-resource/mcp"',
    );
    const metadata = await app.fetch("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: "https://klaxon.example/mcp",
      authorization_servers: ["https://issuer.example"],
      scopes_supported: ["tasks:read", "tasks:write", "planning:read", "planning:preview", "planning:apply", "reminders:write", "captures:read", "captures:write", "activity:read", "activity:undo"],
      bearer_methods_supported: ["header"],
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
