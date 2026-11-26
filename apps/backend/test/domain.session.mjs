import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { makeFunctionReference as ref } from "convex/server";
import { withLocalProvider } from "./provider.local.mjs";

async function until(check) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out observing the task subscription");
    await delay(50);
  }
}

test("two signed-in clients observe one committed write, replay and conflict", { timeout: 180_000 }, async () => {
  await withLocalProvider(async ({ url, adminKey }) => {
    const admin = new ConvexHttpClient(url, { logger: false });
    admin.setAdminAuth(adminKey);
    const credentials = { username: "p1-" + randomUUID(), password: randomBytes(24).toString("base64url") };
    await admin.function("auth:enrollWithUsernamePassword", undefined, credentials);
    const anonymous = new ConvexHttpClient(url, { logger: false });
    const grants = [];
    const sockets = [];
    try {
      for (let i = 0; i < 2; i++) {
        const result = await anonymous.mutation(ref("auth:signInWithUsernamePassword"), credentials);
        assert.equal(result.status, "complete");
        grants.push(result.tokens);
      }
      const clients = grants.map(grant => new ConvexHttpClient(url, { auth: grant.accessToken, logger: false }));
      const workspace = await clients[0].mutation(ref("workspaces:ensurePersonal"), {});
      const workspaceId = workspace._id;
      const rows = [undefined, undefined];
      let queryFailed = false;
      for (const [index, grant] of grants.entries()) {
        const socket = new ConvexClient(url, { unsavedChangesWarning: false, logger: false });
        sockets.push(socket);
        let signedIn = false;
        socket.setAuth(async () => grant.accessToken, authenticated => { signedIn = authenticated; });
        await until(() => signedIn);
        socket.onUpdate(ref("tasks:list"), {
          workspaceId, filter: { kind: "status", status: "inbox" }, paginationOpts: { numItems: 10, cursor: null },
        }, result => { rows[index] = result.page; }, () => { queryFailed = true; });
      }
      const both = predicate => until(() => {
        assert.equal(queryFailed, false, "Authenticated subscription failed");
        return rows.every(page => page && predicate(page));
      });
      await both(page => page.length === 0);
      const publicId = randomUUID();
      const create = { workspaceId, operationId: randomUUID(),
        command: { kind: "task.create", publicId, title: "First title", status: "inbox" } };
      const write = (index, args) => clients[index].mutation(ref("tasks:apply"), args);
      const [first, replay] = await Promise.all([write(0, create), write(1, create)]);
      assert.deepEqual(replay, first);
      assert.equal(first.revision, 1);
      await both(page => page.length === 1 && page[0].publicId === publicId && page[0].revision === 1);
      const rename = title => ({ workspaceId, operationId: randomUUID(),
        command: { kind: "task.update", publicId, expectedRevision: 1, patch: { title } } });
      const updates = [rename("Session A"), rename("Session B")];
      const results = await Promise.allSettled(updates.map((request, index) => write(index, request)));
      const winner = results.findIndex(result => result.status === "fulfilled");
      assert.ok(winner >= 0);
      assert.equal(results[winner].value.revision, 2);
      assert.equal(results[1 - winner].status, "rejected");
      assert.equal(results[1 - winner].reason.data?.code, "REVISION_CONFLICT");
      await both(page => page.length === 1 && page[0].title === updates[winner].command.patch.title && page[0].revision === 2);
    } finally {
      try {
        await Promise.all(sockets.map(socket => socket.close()));
      } finally {
        await Promise.all(grants.map(grant => anonymous.mutation(ref("auth:signOut"), { refreshToken: grant.refreshToken })));
      }
    }
  });
});
