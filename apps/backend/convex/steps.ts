import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";
import { authorize, requireSessionUser } from "./model/access";
import { boundedPage } from "./model/pagination";

export const list = query({
  args: { workspaceId: v.id("workspaces"), taskId: v.id("tasks"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { workspaceId, taskId, paginationOpts }) => {
    await authorize(ctx.db, workspaceId, requireSessionUser(await getAuthUserId(ctx)), "read");
    return ctx.db.query("taskSteps").withIndex("by_workspace_task_rank", q =>
      q.eq("workspaceId", workspaceId).eq("taskId", taskId)).paginate(boundedPage(paginationOpts));
  },
});
