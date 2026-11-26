import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { agentMcp } from "./model/agentMcp";
import { hashAgentToken } from "./model/agentCredentials";
import { bearerFrom, dispatchAgentTask, errorResponse, json, readTaskRequest } from "./model/agentHttp";
import { oauthMetadataPath, oauthMetadataResponse } from "./model/agentOAuth";
import { planningContextHttp } from "./model/agentPlanningContextHttp";

const http = httpRouter();

for (const route of ["list", "get", "create", "update"] as const) {
  http.route({
    path: "/api/v1/tasks/" + route,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const tokenHash = await hashAgentToken(bearerFrom(request));
        const body = await readTaskRequest(request, route);
        return json(await dispatchAgentTask(ctx, route, body, { tokenHash }));
      } catch (error) {
        return errorResponse(error);
      }
    }),
  });
}

http.route({ path: "/api/v1/planning/context", method: "POST", handler: planningContextHttp });

for (const method of ["POST", "GET", "DELETE"] as const) {
  http.route({ path: "/mcp", method, handler: agentMcp });
}

http.route({
  path: oauthMetadataPath,
  method: "GET",
  handler: httpAction(async () => oauthMetadataResponse()),
});

export default http;
