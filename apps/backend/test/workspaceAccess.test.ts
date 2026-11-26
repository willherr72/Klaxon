import { expect, test } from "vitest";
import { authorize, ensurePersonalWorkspace, requireSessionUser } from "../convex/model/access";
import { testBackend } from "./fixtures";

test("personal workspace initialization is idempotent and grants access only to its owner", async () => {
  const t = testBackend();
  const { alice, bob, space } = await t.run(async ({ db }) => {
    const alice = await db.insert("users", {});
    const bob = await db.insert("users", {});
    const space = await ensurePersonalWorkspace(db, alice);
    expect((await ensurePersonalWorkspace(db, alice))._id).toBe(space._id);
    return { alice, bob, space };
  });
  await t.run(async ({ db }) => {
    expect((await authorize(db, space._id, alice, "manage")).role).toBe("owner");
    await expect(authorize(db, space._id, bob, "read")).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
    expect(await db.query("memberships").collect()).toHaveLength(1);
  });
});

test("workspace permissions follow the current membership on each operation", async () => {
  const t = testBackend();
  await t.run(async ({ db }) => {
    const owner = await db.insert("users", {});
    const member = await db.insert("users", {});
    const workspace = await ensurePersonalWorkspace(db, owner);
    const grant = await db.insert("memberships", { workspaceId: workspace._id, userId: member,
      role: "reader", publicId: "member", revision: 1, createdAt: 1, updatedAt: 1 });
    expect((await authorize(db, workspace._id, member, "read")).role).toBe("reader");
    await expect(authorize(db, workspace._id, member, "write")).rejects.toThrow(/FORBIDDEN/);
    await db.patch(grant, { role: "planner" });
    expect((await authorize(db, workspace._id, member, "write")).role).toBe("planner");
    await expect(authorize(db, workspace._id, member, "manage")).rejects.toThrow(/FORBIDDEN/);
    await db.patch(grant, { role: "owner" });
    await expect(authorize(db, workspace._id, member, "manage")).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
    await db.delete(grant);
    await expect(authorize(db, workspace._id, member, "read")).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  });
});

test("missing authenticated session cannot supply a user", () => {
  expect(() => requireSessionUser(null)).toThrow(/UNAUTHENTICATED/);
});

test("a separately owned restored workspace cannot become the default personal workspace", async () => {
  const t = testBackend();
  await t.run(async ({ db }) => {
    const userId = await db.insert("users", {});
    const version = { createdAt: 1, updatedAt: 1, revision: 1 };
    const restored = await db.insert("workspaces", { ...version, ownerId: userId, publicId: "old", name: "Personal" });
    await db.insert("memberships", { ...version, workspaceId: restored, userId, role: "owner", publicId: "m" });
    const personal = await ensurePersonalWorkspace(db, userId);
    expect(personal._id).not.toBe(restored);
    expect((await ensurePersonalWorkspace(db, userId))._id).toBe(personal._id);
  });
});
