import { v } from "convex/values";
import type { AgentEndpoint } from "./agentEndpoints";
import { pageArgs } from "./agentPagination";

const writeArgs = { publicId: v.string(), operationId: v.string(), reason: v.string() };
export const listLinkArgs = v.object({ taskPublicId: v.string(), ...pageArgs });
export const addLinkArgs = v.object({ ...writeArgs, taskPublicId: v.string(), expectedRevision: v.number(),
  url: v.string(), label: v.optional(v.string()) });
export const searchCaptureArgs = v.object({ text: v.string(), ...pageArgs });
export const createCaptureArgs = v.object({ ...writeArgs, body: v.string(), tags: v.optional(v.array(v.string())) });

export const agentReferenceEndpoints = [
  { name: "list_task_links", path: "links/list", handler: "agentReferences:listLinks", kind: "query",
    scope: "tasks:read", schema: listLinkArgs, description: "List manually attached HTTPS references for a task. Use nextCursor for another page." },
  { name: "link_external", path: "links/create", handler: "agentReferences:link", kind: "mutation",
    scope: "tasks:write", schema: addLinkArgs, description: "Add an HTTPS reference to a task using the task's current revision, a UUID operation ID, and a reason." },
  { name: "search_captures", path: "captures/search", handler: "agentReferences:searchCaptures", kind: "query",
    scope: "captures:read", schema: searchCaptureArgs, description: "Search capture text in the workspace. Large results return a truncated body." },
  { name: "create_capture", path: "captures/create", handler: "agentReferences:createCapture", kind: "mutation",
    scope: "captures:write", schema: createCaptureArgs, description: "Create one inbox capture with a public ID, a UUID operation ID, and a reason." },
] as const satisfies readonly AgentEndpoint[];
