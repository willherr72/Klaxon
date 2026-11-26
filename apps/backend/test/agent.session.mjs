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
        workspaceId: workspace._id, label: "Disposable planner", scopes: ["tasks:read", "tasks:write", "planning:read", "planning:preview", "planning:apply", "reminders:write", "captures:write", "captures:read", "activity:read"],
        expiresAt: Date.now() + 3_600_000, tokenHash,
      });
      const command = { ...scope, publicId: randomUUID(), operationId: randomUUID(), reason: "Plan tomorrow",
        task: { title: "Synthetic planner item", status: "ready", estimateMinutes: 25 } };
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
      const policy = { planApplication: "review", schedule: [], scope: { kind: "all" }, excludedTaskPublicIds: [], excludedProjectPublicIds: [] };
      await owner.mutation(ref("autonomy:update"), { workspaceId: workspace._id, operationId: randomUUID(), expectedRevision: 0, policy });
      // Select a future Monday across all runner time zones.
      const target = new Date(Date.now() + 7 * 86_400_000);
      target.setUTCDate(target.getUTCDate() + (8 - target.getUTCDay()) % 7);
      const localDate = target.toISOString().slice(0,10);
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
          if (mode !== "legacy") {
            const runTool = async (name, args) => {
              const result = await agent.callTool({name,arguments:args});
              assert.ok(!result.isError, name + " " + JSON.stringify(result.structuredContent?.error));
              return result.structuredContent;
            };
            const create = {publicId:randomUUID(),reason:"Record synthetic reminder",operationId:randomUUID(),
              reminder:{title:"Review later",timezone:"UTC",dueAt:Date.now()+86_400_000}};
            const firstReminder = await runTool("create_reminder",create);
            await runTool("update_reminder",{publicId:create.publicId,reason:"Rename the fixture",operationId:randomUUID(),
              expectedRevision:firstReminder.revision,patch:{title:"Plan verified"}});
            assert.deepEqual(await runTool("create_reminder",create),firstReminder);
            const captureId = randomUUID();
            await runTool("create_capture",{publicId:captureId,body:"Maintenance fixture",reason:"Log the observation",operationId:randomUUID()});
            assert.ok((await runTool("search_captures",{text:"Maintenance"})).items.some(item=>item.publicId===captureId));
            const fields = { briefing:"Review the verified maintenance task.", localDate, taskPublicIds: [command.publicId], expectedDayPlanRevision: null,
              operationId: randomUUID(), reason: "Review upcoming tasks" };
            const preview = await agent.callTool({ name: "preview_plan", arguments: fields });
            assert.ok(!preview.isError, JSON.stringify(preview.structuredContent?.error));
            const proposal = preview.structuredContent;
            assert.equal(proposal.placements[0].taskTitle, patch.patch.title);
            assert.equal(proposal.briefing,fields.briefing);
            const approval = { publicId: proposal.publicId, expectedRevision: proposal.revision, operationId: randomUUID() };
            const request = await fetch(new URL("/api/v1/planning/apply", siteUrl), {
              method: "POST", headers: { Authorization: "Bearer " + bearer, "Content-Type":"application/json" },
              body: JSON.stringify({ ...scope, ...approval, reason: "Apply the reviewed schedule" }),
            });
            assert.equal(request.status, 403);
            assert.deepEqual(await request.json(), {error:{code:"AUTONOMY_APPROVAL_REQUIRED"}});
            const pending = await owner.query(ref("agentPlans:pending"), { workspaceId: workspace._id });
            assert.deepEqual(pending.map(row => row.publicId), [proposal.publicId]);
            const approve = () => owner.mutation(ref("agentPlans:approve"), { workspaceId: workspace._id, ...approval });
            const a = await approve();
            assert.deepEqual(await approve(), a);
            const stored = await owner.query(ref("calendar:list"), { workspaceId: workspace._id, localDate, view: "day" });
            assert.equal(stored.blocks.filter(block => block.taskPublicId === command.publicId).length, 1);
            const plan = await runTool("get_day_plan",{date:localDate,timezone:"UTC"});
            assert.equal(plan.dayPlan.briefing,fields.briefing);
            const week = await runTool("list_calendar",{date:localDate,timezone:proposal.timezone,view:"week"});
            assert.equal(week.blocks.items.filter(block=>block.taskPublicId===command.publicId).length,1);
          }
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
