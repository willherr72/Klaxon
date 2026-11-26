import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { backend, cleanup, stage, stageEnvironment } from "./staging.mjs";

const require = createRequire(pathToFileURL(join(backend, "package.json")));
const { ConvexHttpClient } = require("convex/browser");
const { makeFunctionReference: ref } = require("convex/server");
const { withLocalProvider } = await import(pathToFileURL(join(backend, "test", "provider.local.mjs")).href);
test("the staged local deployment attests one scoped task and denies its revoked grant", { timeout: 240_000 }, async () => {
  await withLocalProvider(async ({ url, siteUrl, adminKey }) => {
    const { directory, project } = await stage();
    try {
      function cli(args, input) {
        const result = spawnSync(process.execPath, [join(backend, "node_modules", "convex", "bin", "main.js"), ...args], {
          cwd: project, input, windowsHide: true, timeout: 120_000, stdio: ["pipe", "ignore", "ignore"],
          env: { ...stageEnvironment(), CI: "1", CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
            CONVEX_PROVISION_HOST: "http://127.0.0.1:0", CONVEX_VERSION_API_ORIGIN: "http://127.0.0.1:0" },
        });
        assert.equal(result.status, 0, "Local staged Convex CLI command failed");
      }
      cli(["deploy", "--yes", "--typecheck", "disable"]);
      const admin = new ConvexHttpClient(url, { logger: false });
      admin.setAdminAuth(adminKey);
      assert.equal(await admin.function("dotOperator:requireEmpty", undefined, {}), true);
      const account = { username: "dot-owner-" + randomUUID(), password: randomBytes(32).toString("hex") };
      const userId = await admin.function("dotOperator:enroll", undefined, account);
      const anon = new ConvexHttpClient(url, { logger: false });
      const grant = await anon.mutation(ref("auth:signInWithUsernamePassword"), account);
      assert.equal(grant.status, "complete");
      assert.equal(grant.tokens.userId, userId);
      const owner = new ConvexHttpClient(url, { auth: grant.tokens.accessToken, logger: false });
      const workspace = await owner.mutation(ref("workspaces:ensurePersonal"), {});
      const bearer = "klx_" + randomBytes(32).toString("hex");
      const cred = await owner.mutation(ref("agentCredentials:issue"), { workspaceId: workspace._id,
        scopes: ["tasks:read", "tasks:write"], tokenHash: createHash("sha256").update(bearer).digest("hex"),
        label: "Dot disposable task fixture", expiresAt: Date.now() + 600_000 });
      const principal = { issuer: "https://dot-fixture.convex.site", subject: "klaxon-dot-fixture", clientId: "synthetic-test" };
      cli(["env", "set", "KLAXON_OAUTH_BINDINGS"], JSON.stringify([{
        ...principal, workspacePublicId: workspace.publicId, credentialPublicId: cred.publicId,
      }]));
      assert.equal((await owner.mutation(ref("agentCredentials:bindOAuth"), { workspaceId: workspace._id,
        publicId: cred.publicId, expectedPrincipal: principal })).oauthBound, true);
      const taskPublicId = randomUUID(), createOperationId = randomUUID(), updateOperationId = randomUUID();
      const inspect = (updated, revoked) => admin.function("dotOperator:inspect", undefined, {
        workspaceId: workspace._id, userId, credentialPublicId: cred.publicId, taskPublicId,
        title: updated ? "Changed synthetic task" : "Synthetic task", updated, revoked,
        clientId: principal.clientId, issuer: principal.issuer, createOperationId, updateOperationId,
      });
      assert.equal((await inspect(false, false)).tasks, 0);
      const rawBearer = await fetch(new URL("/mcp", siteUrl), { method: "POST", redirect: "error",
        headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json" }, body: "{}" });
      await rawBearer.body?.cancel();
      assert.equal(rawBearer.status, 401);
      // The public staged issuer requires hosted HTTPS. The local rehearsal supplies
      // verified synthetic claims to the same internal task handlers as MCP.
      const verifiedOAuth = { ...principal, scopes: ["tasks:read", "tasks:write"], expiresAt: Date.now() + 60_000 };
      assert.equal((await admin.function("agentCredentials:openMcpRequest", undefined, { verifiedOAuth })).workspacePublicId,
        workspace.publicId);
      const auth = { workspacePublicId: workspace.publicId, verifiedOAuth };
      const origin = "mcp";
      const call = (name, args) => admin.function("agentTasks:" + name, undefined, { ...args, ...auth, origin });
      const create = { publicId: taskPublicId, operationId: createOperationId, reason: "Synthetic rehearsal",
        task: { title: "Synthetic task", status: "ready" } };
      const receipt = await call("create", create);
      await call("update", { publicId: taskPublicId, operationId: updateOperationId, reason: "Synthetic rehearsal",
        expectedRevision: 1, patch: { title: "Changed synthetic task" } });
      assert.deepEqual(await call("create", create), receipt);
      const beforeRetire = await inspect(true, false);
      assert.equal(beforeRetire.tasks, 1);
      assert.equal(beforeRetire.activityEvents, 2);
      assert.deepEqual(await admin.function("dotOperator:retire", undefined, {}),
        { grantRevoked: true, ownerSessionsRevoked: true });
      assert.equal(await owner.query(ref("auth:isAuthenticated"), {}), false);
      assert.deepEqual(await admin.function("dotOperator:retire", undefined, {}),
        { grantRevoked: true, ownerSessionsRevoked: true });
      assert.equal((await inspect(true, true)).revoked, true);
      await assert.rejects(admin.function("agentCredentials:openMcpRequest", undefined, { verifiedOAuth }), /AGENT_UNAUTHORIZED/);
      const rejected = await fetch(new URL("/mcp", siteUrl), { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      await rejected.body?.cancel();
      assert.equal(rejected.status, 401);
      cli(["env", "unset", "KLAXON_OAUTH_BINDINGS"]);
    } finally {
      await cleanup(directory);
    }
  });
});
