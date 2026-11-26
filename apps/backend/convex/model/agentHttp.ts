import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type GenericValidator, type Value } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { createAgentTaskArgs, getAgentTaskArgs, listAgentTaskArgs, updateAgentTaskArgs } from "./agentTasks";
import type { VerifiedOAuth } from "./agentOAuth";

export type TaskRoute = "list" | "get" | "create" | "update";
export type AgentAuthProof = { tokenHash: string } | { verifiedOAuth: VerifiedOAuth };
export type RequestFields = Record<string, Value> & { workspacePublicId?: string };

const maxBodyBytes = 32 * 1024;
const jsonType = /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i;

const errorStatuses = {
  AGENT_UNAUTHORIZED: 401,
  AGENT_RATE_LIMITED: 429,
  FORBIDDEN: 403,
  WORKSPACE_UNAVAILABLE: 404,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ALREADY_EXISTS: 409,
  INVALID_STATE: 409,
  OPERATION_ID_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  INTERNAL_ERROR: 500,
} as const;
type ErrorCode = keyof typeof errorStatuses;

function fail(code: ErrorCode): never {
  throw new ConvexError(code);
}

export function json(body: unknown, status = 200, authenticate = "Bearer") {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (status === 401) headers.set("www-authenticate", authenticate);
  return new Response(JSON.stringify(body), { status, headers });
}

export function errorDetail(error: unknown) {
  const data = error instanceof ConvexError ? error.data : undefined;
  const fields = isRecord(data) ? data : undefined;
  const value = typeof data === "string" ? data : fields?.code;
  const code = typeof value === "string" && Object.hasOwn(errorStatuses, value)
    ? value as ErrorCode
    : "INTERNAL_ERROR";

  const revision = fields?.currentRevision;
  return code === "REVISION_CONFLICT" && typeof revision === "number"
    && Number.isSafeInteger(revision) && revision > 0
    ? { code, currentRevision: revision }
    : { code };
}

export function errorResponse(error: unknown, authenticate?: string) {
  const detail = errorDetail(error);
  return json({ error: detail }, errorStatuses[detail.code], authenticate);
}

export function bearerFrom(request: Request, maxLength = 68) {
  const authorization = request.headers.get("authorization") ?? "";
  // The token's case is preserved for validation and hashing.
  const match = /^Bearer +(\S+)$/i.exec(authorization);
  if (!match || match[1].length > maxLength) fail("AGENT_UNAUTHORIZED");
  return match[1];
}

export async function readJson(request: Request): Promise<unknown> {
  if (!jsonType.test(request.headers.get("content-type") ?? "")) fail("UNSUPPORTED_MEDIA_TYPE");
  return readBoundedJson(request, maxBodyBytes);
}

export async function readBoundedJson(input: Request | Response, limit: number): Promise<unknown> {
  if (Number(input.headers.get("content-length")) > limit) fail("PAYLOAD_TOO_LARGE");
  const reader = input.body?.getReader();
  if (!reader) fail("INVALID_ARGUMENT");

  const bytes = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > limit) fail("PAYLOAD_TOO_LARGE");
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (error instanceof ConvexError) throw error;
    fail("INVALID_ARGUMENT");
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const workspace = { workspacePublicId: v.string() };
const routeSchemas = {
  list: v.object({ ...workspace, ...listAgentTaskArgs.fields }),
  get: v.object({ ...workspace, ...getAgentTaskArgs.fields }),
  create: v.object({ ...workspace, ...createAgentTaskArgs.fields }),
  update: v.object({ ...workspace, ...updateAgentTaskArgs.fields }),
};

// Validate only the plain JSON types used by the task operations. This also
// rejects Convex-specific encodings and input keys outside the route schema.
export function matches(value: unknown, schema: GenericValidator): boolean {
  switch (schema.kind) {
    case "null": return value === null;
    case "literal": return value === schema.value;
    case "string": return typeof value === "string";
    case "float64": return typeof value === "number" && Number.isFinite(value);
    case "array": return Array.isArray(value) && value.every((item: unknown) => matches(item, schema.element));
    case "union": return schema.members.some((option) => matches(value, option));
    case "object":
      return isRecord(value)
        && Object.keys(value).every((key) => Object.hasOwn(schema.fields, key))
        && Object.entries(schema.fields).every(([key, field]) =>
          Object.hasOwn(value, key) ? matches(value[key], field) : field.isOptional === "optional");
    default: return false;
  }
}

export async function readTaskRequest(request: Request, route: TaskRoute): Promise<RequestFields> {
  if (new URL(request.url).search) fail("INVALID_ARGUMENT");
  const body = await readJson(request);
  if (!matches(body, routeSchemas[route])) fail("INVALID_ARGUMENT");
  return body as RequestFields;
}

const charge = makeFunctionReference<"mutation", AgentAuthProof & {
  workspacePublicId?: string;
  scope: "tasks:read" | "tasks:write";
}, { workspacePublicId: string }>("agentCredentials:chargeAgentRequest");

export async function dispatchAgentTask(
  ctx: ActionCtx,
  route: TaskRoute,
  body: RequestFields,
  proof: AgentAuthProof,
  mcpGrant?: { workspacePublicId: string },
) {
  const read = route === "list" || route === "get";
  // Charge in a separate transaction so conflicts and replays still use quota.
  const grant = mcpGrant ?? await ctx.runMutation(charge, {
    ...proof,
    ...(body.workspacePublicId === undefined ? {} : { workspacePublicId: body.workspacePublicId }),
    scope: read ? "tasks:read" : "tasks:write",
  });
  const args = { ...body, ...proof, workspacePublicId: grant.workspacePublicId };
  const name = "agentTasks:" + route;
  return read
    ? ctx.runQuery(makeFunctionReference<"query">(name), args)
    : ctx.runMutation(makeFunctionReference<"mutation">(name), mcpGrant ? { ...args, origin: "mcp" } : args);
}
