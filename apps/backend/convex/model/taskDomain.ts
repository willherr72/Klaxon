import type { DataModelFromSchemaDefinition, GenericDatabaseWriter } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import type schema from "../schema";
import { taskByPublicId } from "./reads";
import type { TaskDomainCommand } from "./taskDomainCommands";

export { taskDomainCommand, type TaskDomainCommand } from "./taskDomainCommands";

type Model = DataModelFromSchemaDefinition<typeof schema>;
type Writer = GenericDatabaseWriter<Model>;
type WorkspaceId = GenericId<"workspaces">;
type EntityTable = "tasks" | "projects" | "taskSteps";
type Task = Model["tasks"]["document"];
type Project = Model["projects"]["document"];
type Step = Model["taskSteps"]["document"];
type TaskPatch = Extract<TaskDomainCommand, { kind: "task.update" }>["patch"];
type ProjectPatch = Extract<TaskDomainCommand, { kind: "project.update" }>["patch"];
type StepPatch = Extract<TaskDomainCommand, { kind: "step.update" }>["patch"];

export type TaskDomainResult = {
  target:
    | { kind: "task"; id: GenericId<"tasks"> }
    | { kind: "project"; id: GenericId<"projects"> }
    | { kind: "task_step"; id: GenericId<"taskSteps"> };
  targetPublicId: string;
  revision: number;
};

function invalid(field: string) {
  throw new ConvexError({ code: "INVALID_ARGUMENT", field });
}

function unavailable(): never {
  throw new ConvexError({ code: "NOT_FOUND" });
}

function invalidState(): never {
  throw new ConvexError({ code: "INVALID_STATE" });
}

function checkPublicId(publicId: string) {
  if (!publicId || publicId.length > 128 || /[\s\x00-\x1f\x7f]/u.test(publicId)) invalid("publicId");
}

function requiredText(value: string, field: string, max: number) {
  const trimmed = value.trim();
  if (!trimmed || value.length > max) invalid(field);
  return trimmed;
}

function boundedText(value: string, field: string, max: number) {
  if (value.length > max) invalid(field);
  return value;
}

function checkedRank(rank: number) {
  if (!Number.isFinite(rank) || Math.abs(rank) > Number.MAX_SAFE_INTEGER) invalid("rank");
  return rank;
}

function checkedDate(value: string, field: string) {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) invalid(field);
  return value;
}

function checkedDeadline(value: NonNullable<Task["deadline"]>) {
  if (value.kind === "date") {
    checkedDate(value.date, "deadline.date");
  } else {
    if (!Number.isSafeInteger(value.at) || Math.abs(value.at) > 8.64e15) invalid("deadline.at");
    if (value.timezone !== undefined) {
      if (!value.timezone || value.timezone.length > 128 || /^[+-]/.test(value.timezone)) {
        invalid("deadline.timezone");
      }
      try {
        new Intl.DateTimeFormat("en", { timeZone: value.timezone });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        invalid("deadline.timezone");
      }
    }
  }
  return value;
}

function checkedEstimate(minutes: number) {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 525_600) invalid("estimateMinutes");
  return minutes;
}

function checkedTags(tags: string[]) {
  if (tags.length > 32) invalid("tags");
  return tags.map(tag => requiredText(tag, "tags", 128));
}

function clearable<T>(value: T | null, check: (value: T) => T) {
  return value === null ? undefined : check(value);
}

function checkRevision(currentRevision: number, expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) invalid("expectedRevision");
  if (currentRevision !== expectedRevision) throw new ConvexError({ code: "REVISION_CONFLICT", currentRevision });
  if (currentRevision === Number.MAX_SAFE_INTEGER) invalidState();
}

const find = {
  tasks: taskByPublicId,
  projects: (db: Writer, workspaceId: WorkspaceId, publicId: string) =>
    db.query("projects").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique(),
  taskSteps: (db: Writer, workspaceId: WorkspaceId, publicId: string) =>
    db.query("taskSteps").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique(),
};

async function newFields(db: Writer, table: EntityTable, workspaceId: WorkspaceId, publicId: string, now: number) {
  if (await find[table](db, workspaceId, publicId)) throw new ConvexError({ code: "ALREADY_EXISTS" });
  return { workspaceId, publicId, createdAt: now, updatedAt: now, revision: 1 };
}

async function existing<T extends { revision: number }>(lookup: Promise<T | null>, expectedRevision: number) {
  const row = await lookup;
  if (!row) unavailable();
  checkRevision(row.revision, expectedRevision);
  return row;
}

async function requireWorkspaceRef(row: Promise<{ workspaceId: WorkspaceId } | null>, workspaceId: WorkspaceId) {
  if ((await row)?.workspaceId !== workspaceId) unavailable();
}

