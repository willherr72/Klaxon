import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { withLocalProvider } from "./provider.local.mjs";

test("a scoped agent uses the versioned task API on the official local backend", { timeout: 180_000 }, async () => {
  await withLocalProvider(async ({ url, siteUrl, adminKey }) => {
    const admin = new ConvexHttpClient(url, { logger: false });
    admin.setAdminAuth(adminKey);
    const account = { username: "agent-owner-" + randomUUID(), password: randomBytes(24).toString("hex") };
    await admin.function("auth:enrollWithUsernamePassword", undefined, account);
    const anonymous = new ConvexHttpClient(url, { logger: false });
    const grant = await anonymous.mutation(ref("auth:signInWithUsernamePassword"), account);
    assert.equal(grant.status, "complete");
    try {
      const owner = new ConvexHttpClient(url, { auth: grant.tokens.accessToken, logger: false });
      const workspace = await owner.mutation(ref("workspaces:ensurePersonal"), {});
      const bearer = "klx_" + randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(bearer).digest("hex");
      const scope = { workspacePublicId: workspace.publicId };
      const list = { ...scope, filter: { kind: "status", status: "ready" }, limit: 5 };
      const post = async (route, input, authenticated = true) => {
        const headers = { "Content-Type": "application/json" };
        if (authenticated) headers.Authorization = "Bearer " + bearer;
        const response = await fetch(new URL("/api/v1/tasks/" + route, siteUrl), {
          method: "POST", headers, body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        return response;
      };
      assert.equal((await post("list", list, false)).status, 401);
      const issued = await owner.mutation(ref("agentCredentials:issue"), {
        workspaceId: workspace._id, label: "Disposable planner", scopes: ["tasks:read", "tasks:write", "planning:read"],
        expiresAt: Date.now() + 3_600_000, tokenHash,
      });
      const command = { ...scope, publicId: randomUUID(), operationId: randomUUID(), reason: "Plan tomorrow",
        task: { title: "Synthetic planner item", status: "ready" } };
      const [first, retry] = await Promise.all([post("create", command), post("create", command)]);
      assert.ok(first.ok && retry.ok, "concurrent creates acknowledge");
      const receipt = await first.json();
      assert.deepEqual(await retry.json(), receipt);
      assert.equal(receipt.publicId, command.publicId);
      assert.equal(receipt.revision, 1);
      assert.equal((await post("create", { ...command, reason: "Different purpose" })).status, 409);
      const response = await post("list", list);
      assert.ok(response.ok);
      const { items } = await response.json();
      assert.deepEqual(items.map(({ publicId, title }) => ({ publicId, title })), [
        { publicId: command.publicId, title: command.task.title },
      ]);
      const patch = { ...scope, operationId: randomUUID(), publicId: command.publicId, expectedRevision: 1,
        patch: { title: "Confirmed planner item" }, reason: "Review complete" };
      const updated = await post("update", patch);
      assert.ok(updated.ok);
      assert.equal((await updated.json()).revision, 2);
      assert.equal((await post("update", { ...patch, operationId: randomUUID() })).status, 409);
      for (const mode of ["legacy", { pin: "2026-07-28" }]) {
        const agent = new Client({ name: "klaxon-local-check", version: "1.0.0" }, {
          versionNegotiation: { mode },
        });
        const transport = new StreamableHTTPClientTransport(new URL("/mcp", siteUrl), {
          authProvider: { token: async () => bearer },
        });
        try {
          await agent.connect(transport);
          const catalog = await agent.listTools();
          assert.ok(catalog.tools.some(tool => tool.name === "get_task"));
          const read = await agent.callTool({ name: "get_task", arguments: { publicId: command.publicId } });
          assert.ok(!read.isError);
          assert.equal(read.structuredContent.title, patch.patch.title);
          assert.equal(read.structuredContent.revision, 2);
          const context = await agent.callTool({ name: "get_planning_context",
            arguments: { date: "2026-11-26", timezone: "America/Chicago" } });
          assert.ok(!context.isError);
          assert.equal(context.structuredContent.workspacePublicId, workspace.publicId);
          assert.ok(context.structuredContent.tasks.items.some(item => item.publicId === command.publicId));
          const { workspacePublicId: _workspace, ...replay } = command;
          const retried = await agent.callTool({ name: "create_task", arguments: replay });
          assert.ok(!retried.isError);
          assert.deepEqual(retried.structuredContent, receipt);
        } finally {
          await agent.close();
        }
      }
      const activity = await owner.query(ref("activity:list"), { workspaceId: workspace._id, paginationOpts: { cursor: null, numItems: 20 } });
      assert.ok(activity.page.some(event => event.actor === "Agent - Disposable planner" && event.targetPublicId === command.publicId));
      await owner.mutation(ref("agentCredentials:revoke"), { workspaceId: workspace._id, publicId: issued.publicId });
      assert.equal((await post("create", command)).status, 401);
      assert.equal((await post("list", list)).status, 401);
    } finally {
      await anonymous.mutation(ref("auth:signOut"), { refreshToken: grant.tokens.refreshToken });
    }
  });
});
