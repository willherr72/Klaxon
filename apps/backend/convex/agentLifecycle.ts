import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { carryForwardAgentTask, carryForwardArgs, publishAgentBriefing, publishBriefingArgs } from "./model/agentLifecycle";

const credentialArgs = { ...agentAuthArgs, workspacePublicId: v.string(), origin: v.optional(v.literal("mcp")) };

export const publishBriefing = internalMutation({
  args: { ...credentialArgs, ...publishBriefingArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "planning:apply");
    return publishAgentBriefing(db, grant, args, origin ?? "api");
  },
});

export const carryForward = internalMutation({
  args: { ...credentialArgs, ...carryForwardArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "planning:apply");
    return carryForwardAgentTask(db, grant, args, origin ?? "api");
  },
});
