import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import {
  createAgentTask, createAgentTaskArgs, getAgentTask, getAgentTaskArgs,
  listAgentTasks, listAgentTaskArgs, updateAgentTask, updateAgentTaskArgs,
} from "./model/agentTasks";

const credentialArgs = { ...agentAuthArgs, workspacePublicId: v.string() };
const originArg = { origin: v.optional(v.literal("mcp")) };

export const list = internalQuery({
  args: { ...credentialArgs, ...listAgentTaskArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, ...args }) => {
    const { workspaceId } = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "tasks:read");
    return listAgentTasks(db, workspaceId, args);
  },
});

export const get = internalQuery({
  args: { ...credentialArgs, ...getAgentTaskArgs.fields },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, ...args }) => {
    const { workspaceId } = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "tasks:read");
    return getAgentTask(db, workspaceId, args);
  },
});

export const create = internalMutation({
  args: { ...credentialArgs, ...createAgentTaskArgs.fields, ...originArg },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "tasks:write");
    return createAgentTask(db, grant, args, origin);
  },
});

export const update = internalMutation({
  args: { ...credentialArgs, ...updateAgentTaskArgs.fields, ...originArg },
  handler: async ({ db }, { tokenHash, verifiedOAuth, workspacePublicId, origin, ...args }) => {
    const grant = await authorizeAgent(db, { tokenHash, verifiedOAuth, workspacePublicId }, "tasks:write");
    return updateAgentTask(db, grant, args, origin);
  },
});
