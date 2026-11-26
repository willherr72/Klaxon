import { v, type Infer } from "convex/values";

export const agentScope = v.union(v.literal("tasks:read"), v.literal("tasks:write"), v.literal("planning:read"),
  v.literal("planning:preview"), v.literal("planning:apply"), v.literal("reminders:write"),
  v.literal("captures:read"), v.literal("captures:write"), v.literal("activity:read"), v.literal("activity:undo"));
export type AgentScope = Infer<typeof agentScope>;
export const agentScopeNames = agentScope.members.map(scope => scope.value);

export function isWriteScope(scope: AgentScope) {
  return !scope.endsWith(":read");
}
