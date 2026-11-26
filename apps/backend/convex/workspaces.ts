import { getAuthUserId } from "@convex-dev/auth/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { ensurePersonalWorkspace, requireSessionUser } from "./model/access";
import { boundedPage } from "./model/pagination";

export const ensurePersonal = mutation({
  args: {},
  handler: async ctx => ensurePersonalWorkspace(ctx.db, requireSessionUser(await getAuthUserId(ctx))),
});

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = requireSessionUser(await getAuthUserId(ctx));
    const memberships = await ctx.db.query("memberships").withIndex("by_user_workspace",
      q => q.eq("userId", userId)).paginate(boundedPage(paginationOpts));
    const page = await Promise.all(memberships.page.map(async membership => {
      const workspace = await ctx.db.get("workspaces", membership.workspaceId);
      if (!workspace || (membership.role === "owner") !== (workspace.ownerId === userId)) {
        throw new ConvexError("WORKSPACE_UNAVAILABLE");
      }
      return { _id: workspace._id, publicId: workspace.publicId, name: workspace.name, role: membership.role };
    }));
    return { ...memberships, page };
  },
});