async function taskFields(db: Writer, workspaceId: WorkspaceId, fields: TaskPatch, current?: Task) {
  const patch: Partial<Pick<Task, keyof TaskPatch>> = {};
  if (fields.title !== undefined) patch.title = requiredText(fields.title, "title", 512);
  if (fields.status !== undefined) {
    if (fields.status === "archived") invalid("status");
    patch.status = fields.status;
  }
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.rank !== undefined) patch.rank = checkedRank(fields.rank);
  if (fields.description !== undefined) {
    patch.description = clearable(fields.description, value => boundedText(value, "description", 32_768));
  }
  if (fields.plannedDate !== undefined) {
    patch.plannedDate = clearable(fields.plannedDate, value => checkedDate(value, "plannedDate"));
  }
  if (fields.deadline !== undefined) patch.deadline = clearable(fields.deadline, checkedDeadline);
  if (fields.estimateMinutes !== undefined) patch.estimateMinutes = clearable(fields.estimateMinutes, checkedEstimate);
  if (fields.tags !== undefined) patch.tags = clearable(fields.tags, checkedTags);
  if (fields.waitingReason !== undefined) {
    patch.waitingReason = clearable(fields.waitingReason, value => boundedText(value, "waitingReason", 2_048));
  }
  if (fields.waitingPerson !== undefined) {
    patch.waitingPerson = clearable(fields.waitingPerson, value => boundedText(value, "waitingPerson", 512));
  }
  if (fields.followUpDate !== undefined) {
    patch.followUpDate = clearable(fields.followUpDate, value => checkedDate(value, "followUpDate"));
  }
  if (fields.projectId !== undefined) {
    if (fields.projectId !== null) await requireWorkspaceRef(db.get("projects", fields.projectId), workspaceId);
    patch.projectId = fields.projectId ?? undefined;
  }
  if (fields.laneId !== undefined) {
    patch.laneId = fields.laneId ?? undefined;
  }
  if (fields.projectId !== undefined || fields.laneId !== undefined) {
    const laneId = fields.laneId === undefined ? current?.laneId : fields.laneId;
    const projectId = fields.projectId === undefined ? current?.projectId : fields.projectId;
    if (laneId) await requireLane(db, workspaceId, laneId, projectId ?? undefined);
  }
  return patch;
}

async function requireLane(db: Writer, workspaceId: WorkspaceId, laneId: GenericId<"lanes">,
  projectId?: GenericId<"projects">) {
  const lane = await db.get("lanes", laneId);
  if (!lane || lane.workspaceId !== workspaceId) unavailable();
  if (lane.projectId !== undefined && lane.projectId !== projectId) invalid("laneId");
}

async function projectFields(db: Writer, workspaceId: WorkspaceId, fields: ProjectPatch, projectId?: GenericId<"projects">) {
  const patch: Partial<Pick<Project, keyof ProjectPatch>> = {};
  if (fields.name !== undefined) patch.name = requiredText(fields.name, "name", 512);
  if (fields.rank !== undefined) patch.rank = checkedRank(fields.rank);
  if (fields.area !== undefined) patch.area = clearable(fields.area, value => boundedText(value, "area", 512));
  if (fields.board !== undefined) {
    if (fields.board !== null) {
      const { laneIds } = fields.board;
      if (laneIds.length > 64 || new Set(laneIds).size !== laneIds.length) invalid("board.laneIds");
      await Promise.all(laneIds.map(id => requireLane(db, workspaceId, id, projectId)));
    }
    patch.board = fields.board ?? undefined;
  }
  return patch;
}

function stepFields(fields: StepPatch) {
  const patch: Partial<Pick<Step, keyof StepPatch>> = {};
  if (fields.title !== undefined) patch.title = requiredText(fields.title, "title", 512);
  if (fields.rank !== undefined) patch.rank = checkedRank(fields.rank);
  if (fields.completed !== undefined) patch.completed = fields.completed;
  return patch;
}

async function nextStepRank(db: Writer, workspaceId: WorkspaceId, taskId: GenericId<"tasks">) {
  const last = await db.query("taskSteps").withIndex("by_workspace_task_rank", q =>
    q.eq("workspaceId", workspaceId).eq("taskId", taskId)).order("desc").first();
  return last ? checkedRank(last.rank + 1) : 0;
}

function checkPatch(patch: object) {
  if (Object.keys(patch).length === 0) invalid("patch");
}

