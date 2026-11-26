import type { DataModelFromSchemaDefinition, GenericDatabaseWriter } from "convex/server";
import { convexTest } from "convex-test";
import schema from "../convex/schema";

type DataModel = DataModelFromSchemaDefinition<typeof schema>;
type Writer = GenericDatabaseWriter<DataModel>;
type NewTask = Omit<DataModel["tasks"]["document"], "_id" | "_creationTime">;

// convex-test locates the module root from a _generated path. These tests use
// inline functions, so a clean checkout needs neither codegen nor a deployment.
const modules = {
  "../convex/_generated/inline-only.ts": async () => {
    throw new Error("This test fixture supports inline Convex functions only");
  },
};
export const recordVersion = { createdAt: 1, updatedAt: 1, revision: 1 };

export function testBackend() {
  return convexTest({ schema, modules });
}

export async function insertWorkspace(db: Writer, publicId: string) {
  const ownerId = await db.insert("users", {});
  return db.insert("workspaces", { ownerId, name: publicId, publicId, ...recordVersion });
}

export function insertProject(db: Writer, workspaceId: NewTask["workspaceId"], publicId: string) {
  return db.insert("projects", { workspaceId, publicId, name: publicId, rank: 0, ...recordVersion });
}

export function taskRecord(
  workspaceId: NewTask["workspaceId"],
  publicId: string,
  fields: Partial<Omit<NewTask, "workspaceId" | "publicId">> = {},
): NewTask {
  return {
    workspaceId,
    publicId,
    title: publicId,
    status: "ready",
    priority: "normal",
    rank: 0,
    ...recordVersion,
    ...fields,
  };
}
