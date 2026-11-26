import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { backupError, byteLength, MAX_BACKUP_BYTES, MAX_BACKUP_RECORDS, type BackupPayload } from "./backupFormat";

type Table = Exclude<keyof BackupPayload, "workspaceName">;

function portableFields<Row extends { _id: string; _creationTime: number; workspaceId: string }>({
  _id, _creationTime, workspaceId, ...fields
}: Row) {
  return fields;
}

function publicIds<T extends Table>(rows: readonly { _id: Id<T>; publicId: string }[]) {
  return new Map(rows.map(row => [row._id, row.publicId]));
}

function resolve<K extends string, V>(ids: ReadonlyMap<K, V>, id: K): V {
  const value = ids.get(id);
  if (value === undefined) backupError("BACKUP_RELATIONSHIP");
  return value;
}

function optional<K extends string, V>(ids: ReadonlyMap<K, V>, id: K | undefined) {
  return id === undefined ? undefined : resolve(ids, id);
}

function mapSource<CaptureId extends string, MappedId>(source: {
  kind: "capture"; captureId: CaptureId;
} | { kind: "manual" } | { kind: "legacy"; source: string; externalId?: string } |
  { kind: "integration"; connectionId: Id<"integrationConnections"> } |
  { kind: "agent"; credentialId: Id<"agentCredentials"> } | undefined,
ids: ReadonlyMap<CaptureId, MappedId>) {
  switch (source?.kind) {
    case "capture": return { kind: source.kind, captureId: resolve(ids, source.captureId) };
    case "manual":
    case "legacy": return source;
    default: return undefined;
  }
}

