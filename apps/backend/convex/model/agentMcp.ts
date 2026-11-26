import { createMcpHandler, fromJsonSchema, McpServer, type CallToolResult, type JsonSchemaType } from "@modelcontextprotocol/server";
import { makeFunctionReference } from "convex/server";
import type { GenericValidator, Infer } from "convex/values";
import { httpAction } from "../_generated/server";
import { hashAgentToken, type AgentScope } from "./agentCredentials";
import { bearerFrom, dispatchAgentTask, errorDetail, errorResponse, json, matches, type AgentAuthProof, type RequestFields, type TaskRoute } from "./agentHttp";
import { maxOAuthTokenLength, oauthChallenge, oauthConfig, verifyOAuthToken } from "./agentOAuth";
import { planningContextArgs } from "./agentPlanningContext";
import { dispatchPlanningContext } from "./agentPlanningContextHttp";
import { createAgentTaskArgs, getAgentTaskArgs, listAgentTaskArgs, updateAgentTaskArgs } from "./agentTasks";

const open = makeFunctionReference<"mutation", AgentAuthProof, {
  workspacePublicId: string;
  scopes: AgentScope[];
}>("agentCredentials:openMcpRequest");

const tools = [
  { name: "list_tasks", route: "list", schema: listAgentTaskArgs, scope: "tasks:read",
    description: "List tasks by status, project, planned date, or deadline. Use nextCursor for the next page." },
  { name: "get_task", route: "get", schema: getAgentTaskArgs, scope: "tasks:read",
    description: "Get a task's details and current revision by public ID." },
  { name: "create_task", route: "create", schema: createAgentTaskArgs, scope: "tasks:write",
    description: "Create one task with a public ID, a UUID operation ID, and a reason. Retry with the same operation ID and arguments." },
  { name: "update_task", route: "update", schema: updateAgentTaskArgs, scope: "tasks:write",
    description: "Update one task using its expected revision, a UUID operation ID, a reason, and a patch." },
  { name: "get_planning_context", route: "planningContext", schema: planningContextArgs, scope: "planning:read",
    description: "Read one local day's bounded planning context in an IANA time zone. Check partial flags before using it to plan." },
] as const satisfies ReadonlyArray<{
  name: string; route: TaskRoute | "planningContext"; schema: GenericValidator; scope: AgentScope; description: string;
}>;

function jsonSchema(validator: GenericValidator): JsonSchemaType {
  switch (validator.kind) {
    case "literal": return { const: validator.value };
    case "string": return { type: "string" };
    case "float64": return { type: "number" };
    case "null": return { type: "null" };
    case "array": return { type: "array", items: jsonSchema(validator.element) };
    case "union": return { anyOf: validator.members.map(jsonSchema) };
    case "object": {
      const fields = Object.entries(validator.fields);
      return { type: "object", additionalProperties: false,
        properties: Object.fromEntries(fields.map(([key, field]) => [key, jsonSchema(field)])),
        required: fields.filter(([, field]) => field.isOptional === "required").map(([key]) => key) };
    }
    default: throw new Error("Unsupported agent tool validator");
  }
}

function toolResult(output: Record<string, unknown>, isError = false): CallToolResult {
  return { isError, structuredContent: output, content: [{ type: "text", text: JSON.stringify(output) }] };
}

export const agentMcp = httpAction(async (ctx, request) => {
  const oauth = oauthConfig();
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return json({ error: { code: "FORBIDDEN" } }, 403);
    if (url.search) return json({ error: { code: "INVALID_ARGUMENT" } }, 400);

    // Charge each authenticated transport request once, including discovery.
    // Domain handlers check the current permission again before accessing data.
    const bearer = bearerFrom(request, oauth ? maxOAuthTokenLength : undefined);
    const proof: AgentAuthProof = oauth && !bearer.startsWith("klx_")
      ? { verifiedOAuth: await verifyOAuthToken(bearer, oauth) }
      : { tokenHash: await hashAgentToken(bearer) };
    const grant = await ctx.runMutation(open, proof);
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "klaxon", version: "1.0.0" });
      for (const tool of tools) {
        if (!grant.scopes.includes(tool.scope)) continue;
        const readOnly = tool.scope !== "tasks:write";
        server.registerTool(tool.name, {
          description: tool.description,
          annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          inputSchema: fromJsonSchema<RequestFields>(jsonSchema(tool.schema), {
            getValidator: <T>() => (data: unknown) => matches(data, tool.schema)
              ? { valid: true, data: data as T, errorMessage: undefined }
              : { valid: false, data: undefined, errorMessage: "INVALID_ARGUMENT" },
          }),
        }, async (args) => {
          try {
            const result = tool.route === "planningContext"
              ? await dispatchPlanningContext(ctx, args as Infer<typeof planningContextArgs>, proof, grant)
              : await dispatchAgentTask(ctx, tool.route, args, proof, grant);
            return toolResult(result);
          } catch (error) {
            return toolResult({ error: errorDetail(error) }, true);
          }
        });
      }
      return server;
    }, { legacy: "stateless", responseMode: "json", maxRequestBodySize: 32 * 1024 });
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return errorResponse(error, oauth ? oauthChallenge(oauth) : undefined);
  }
});
