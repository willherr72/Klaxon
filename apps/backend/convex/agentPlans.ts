import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import {
  applyAgentPlanArgs, applyAgentPreview, createAgentPreview, decideAgentPlan,
  pendingAgentPlans, planDecisionFields, previewAgentPlanArgs,
} from "./model/agentPlans";

const agentArgs = { ...agentAuthArgs, workspacePublicId: v.string(), origin: v.optional(v.literal("mcp")) };
const workspaceArgs = { workspaceId: v.id("workspaces") };

export const preview = internalMutation({
  args: { ...agentArgs, ...previewAgentPlanArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "planning:preview");
    return createAgentPreview(db, grant, args, origin);
  },
});

export const apply = internalMutation({
  args: { ...agentArgs, ...applyAgentPlanArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "planning:apply");
    return applyAgentPreview(db, grant, args, origin);
  },
});

export const pending = query({
  args: workspaceArgs,
  handler: async (ctx, { workspaceId }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    return pendingAgentPlans(ctx.db, workspace);
  },
});

export const approve = mutation({
  args: { ...workspaceArgs, ...planDecisionFields },
  handler: async (ctx, { workspaceId, ...args }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    return decideAgentPlan(ctx.db, workspace, args, "approve");
  },
});

export const reject = mutation({
  args: { ...workspaceArgs, ...planDecisionFields },
  handler: async (ctx, { workspaceId, ...args }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const { workspace } = await authorize(ctx.db, workspaceId, userId, "manage");
    return decideAgentPlan(ctx.db, workspace, args, "reject");
  },
});
