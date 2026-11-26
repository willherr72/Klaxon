import type { Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { autonomyPolicy } from "./autonomyValues";
import { normalizedWindows, preferenceRow, visiblePreferences } from "./calendarStore";
import { calendarError, localWeekday, zonedClock } from "./calendarTime";
import { taskByPublicId } from "./reads";

export type AutonomyPolicy = Infer<typeof autonomyPolicy>;

export function visibleAutonomy(row: Doc<"preferences"> | null): AutonomyPolicy {
  return {
    planApplication: row?.autonomyPolicy.planApplication ?? "automatic",
    schedule: row?.autonomyPolicy.schedule ?? [],
    scope: row?.autonomyPolicy.scope ?? { kind: "all" },
    excludedTaskPublicIds: row?.autonomyPolicy.excludedTaskPublicIds ?? [],
    excludedProjectPublicIds: row?.autonomyPolicy.excludedProjectPublicIds ?? [],
  };
}

export async function ownerAutonomy(db: DatabaseReader, workspaceId: Id<"workspaces">) {
  const workspace = await db.get("workspaces", workspaceId);
  if (!workspace) calendarError("WORKSPACE_UNAVAILABLE");
  const row = await preferenceRow(db, workspaceId, workspace.ownerId);
  const { revision, timezone } = visiblePreferences(row);
  return { revision, timezone, policy: visibleAutonomy(row) };
}

function checkedIds(ids: string[]) {
  if (ids.length > 100 || ids.some(id => !id.trim() || id.length > 200) || new Set(ids).size !== ids.length) {
    calendarError("INVALID_ARGUMENT", "Each autonomy list allows up to 100 distinct public IDs");
  }
  return [...ids].sort();
}

export async function normalizeAutonomy(db: DatabaseReader, workspaceId: Id<"workspaces">,
  policy: AutonomyPolicy, previous: AutonomyPolicy): Promise<AutonomyPolicy> {
  const schedule = normalizedWindows(policy.schedule);
  const excludedTaskPublicIds = checkedIds(policy.excludedTaskPublicIds);
  const excludedProjectPublicIds = checkedIds(policy.excludedProjectPublicIds);
  const scope = policy.scope.kind === "projects"
    ? { ...policy.scope, projectPublicIds: checkedIds(policy.scope.projectPublicIds) }
    : policy.scope;
  if (scope.kind === "projects" && scope.projectPublicIds.length === 0) {
    calendarError("INVALID_ARGUMENT", "Select at least one project for this scope");
  }
  const projectIds = new Set([
    ...excludedProjectPublicIds.filter(id => !previous.excludedProjectPublicIds.includes(id)),
    ...(scope.kind === "projects" ? scope.projectPublicIds.filter(id =>
      previous.scope.kind !== "projects" || !previous.scope.projectPublicIds.includes(id)) : []),
  ]);
  const tasks = excludedTaskPublicIds.filter(id => !previous.excludedTaskPublicIds.includes(id));
  const references = await Promise.all([
    ...[...projectIds].map(publicId => db.query("projects").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique()),
    ...tasks.map(id => taskByPublicId(db, workspaceId, id)),
  ]);
  if (references.some(row => !row)) calendarError("INVALID_ARGUMENT", "Select tasks and projects in this workspace");
  return { ...policy, schedule, scope, excludedTaskPublicIds, excludedProjectPublicIds };
}

export async function enforceAutonomy(db: DatabaseReader, workspaceId: Id<"workspaces">,
  tasks: readonly Pick<Doc<"tasks">, "workspaceId" | "publicId" | "projectId">[],
  now: number, phase: "preview" | "apply" | "review") {
  const { policy, timezone } = await ownerAutonomy(db, workspaceId);
  if (phase === "apply" && policy.planApplication === "review") calendarError("AUTONOMY_APPROVAL_REQUIRED");
  if (phase === "review" && policy.planApplication !== "review") calendarError("AUTONOMY_REVIEW_DISABLED");
  if (phase === "apply" && policy.schedule.length) {
    const clock = zonedClock(timezone);
    const localDate = clock.date(now);
    const weekday = localWeekday(localDate);
    if (!policy.schedule.some(window => window.weekday === weekday &&
      clock.at(localDate, window.startMinute) <= now && now < clock.at(localDate, window.endMinute))) {
      calendarError("AUTONOMY_OUTSIDE_SCHEDULE");
    }
  }

  const { scope } = policy;
  const projectIds = new Set(tasks.flatMap(task => task.projectId ? [task.projectId] : []));
  const projects = new Map(await Promise.all([...projectIds].map(async id => [id, await db.get("projects", id)] as const)));
  for (const task of tasks) {
    const project = task.projectId ? projects.get(task.projectId) : null;
    if (task.workspaceId !== workspaceId || (task.projectId && project?.workspaceId !== workspaceId) ||
        policy.excludedTaskPublicIds.includes(task.publicId) ||
        (project && policy.excludedProjectPublicIds.includes(project.publicId))) {
      calendarError("AUTONOMY_OUT_OF_SCOPE");
    }
    if ((scope.kind === "projects" && (!project || !scope.projectPublicIds.includes(project.publicId))) ||
        ((scope.kind === "work" || scope.kind === "personal") && project?.area?.trim().toLowerCase() !== scope.kind)) {
      calendarError("AUTONOMY_OUT_OF_SCOPE");
    }
  }
}
