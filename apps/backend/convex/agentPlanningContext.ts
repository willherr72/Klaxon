import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { getAgentPlanningContext, planningContextArgs } from "./model/agentPlanningContext";

export const get = internalQuery({
  args: { ...agentAuthArgs, workspacePublicId: v.string(), ...planningContextArgs.fields },
  handler: async ({ db }, { date, timezone, ...auth }) => {
    const grant = await authorizeAgent(db, auth, "planning:read");
    return getAgentPlanningContext(db, grant, { date, timezone });
  },
});
