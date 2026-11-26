import type { DataModelFromSchemaDefinition, GenericDatabaseReader, PaginationOptions } from "convex/server";
import type { GenericId } from "convex/values";
import type schema from "../schema";

type Model = DataModelFromSchemaDefinition<typeof schema>;
type Reader = GenericDatabaseReader<Model>;
type WorkspaceId = GenericId<"workspaces">;
type Task = Model["tasks"]["document"];
const maxPageSize = 50;

export type TaskFilter =
  | { kind: "status"; status: Task["status"] }
  | { kind: "planned" | "deadlineDate"; from: string; until: string }
  | { kind: "deadlineInstant"; from: number; until: number }
  | { kind: "project"; projectId: GenericId<"projects"> };

// Callers supply the workspace after authorization. These helpers register no public functions.
export function taskByPublicId(db: Reader, workspaceId: WorkspaceId, publicId: string) {
  return db.query("tasks").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)
  ).unique();
}

function isCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// [from, until) lets adjacent days or windows share a boundary without repeating rows.
export function listTasks(db: Reader, workspaceId: WorkspaceId, filter: TaskFilter,
  page: Pick<PaginationOptions, "cursor" | "numItems" | "endCursor">) {
  if (!Number.isInteger(page.numItems) || page.numItems < 1 || page.numItems > maxPageSize) {
    throw new RangeError("Request between 1 and 50 tasks per page");
  }
  if (filter.kind === "planned" || filter.kind === "deadlineDate") {
    if (!isCalendarDate(filter.from) || !isCalendarDate(filter.until) || filter.from >= filter.until) {
      throw new RangeError("Expected an increasing pair of YYYY-MM-DD calendar dates");
    }
  }
  const tasks = db.query("tasks");
  // Leave room for a full indexed page before the database requests a split.
  const options = { cursor: page.cursor, endCursor: page.endCursor, numItems: page.numItems, maximumRowsRead: maxPageSize + 1 };
  switch (filter.kind) {
    case "status":
      return tasks.withIndex("by_workspace_status", q =>
        q.eq("workspaceId", workspaceId).eq("status", filter.status)
      ).paginate(options);
    case "planned":
      return tasks.withIndex("by_workspace_planned_date", q =>
        q.eq("workspaceId", workspaceId).gte("plannedDate", filter.from).lt("plannedDate", filter.until)
      ).paginate(options);
    case "deadlineDate":
      return tasks.withIndex("by_workspace_deadline_date", q =>
        q.eq("workspaceId", workspaceId).gte("deadline.date", filter.from).lt("deadline.date", filter.until)
      ).paginate(options);
    case "deadlineInstant":
      if (!Number.isSafeInteger(filter.from) || !Number.isSafeInteger(filter.until) || filter.from >= filter.until) {
        throw new RangeError("Expected an increasing pair of UTC millisecond timestamps");
      }
      return tasks.withIndex("by_workspace_deadline_at", q =>
        q.eq("workspaceId", workspaceId).gte("deadline.at", filter.from).lt("deadline.at", filter.until)
      ).paginate(options);
    case "project":
      return tasks.withIndex("by_workspace_project_rank", q =>
        q.eq("workspaceId", workspaceId).eq("projectId", filter.projectId)
      ).paginate(options);
    default:
      throw new RangeError("Unknown task filter");
  }
}
