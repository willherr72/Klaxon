import type { DataModelFromSchemaDefinition, GenericDatabaseWriter } from "convex/server";
import { ConvexError } from "convex/values";
import type schema from "../schema";

type Model = DataModelFromSchemaDefinition<typeof schema>;
type Writer = GenericDatabaseWriter<Model>;
type Workspace = Model["workspaces"]["document"];
type ActivityEvent = Model["activityEvents"]["document"];

export type OperationInput = null | boolean | number | string | readonly OperationInput[]
  | { readonly [key: string]: OperationInput | undefined };

export type OperationRequest = {
  workspace: Pick<Workspace, "_id" | "publicId">;
  actor: ActivityEvent["actor"];
  origin: ActivityEvent["origin"];
  action: string;
  operationId: string;
  targetPublicId?: string;
  expectedRevision?: number;
  input: OperationInput;
};

export type OperationChange = {
  target: ActivityEvent["target"];
  targetPublicId: string;
  revision: number;
  beforeRevision?: number;
  inverse?: Omit<Model["taskUndoChanges"]["document"], "_id" | "_creationTime" | "workspaceId" | "eventId">;
  reason?: "Reversed a reviewed task change";
};

export type OperationResult = {
  workspacePublicId: string;
  targetPublicId: string;
  revision: number;
  activityEventId: ActivityEvent["_id"];
};

const fingerprintVersion = 1;
const maxInputBytes = 64 * 1024;
const maxInputDepth = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalidArgument(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

function actorKey(actor: ActivityEvent["actor"]): string {
  switch (actor.kind) {
    case "user": return `user:${actor.userId}`;
    case "agent": return `agent:${actor.credentialId}`;
    case "integration": return `integration:${actor.connectionId}`;
    case "system": return `system:${actor.job}`;
  }
}

function canonicalBytes(input: OperationInput): Uint8Array<ArrayBuffer> {
  const segments: string[] = [];
  let length = 0;
  function append(segment: string) {
    length += segment.length;
    if (length > maxInputBytes) invalidArgument("Operation input is too large");
    segments.push(segment);
  }

  function serialize(value: OperationInput | undefined, depth: number) {
    if (depth > maxInputDepth) invalidArgument("Operation input is nested too deeply");
    if (value === null || typeof value === "boolean") {
      append(JSON.stringify(value));
    } else if (typeof value === "number" && Number.isFinite(value)) {
      append(Object.is(value, -0) ? "-0" : JSON.stringify(value));
    } else if (typeof value === "string") {
      if (value.length > maxInputBytes) invalidArgument("Operation input is too large");
      append(JSON.stringify(value));
    } else if (Array.isArray(value)) {
      if (value.length > maxInputBytes) invalidArgument("Operation input is too large");
      append("[");
      for (let index = 0; index < value.length; index++) {
        if (index > 0) append(",");
        serialize(value[index], depth + 1);
      }
      append("]");
    } else if (typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      const fields = value as { readonly [key: string]: OperationInput | undefined };
      const keys = Object.keys(fields);
      if (keys.length > maxInputBytes) invalidArgument("Operation input is too large");
      append("{");
      let hasField = false;
      for (const key of keys.sort()) {
        // Convex treats undefined object fields as omitted.
        const field = fields[key];
        if (field === undefined) continue;
        if (hasField) append(",");
        serialize(key, depth + 1);
        append(":");
        serialize(field, depth + 1);
        hasField = true;
      }
      append("}");
    } else {
      invalidArgument("Operation input must contain JSON values");
    }
  }

  serialize(input, 0);
  const bytes = new TextEncoder().encode(segments.join(""));
  if (bytes.byteLength > maxInputBytes) invalidArgument("Operation input is too large");
  return bytes;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function requireExpectedRevision(expectedRevision: number, currentRevision: number): void {
  if (expectedRevision !== currentRevision) {
    throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision });
  }
}

// Reauthorize the workspace and actor before calling, including for retries. Run
// the callback in the same mutation and let failures propagate to roll it back.
export async function runOperation(
  db: Writer,
  request: OperationRequest,
  apply: (context: { db: Writer; expectedRevision: number | undefined; now: number }) => Promise<OperationChange>,
): Promise<OperationResult> {
  const { workspace, actor, origin, action, expectedRevision, targetPublicId, input } = request;
  if (request.operationId.length !== 36 || !uuidPattern.test(request.operationId)) {
    invalidArgument("Operation ID must be a UUID");
  }
  const operationId = request.operationId.toLowerCase();
  if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
    invalidArgument("Expected revision must be a positive safe integer");
  }

  const principal = actorKey(actor);
  const inputFingerprint = await sha256(canonicalBytes({ action, targetPublicId, expectedRevision, input }));
  // An indexed read in the same mutation as the insert makes simultaneous first
  // attempts contend on the receipt key even when the query matches no rows.
  const receipt = await db.query("operationReceipts").withIndex("by_workspace_actor_operation", q =>
    q.eq("workspaceId", workspace._id).eq("actorKey", principal).eq("operationId", operationId)
  ).unique();

  if (receipt) {
    if (receipt.fingerprintVersion !== fingerprintVersion || receipt.inputFingerprint !== inputFingerprint) {
      throw new ConvexError({ code: "OPERATION_ID_CONFLICT" });
    }
    const { targetPublicId, revision, activityEventId } = receipt.result;
    if (targetPublicId === undefined || revision === undefined || activityEventId === undefined) {
      throw new Error("Operation receipt is missing its result");
    }
    return { workspacePublicId: workspace.publicId, targetPublicId, revision, activityEventId };
  }

  const now = Date.now();
  const change = await apply({ db, expectedRevision, now });
  if (targetPublicId !== undefined && targetPublicId !== change.targetPublicId) {
    throw new Error("Operation result does not match its requested target");
  }

  // Both tables have their own public ID namespace. The scoped key produces a
  // stable ID without exposing the actor's identifier in either public ID.
  const publicId = await sha256(new TextEncoder().encode(JSON.stringify([workspace._id, principal, operationId])));
  const record = { workspaceId: workspace._id, publicId, createdAt: now, actor, operationId };
  const activityEventId = await db.insert("activityEvents", {
    ...record,
    origin,
    action,
    target: change.target,
    targetPublicId: change.targetPublicId,
    outcome: "applied",
    beforeRevision: change.beforeRevision,
    afterRevision: change.revision,
    undoEligible: Boolean(change.inverse),
    reason: change.reason,
  });
  if (change.inverse) {
    await db.insert("taskUndoChanges", {workspaceId:workspace._id,eventId:activityEventId,...change.inverse});
  }
  await db.insert("operationReceipts", {
    ...record,
    actorKey: principal,
    fingerprintVersion,
    inputFingerprint,
    result: { target: change.target, targetPublicId: change.targetPublicId, revision: change.revision, activityEventId },
  });
  return { workspacePublicId: workspace.publicId, targetPublicId: change.targetPublicId, revision: change.revision, activityEventId };
}
