import { agentReferenceEndpoints } from "./agentReferences";
import { agentHistoryEndpoints } from "./agentHistory";
import { agentReminderEndpoints } from "./agentReminders";
import { agentLifecycleEndpoints } from "./agentLifecycle";
import { applyAgentPlanArgs, previewAgentPlanArgs } from "./agentPlans";
import { taskActionEndpoints } from "./agentTaskActions";
import type { GenericValidator } from "convex/values";
import type { AgentScope } from "./agentScopes";
import { planningContextArgs } from "./agentPlanningContext";
import { createAgentTaskArgs, getAgentTaskArgs, listAgentTaskArgs, updateAgentTaskArgs } from "./agentTasks";

export type AgentEndpoint = {
  name: string;
  path: string;
  handler: string;
  command?: string;
  kind: "query" | "mutation";
  scope: AgentScope;
  schema: GenericValidator;
  description: string;
};

export const agentEndpoints = [
  { name: "list_tasks", path: "tasks/list", handler: "agentTasks:list", kind: "query", schema: listAgentTaskArgs, scope: "tasks:read",
    description: "List tasks by status, project, planned date, or deadline. Use nextCursor for the next page." },
  { name: "get_task", path: "tasks/get", handler: "agentTasks:get", kind: "query", schema: getAgentTaskArgs, scope: "tasks:read",
    description: "Get a task's details and current revision by public ID." },
  { name: "create_task", path: "tasks/create", handler: "agentTasks:create", kind: "mutation", schema: createAgentTaskArgs, scope: "tasks:write",
    description: "Create one task with a public ID, a UUID operation ID, and a reason. Retry with the same operation ID and arguments." },
  { name: "update_task", path: "tasks/update", handler: "agentTasks:update", kind: "mutation", schema: updateAgentTaskArgs, scope: "tasks:write",
    description: "Update one task using its expected revision, a UUID operation ID, a reason, and a patch." },
  { name: "get_planning_context", path: "planning/context", handler: "agentPlanningContext:get", kind: "query", schema: planningContextArgs, scope: "planning:read",
    description: "Read one local day's bounded planning context in an IANA time zone. Check partial flags before using it to plan." },
  { name: "preview_plan", path: "planning/preview", handler: "agentPlans:preview", kind: "mutation", scope: "planning:preview",
    schema: previewAgentPlanArgs, description: "Propose a day plan for selected tasks and review its placements, focus and unscheduled work." },
  { name: "apply_plan", path: "planning/apply", handler: "agentPlans:apply", kind: "mutation", scope: "planning:apply",
    schema: applyAgentPlanArgs, description: "Apply your unexpired preview at its exact revision when the workspace policy allows automatic application." },
  ...taskActionEndpoints, ...agentHistoryEndpoints, ...agentReminderEndpoints, ...agentLifecycleEndpoints, ...agentReferenceEndpoints,
] as const satisfies readonly AgentEndpoint[];