export async function readBackup(db: DatabaseReader, workspace: Doc<"workspaces">): Promise<BackupPayload> {
  const workspaceId = workspace._id;
  let recordsRead = 0;
  let bytesRead = 0;
  async function read<Row extends { publicId: string }>(query: AsyncIterable<Row>, limit = MAX_BACKUP_RECORDS) {
    const rows: Row[] = [];
    for await (const row of query) {
      if (++recordsRead > MAX_BACKUP_RECORDS) backupError("BACKUP_LIMIT");
      if (rows.length === limit) backupError("BACKUP_INVALID");
      // Bound raw reads as well as the final archive. A large excluded subtree
      // (such as a connected import filter) can otherwise exhaust a query.
      bytesRead += byteLength(JSON.stringify(row));
      if (bytesRead > 2 * MAX_BACKUP_BYTES) backupError("BACKUP_LIMIT");
      rows.push(row);
    }
    return rows.sort((a, b) => a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0);
  }

  const projects = await read(db.query("projects").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const lanes = await read(db.query("lanes").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const tasks = await read(db.query("tasks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const captures = await read(db.query("captures").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const dayPlans = await read(db.query("dayPlans").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const taskSteps = await read(db.query("taskSteps").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const dayNotes = await read(db.query("dayNotes").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const reminders = await read(db.query("reminders").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const timeBlocks = await read(db.query("timeBlocks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const externalLinks = await read(db.query("externalLinks").withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)));
  const preferences = await read(db.query("preferences").withIndex("by_workspace_user", q =>
    q.eq("workspaceId", workspaceId).eq("userId", workspace.ownerId)), 1);

  const projectIds = publicIds(projects);
  const laneIds = publicIds(lanes);
  const taskIds = publicIds(tasks);
  const captureIds = publicIds(captures);
  const planIds = publicIds(dayPlans);

  return {
    workspaceName: workspace.name,
    projects: projects.map(row => {
      const { board, ...fields } = portableFields(row);
      return { ...fields, board: board && { laneIds: board.laneIds.map(id => resolve(laneIds, id)) } };
    }),
    lanes: lanes.map(row => {
      const { projectId, ...fields } = portableFields(row);
      return { ...fields, projectId: optional(projectIds, projectId) };
    }),
    tasks: tasks.map(row => {
      const { projectId, laneId, source, ...fields } = portableFields(row);
      return { ...fields, projectId: optional(projectIds, projectId), laneId: optional(laneIds, laneId),
        source: mapSource(source, captureIds) };
    }),
    taskSteps: taskSteps.map(row => {
      const { taskId, ...fields } = portableFields(row);
      return { ...fields, taskId: resolve(taskIds, taskId) };
    }),
    captures: captures.map(row => {
      const { promotedTaskId, source, ...fields } = portableFields(row);
      return { ...fields, promotedTaskId: optional(taskIds, promotedTaskId), source: mapSource(source, captureIds) };
    }),
    dayNotes: dayNotes.map(row => {
      const { source, ...fields } = portableFields(row);
      return { ...fields, source: mapSource(source, captureIds) };
    }),
    reminders: reminders.map(row => {
      const { taskId, source, ...fields } = portableFields(row);
      return { ...fields, taskId: optional(taskIds, taskId), source: mapSource(source, captureIds) };
    }),
    dayPlans: dayPlans.map(row => {
      const { focusTaskIds, ...fields } = portableFields(row);
      return { ...fields, focusTaskIds: focusTaskIds.map(id => resolve(taskIds, id)) };
    }),
    timeBlocks: timeBlocks.map(row => {
      const { planId, title, ...fields } = portableFields(row);
      if ("taskId" in row) return { ...fields, taskId: resolve(taskIds, row.taskId), title,
        planId: optional(planIds, planId) };
      return { ...fields, title: row.title, planId: optional(planIds, planId) };
    }),
    externalLinks: externalLinks.map(({ taskId, provider, externalObjectId, canonicalUrl, label, publicId, createdAt, updatedAt, revision }) =>
      ({ taskId: resolve(taskIds, taskId), provider, externalObjectId, canonicalUrl, label,
        publicId, createdAt, updatedAt, revision, relationship: "reference" })),
    preferences: preferences.map(row => {
      const { userId, importFilters, ...fields } = portableFields(row);
      return { ...fields, importFilters: importFilters.flatMap(({ connectionId, ...filter }) =>
        connectionId === undefined ? [filter] : []) };
    }),
  };
}

export async function writeBackup(db: DatabaseWriter, userId: Id<"users">, payload: BackupPayload) {
  const now = Date.now();
  const workspacePublicId = crypto.randomUUID();
  const version = { revision: 1, createdAt: now, updatedAt: now };
  const workspaceId = await db.insert("workspaces", {
    ownerId: userId, name: payload.workspaceName, publicId: workspacePublicId, ...version,
  });
  await db.insert("memberships", { workspaceId, userId, role: "owner", publicId: crypto.randomUUID(), ...version });

  const projects = new Map<string, Id<"projects">>();
  for (const { board, ...fields } of payload.projects) {
    projects.set(fields.publicId, await db.insert("projects", { workspaceId, ...fields }));
  }
  const lanes = new Map<string, Id<"lanes">>();
  for (const { projectId, ...fields } of payload.lanes) {
    lanes.set(fields.publicId, await db.insert("lanes", { workspaceId, ...fields, projectId: optional(projects, projectId) }));
  }
  for (const { publicId, board } of payload.projects) {
    if (board) await db.patch("projects", resolve(projects, publicId), { board: { laneIds: board.laneIds.map(id => resolve(lanes, id)) } });
  }

  const captures = new Map<string, Id<"captures">>();
  for (const { promotedTaskId, source, ...fields } of payload.captures) {
    captures.set(fields.publicId, await db.insert("captures", { workspaceId, ...fields }));
  }
  const tasks = new Map<string, Id<"tasks">>();
  for (const { projectId, laneId, source, ...fields } of payload.tasks) {
    tasks.set(fields.publicId, await db.insert("tasks", { workspaceId, ...fields,
      projectId: optional(projects, projectId), laneId: optional(lanes, laneId), source: mapSource(source, captures) }));
  }
  for (const { publicId, promotedTaskId, source } of payload.captures) {
    if (promotedTaskId !== undefined || source !== undefined) {
      await db.patch("captures", resolve(captures, publicId), { promotedTaskId: optional(tasks, promotedTaskId), source: mapSource(source, captures) });
    }
  }

  for (const { taskId, ...fields } of payload.taskSteps) {
    await db.insert("taskSteps", { workspaceId, ...fields, taskId: resolve(tasks, taskId) });
  }
  for (const { source, ...fields } of payload.dayNotes) {
    await db.insert("dayNotes", { workspaceId, ...fields, source: mapSource(source, captures) });
  }
  for (const { taskId, source, ...fields } of payload.reminders) {
    await db.insert("reminders", { workspaceId, ...fields, taskId: optional(tasks, taskId), source: mapSource(source, captures) });
  }

  const plans = new Map<string, Id<"dayPlans">>();
  for (const { focusTaskIds, ...fields } of payload.dayPlans) {
    plans.set(fields.publicId, await db.insert("dayPlans", { workspaceId, ...fields,
      focusTaskIds: focusTaskIds.map(id => resolve(tasks, id)) }));
  }
  for (const { planId, ...fields } of payload.timeBlocks) {
    const block = { ...fields, workspaceId, planId: optional(plans, planId) };
    if ("taskId" in fields) await db.insert("timeBlocks", { ...block, taskId: resolve(tasks, fields.taskId) });
    else await db.insert("timeBlocks", { ...block, title: fields.title });
  }
  for (const { taskId, ...fields } of payload.externalLinks) {
    await db.insert("externalLinks", { workspaceId, ...fields, taskId: resolve(tasks, taskId) });
  }
  for (const fields of payload.preferences) await db.insert("preferences", { workspaceId, userId, ...fields });
  return { workspaceId, workspacePublicId };
}
