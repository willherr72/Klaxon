import { v } from "convex/values";
import type { AgentEndpoint } from "./agentEndpoints";
import { planningContextArgs } from "./agentPlanningContext";
import { pageArgs } from "./agentPagination";

export const listActivityArgs = v.object(pageArgs);
export const undoArgs = v.object({ eventPublicId: v.string(), expectedRevision: v.number(), reason: v.string(), operationId: v.string() });
export const calendarArgs = v.object({ ...planningContextArgs.fields, view: v.union(v.literal("day"), v.literal("week")) });
export const agentHistoryEndpoints = [
  { name:"list_activity", path:"activity/list", handler:"agentHistory:list", kind:"query", scope:"activity:read",
    schema:listActivityArgs, description:"Page through workspace activity with public IDs, actor attribution and revision." },
  { name:"undo_change", path:"activity/undo", handler:"agentHistory:undo", kind:"mutation", scope:"activity:undo",
    schema:undoArgs, description:"Undo this credential's eligible task change at its current revision. Requires task write access." },
  { name:"get_day_plan", path:"planning/day", handler:"agentHistory:day", kind:"query", scope:"planning:read",
    schema:planningContextArgs, description:"Read one saved day plan and its current revision and replan status." },
  { name:"list_calendar", path:"calendar/list", handler:"agentHistory:calendar", kind:"query", scope:"planning:read",
    schema:calendarArgs, description:"Read a day or week of workspace blocks and accessible meetings with lock and freshness information." },
] as const satisfies readonly AgentEndpoint[];