// Run inside the caller's authorized mutation so checks and ledger writes share its transaction.
export async function applyTaskDomainCommand(
  db: Writer, workspaceId: WorkspaceId, command: TaskDomainCommand,
): Promise<TaskDomainResult> {
  const { publicId } = command;
  checkPublicId(publicId);
  const now = Date.now();

  switch (command.kind) {
    case "task.create": {
      const { title, ...details } = command;
      const core = await newFields(db, "tasks", workspaceId, publicId, now);
      const fields = await taskFields(db, workspaceId, details);
      const status = fields.status ?? "inbox";
      const id = await db.insert("tasks", {
        ...core, ...fields, status, title: requiredText(title, "title", 512),
        priority: fields.priority ?? "none", rank: fields.rank ?? 0,
        completedAt: status === "done" ? now : undefined,
      });
      return { target: { kind: "task", id }, targetPublicId: publicId, revision: core.revision };
    }
    case "task.update":
    case "task.archive":
    case "task.reopen":
    case "task.restore": {
      const task = await existing(find.tasks(db, workspaceId, publicId), command.expectedRevision);
      let patch: Partial<Task>;
      if (command.kind === "task.update") {
        patch = await taskFields(db, workspaceId, command.patch, task);
        checkPatch(patch);
        if (patch.status !== undefined && patch.status !== task.status) {
          if (task.status === "archived") invalidState();
          patch.completedAt = patch.status === "done" ? now : undefined;
        }
        if ((patch.rank !== undefined && patch.rank !== task.rank) ||
            ("laneId" in patch && patch.laneId !== task.laneId)) {
          patch.rankTieBreak = undefined;
        }
      } else if (command.kind === "task.archive") {
        if (task.status === "archived") invalidState();
        patch = { status: "archived", archivedAt: now, archivedFromStatus: task.status };
      } else if (command.kind === "task.reopen") {
        if (task.status !== "done") invalidState();
        patch = { status: "ready", completedAt: undefined };
      } else {
        if (task.status !== "archived") invalidState();
        patch = {
          // Older archived rows have only their completion metadata to infer a status from.
          status: task.archivedFromStatus ?? (task.completedAt === undefined ? "ready" : "done"),
          archivedAt: undefined,
          archivedFromStatus: undefined,
        };
      }
      const revision = task.revision + 1;
      await db.patch("tasks", task._id, { ...patch, updatedAt: now, revision });
      return { target: { kind: "task", id: task._id }, targetPublicId: publicId, revision };
    }
    case "project.create": {
      const { name, ...details } = command;
      const core = await newFields(db, "projects", workspaceId, publicId, now);
      const fields = await projectFields(db, workspaceId, details);
      const id = await db.insert("projects", { ...core, ...fields, name: requiredText(name, "name", 512), rank: fields.rank ?? 0 });
      return { target: { kind: "project", id }, targetPublicId: publicId, revision: core.revision };
    }
    case "project.update":
    case "project.archive":
    case "project.restore": {
      const project = await existing(find.projects(db, workspaceId, publicId), command.expectedRevision);
      let patch: Partial<Project>;
      if (command.kind === "project.update") {
        patch = await projectFields(db, workspaceId, command.patch, project._id);
        checkPatch(patch);
      } else {
        if ((project.archivedAt !== undefined) === (command.kind === "project.archive")) invalidState();
        patch = { archivedAt: command.kind === "project.archive" ? now : undefined };
      }
      const revision = project.revision + 1;
      await db.patch("projects", project._id, { ...patch, updatedAt: now, revision });
      return { target: { kind: "project", id: project._id }, targetPublicId: publicId, revision };
    }
    case "step.create": {
      const { title, taskId, ...details } = command;
      const core = await newFields(db, "taskSteps", workspaceId, publicId, now);
      if (await db.query("retiredStepIds").withIndex("by_workspace_public_id", q =>
        q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique()) {
        throw new ConvexError({ code: "ALREADY_EXISTS" });
      }
      await requireWorkspaceRef(db.get("tasks", taskId), workspaceId);
      const fields = stepFields(details);
      const completed = fields.completed ?? false;
      const rank = fields.rank ?? await nextStepRank(db, workspaceId, taskId);
      const id = await db.insert("taskSteps", {
        ...core, taskId, title: requiredText(title, "title", 512), rank, completed,
        completedAt: completed ? now : undefined,
      });
      return { target: { kind: "task_step", id }, targetPublicId: publicId, revision: core.revision };
    }
    case "step.update":
    case "step.delete": {
      const step = await existing(find.taskSteps(db, workspaceId, publicId), command.expectedRevision);
      await requireWorkspaceRef(db.get("tasks", step.taskId), workspaceId);
      const revision = step.revision + 1;
      if (command.kind === "step.delete") {
        await db.insert("retiredStepIds", { workspaceId, publicId, deletedAt: now });
        await db.delete("taskSteps", step._id);
      } else {
        const patch: Partial<Step> = stepFields(command.patch);
        checkPatch(patch);
        if (patch.completed !== undefined && patch.completed !== step.completed) {
          patch.completedAt = patch.completed ? now : undefined;
        }
        await db.patch("taskSteps", step._id, { ...patch, updatedAt: now, revision });
      }
      return { target: { kind: "task_step", id: step._id }, targetPublicId: publicId, revision };
    }
  }
}
