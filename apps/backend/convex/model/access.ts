import type { DataModelFromSchemaDefinition, GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import type schema from "../schema";

type Model = DataModelFromSchemaDefinition<typeof schema>;
type UserId = GenericId<"users">;

export function requireSessionUser(userId: UserId | null) {
  if (userId === null) throw new ConvexError("UNAUTHENTICATED");
  return userId;
}

export async function authorize(db: GenericDatabaseReader<Model>, workspaceId: GenericId<"workspaces">,
  userId: UserId, capability: "read" | "write" | "manage") {
  const [workspace, membership] = await Promise.all([
    db.get("workspaces", workspaceId),
    db.query("memberships").withIndex("by_workspace_user", q =>
      q.eq("workspaceId", workspaceId).eq("userId", userId)).unique(),
  ]);
  if (!workspace || !membership || (membership.role === "owner") !== (workspace.ownerId === userId)) {
    throw new ConvexError("WORKSPACE_UNAVAILABLE");
  }
  if ((capability === "manage" && membership.role !== "owner") ||
      (capability === "write" && membership.role === "reader")) {
    throw new ConvexError("FORBIDDEN");
  }
  return { workspace, role: membership.role };
}

export async function ensurePersonalWorkspace(db: GenericDatabaseWriter<Model>, userId: UserId) {
  const user = await db.get("users", userId);
  if (!user) throw new ConvexError("UNAUTHENTICATED");
  if (user.personalWorkspaceId) return (await authorize(db, user.personalWorkspaceId, userId, "manage")).workspace;
  const now = Date.now();
  const version = { revision: 1, createdAt: now, updatedAt: now };
  const id = await db.insert("workspaces", {
    ownerId: userId, name: "Personal", publicId: crypto.randomUUID(), ...version,
  });
  await db.insert("memberships", {
    workspaceId: id, userId, role: "owner", publicId: crypto.randomUUID(), ...version,
  });
  await db.patch("users", userId, { personalWorkspaceId: id });
  return (await authorize(db, id, userId, "manage")).workspace;
}
