import { ConvexError } from "convex/values";
import { env } from "../_generated/server";
import type { AgentAuthProof } from "../model/agentHttp";
import { fixtureConfig, subject } from "./config";

const reason = "Verify the authorized synthetic task edit";
const initialTitle = "Dot fixture ready for rename";
const updatedTitle = "Dot fixture renamed";
export const fixtureTools: ReadonlySet<string> = new Set(["list_tasks", "get_task", "create_task", "update_task"]);

export function requireFixtureSession(proof: AgentAuthProof) {
  const config = fixtureConfig(env);
  if (!config || !("verifiedOAuth" in proof) || proof.verifiedOAuth.issuer !== config.origin ||
      proof.verifiedOAuth.clientId !== config.clientId || proof.verifiedOAuth.subject !== subject) {
    throw new ConvexError("AGENT_UNAUTHORIZED");
  }
  return config;
}

function exact(value: unknown, expected: Record<string, unknown>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(expected);
  return Object.keys(value).length === keys.length && keys.every(key => {
    if (!Object.hasOwn(value, key)) return false;
    const actual = (value as Record<string, unknown>)[key];
    const target = expected[key];
    return typeof target === "object" && target !== null ? exact(actual, target as Record<string, unknown>) : actual === target;
  });
}

export function requireFixtureOperation(name: string, args: Record<string, unknown>, proof: AgentAuthProof,
  grant: { workspacePublicId: string } | undefined) {
  const config = requireFixtureSession(proof);
  if (!grant || grant.workspacePublicId !== config.workspaceId) throw new ConvexError("FORBIDDEN");

  const { taskId: publicId, createId, updateId } = config;
  const list = { filter: { kind: "status", status: "ready" } };
  if ((name === "list_tasks" && (exact(args, list) || exact(args, { ...list, limit: 1 }))) ||
      (name === "get_task" && exact(args, { publicId })) ||
      (name === "create_task" && exact(args, { publicId, operationId: createId, reason,
        task: { title: initialTitle, status: "ready" } })) ||
      (name === "update_task" && exact(args, { publicId, operationId: updateId, reason, expectedRevision: 1,
        patch: { title: updatedTitle } }))) return config;
  throw new ConvexError("FORBIDDEN");
}

export function fixtureTaskList(page: unknown, taskId: string) {
  if (typeof page !== "object" || page === null || !("items" in page) || !Array.isArray(page.items) ||
      !("nextCursor" in page) || page.nextCursor !== null || page.items.length > 1 ||
      page.items.some(task => task?.publicId !== taskId || task.status !== "ready")) {
    throw new ConvexError("FORBIDDEN");
  }
  return page;
}
