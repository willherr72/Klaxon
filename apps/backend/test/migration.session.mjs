import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { withLocalProvider } from "./provider.local.mjs";

test("imports the SQLite CLI output and restores the exported workspace on local Convex", { timeout: 180_000 }, async () => {
  const scratch = await mkdtempDisposable(join(tmpdir(), "klaxon-p1-migration-"));
  try {
    const dbPath = join(scratch.path, "legacy.sqlite");
    const output = join(scratch.path, "export");
    execFileSync("python", ["-B", "-c",
      "from pathlib import Path; import sys; from probe import seed_fixture; seed_fixture(Path(sys.argv[1]))", dbPath],
      { cwd: fileURLToPath(new URL("../../../spikes/migration/", import.meta.url)), windowsHide: true });
    const cli = fileURLToPath(new URL("../../../tools/migration/export_legacy.py", import.meta.url));
    execFileSync("python", ["-B", cli, "export", "--source", "desktop=" + dbPath, "--output", output], { windowsHide: true });
    execFileSync("python", ["-B", cli, "verify", "--output", output], { windowsHide: true });
    const [manifest, projection, report] = await Promise.all(["manifest", "projection", "report"]
      .map(name => readFile(join(output, name + ".json"), "utf8")));

    await withLocalProvider(async ({ url, adminKey }) => {
      const admin = new ConvexHttpClient(url, { logger: false });
      admin.setAdminAuth(adminKey);
      const credentials = { username: "migration-" + randomUUID(), password: randomBytes(24).toString("base64url") };
      await admin.function("auth:enrollWithUsernamePassword", undefined, credentials);
      const client = new ConvexHttpClient(url, { logger: false });
      const { tokens, status } = await client.mutation(ref("auth:signInWithUsernamePassword"), credentials);
      assert.equal(status, "complete");
      client.setAuth(tokens.accessToken);
      try {
        const home = await client.mutation(ref("workspaces:ensurePersonal"), {});
        const target = await client.mutation(ref("imports:createWorkspace"), { workspaceId: home._id, operationId: randomUUID() });
        const args = { workspaceId: target.workspaceId, operationId: randomUUID(), timezone: "UTC", manifest, projection, report };
        const imported = await client.mutation(ref("imports:apply"), args);
        assert.equal(imported.checkpoint.phase, "complete");
        assert.equal((await client.mutation(ref("imports:apply"), args))._id, imported._id);
        const { archive } = await client.query(ref("backups:exportWorkspace"), { workspaceId: target.workspaceId });
        const payload = JSON.parse(archive).payload;
        const records = JSON.parse(projection).records;
        assert.ok(records.tasks.length && records.steps.length && records.reminders.length);
        for (const [table, bucket] of [["tasks", "tasks"], ["taskSteps", "steps"], ["reminders", "reminders"],
          ["lanes", "lanes"], ["captures", "captures"], ["dayNotes", "dayNotes"]]) {
          assert.deepEqual(payload[table].map(row => row.publicId).sort(), records[bucket].map(row => row.publicId).sort());
        }
        const restore = { archive, operationId: randomUUID() };
        const restored = await client.mutation(ref("backups:restoreWorkspace"), restore);
        assert.notEqual(restored.workspaceId, target.workspaceId);
        assert.equal((await client.mutation(ref("backups:restoreWorkspace"), restore)).workspaceId, restored.workspaceId);
        assert.equal((await client.query(ref("backups:exportWorkspace"), { workspaceId: restored.workspaceId })).archive, archive);
      } finally {
        await client.mutation(ref("auth:signOut"), { refreshToken: tokens.refreshToken });
      }
    });
  } finally {
    await scratch.remove();
  }
});
