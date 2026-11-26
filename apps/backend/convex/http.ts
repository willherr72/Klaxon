import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { agentMcp } from "./model/agentMcp";
import { hashAgentToken } from "./model/agentCredentials";
import { bearerFrom, dispatchAgentRequest, errorResponse, json, readAgentRequest } from "./model/agentHttp";
import { oauthMetadataPath, oauthMetadataResponse } from "./model/agentOAuth";
import { agentEndpoints } from "./model/agentEndpoints";

const http = httpRouter();

for (const endpoint of agentEndpoints) {
  http.route({
    path: `/api/v1/${endpoint.path}`,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      try {
        const tokenHash = await hashAgentToken(bearerFrom(request));
        const body = await readAgentRequest(request, endpoint.schema);
        return json(await dispatchAgentRequest(ctx, endpoint, body, { tokenHash }));
      } catch (error) {
        return errorResponse(error);
      }
    }),
  });
}

for (const method of ["POST", "GET", "DELETE"] as const) {
  http.route({ path: "/mcp", method, handler: agentMcp });
}

http.route({
  path: oauthMetadataPath,
  method: "GET",
  handler: httpAction(async () => oauthMetadataResponse()),
});

export default http;
