import { ConvexError } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import type { authorizeAgent } from "./agentCredentials";
import type { OperationResult } from "./operations";
import { requiredText } from "./taskDomain";

export type AgentGrant = Awaited<ReturnType<typeof authorizeAgent>>;
export type AgentOrigin = "api" | "mcp";

export function requirePlanningOwner({ workspace, credential }: AgentGrant) {
  if (credential.userId !== workspace.ownerId) throw new ConvexError("FORBIDDEN");
}

export function agentReason(reason: string) {
  if (/[\x00-\x1f\x7f]/u.test(reason)) throw new ConvexError({ code: "INVALID_ARGUMENT", field: "reason" });
  return requiredText(reason, "reason", 512);
}

export async function portableAgentReceipt(db: DatabaseReader, result: OperationResult) {
  const event = await db.get("activityEvents", result.activityEventId);
  if (!event) throw new Error("Missing operation activity");
  return { workspacePublicId: result.workspacePublicId, publicId: result.targetPublicId,
    revision: result.revision, activityEventPublicId: event.publicId };
}
