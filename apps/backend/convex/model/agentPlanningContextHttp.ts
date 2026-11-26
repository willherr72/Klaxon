import { makeFunctionReference } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { httpAction, type ActionCtx } from "../_generated/server";
import { hashAgentToken } from "./agentCredentials";
import { bearerFrom, errorResponse, json, matches, readJson, type AgentAuthProof } from "./agentHttp";
import { planningContextArgs, type getAgentPlanningContext } from "./agentPlanningContext";

type Result = Awaited<ReturnType<typeof getAgentPlanningContext>>;
type Input = Infer<typeof planningContextArgs> & { workspacePublicId?: string };

const webInput = v.object({ workspacePublicId: v.string(), ...planningContextArgs.fields });
const charge = makeFunctionReference<"mutation", AgentAuthProof & { workspacePublicId?: string; scope: "planning:read" },
  { workspacePublicId: string }>("agentCredentials:chargeAgentRequest");
const get = makeFunctionReference<"query", AgentAuthProof & Infer<typeof webInput>, Result>("agentPlanningContext:get");

export async function dispatchPlanningContext(ctx: ActionCtx, { date, timezone, workspacePublicId }: Input, auth: AgentAuthProof,
  mcpGrant?: { workspacePublicId: string }) {
  const grant = mcpGrant ?? await ctx.runMutation(charge, { ...auth, workspacePublicId, scope: "planning:read" });
  return ctx.runQuery(get, { ...auth, workspacePublicId: grant.workspacePublicId, date, timezone });
}

export const planningContextHttp = httpAction(async (ctx, request) => {
  try {
    if (new URL(request.url).search) throw new ConvexError("INVALID_ARGUMENT");
    const tokenHash = await hashAgentToken(bearerFrom(request));
    const body = await readJson(request);
    if (!matches(body, webInput)) throw new ConvexError("INVALID_ARGUMENT");
    return json(await dispatchPlanningContext(ctx, body as Infer<typeof webInput>, { tokenHash }));
  } catch (error) {
    return errorResponse(error);
  }
});
