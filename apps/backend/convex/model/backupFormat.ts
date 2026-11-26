import { ConvexError, v, type Infer, type Validator } from "convex/values";
import { deadline, mutableFields, priority, provider, taskStatus, unarchivedTaskStatus, weekday } from "./values";

export const MAX_BACKUP_BYTES = 512 * 1024;
export const MAX_BACKUP_RECORDS = 500;
const format = "klaxon.workspace";
const version = 1;
const encoder = new TextEncoder();

const text = v.string();
const number = v.number();
const flag = v.boolean();
const optionalText = v.optional(text);
const optionalNumber = v.optional(number);
const texts = v.array(text);
const optionalTexts = v.optional(texts);
const planSource = v.union(v.literal("manual"), v.literal("agent"), v.literal("automation"));
const source = v.union(
  v.object({ kind: v.literal("manual") }),
  v.object({ kind: v.literal("capture"), captureId: text }),
  v.object({ kind: v.literal("legacy"), source: text, externalId: optionalText }),
);
const optionalSource = v.optional(source);
const workWindow = v.object({ weekday, startMinute: number, endMinute: number });
const timeBlockFields = {
  ...mutableFields, startAt: number, endAt: number, localDate: text, timezone: text,
  locked: flag, origin: planSource, planId: optionalText,
};

// Version 1 is a field allowlist. Storage IDs are replaced by public IDs of a
// known record kind in this payload. Keep it stable when the live schema changes.
const collections = {
  projects: v.array(v.object({
    ...mutableFields, name: text, area: optionalText, rank: number, archivedAt: optionalNumber,
    board: v.optional(v.object({ laneIds: texts })),
  })),
  lanes: v.array(v.object({
    ...mutableFields, name: text, area: optionalText, projectId: optionalText, rank: number,
    isDefault: flag, archivedAt: optionalNumber,
  })),
  tasks: v.array(v.object({
    ...mutableFields, title: text, description: optionalText, status: taskStatus, priority, rank: number,
    rankTieBreak: optionalNumber, projectId: optionalText, laneId: optionalText, plannedDate: optionalText,
    deadline: v.optional(deadline), estimateMinutes: optionalNumber, source: optionalSource, tags: optionalTexts,
    waitingReason: optionalText, waitingPerson: optionalText, followUpDate: optionalText,
    completedAt: optionalNumber, archivedAt: optionalNumber, archivedFromStatus: v.optional(unarchivedTaskStatus),
  })),
  taskSteps: v.array(v.object({
    ...mutableFields, taskId: text, title: text, completed: flag, completedAt: optionalNumber, rank: number,
  })),
  captures: v.array(v.object({
    ...mutableFields, body: text, tags: texts, source: optionalSource, localDate: optionalText,
    promotedTaskId: optionalText, archivedAt: optionalNumber,
  })),
  dayNotes: v.array(v.object({ ...mutableFields, localDate: text, body: text, tags: optionalTexts, source: optionalSource })),
  reminders: v.array(v.object({
    ...mutableFields, taskId: optionalText, title: text, description: optionalText, priority, dueAt: number,
    timezone: text, state: v.union(v.literal("pending"), v.literal("fired"), v.literal("snoozed"),
      v.literal("dismissed"), v.literal("completed")),
    recurrence: v.optional(v.union(
      v.object({ kind: v.literal("daily") }),
      v.object({ kind: v.literal("weekly"), weekdays: v.array(weekday) }),
      v.object({ kind: v.literal("monthly"), day: number }),
      v.object({ kind: v.literal("interval"), everySeconds: number }),
    )),
    recurrenceBasis: v.optional(v.union(v.literal("local_timezone"), v.literal("legacy_utc"))),
    recurrenceAnchorAt: optionalNumber,
    snoozeUntil: optionalNumber, nextTriggerAt: optionalNumber, source: optionalSource, tags: optionalTexts,
  })),
  dayPlans: v.array(v.object({
    ...mutableFields, localDate: text, timezone: text, briefing: optionalText,
    source: planSource, focusTaskIds: texts, publishedAt: optionalNumber, needsReplan: v.optional(flag),
  })),
  timeBlocks: v.array(v.union(
    v.object({ ...timeBlockFields, taskId: text, title: optionalText }),
    v.object({ ...timeBlockFields, title: text }),
  )),
  externalLinks: v.array(v.object({
    ...mutableFields, taskId: text, provider: v.union(provider, v.literal("url")),
    externalObjectId: optionalText, canonicalUrl: optionalText, label: optionalText,
    relationship: v.literal("reference"),
  })),
  preferences: v.array(v.object({
    ...mutableFields, timezone: text, workHours: v.array(workWindow), breaks: v.optional(v.array(workWindow)),
    bufferMinutes: optionalNumber,
    autonomyPolicy: v.object({
      planApplication: v.union(v.literal("review"), v.literal("automatic")),
      lockManuallyMovedBlocks: flag, discretionaryMinutes: optionalNumber,
    }),
    notificationSettings: v.object({ enabled: flag, webPush: flag, native: flag }),
    importFilters: v.array(v.object({
      provider, assignedOnly: v.optional(flag), scopeIds: optionalTexts, excludedObjectIds: optionalTexts,
    })),
  })),
};

const payloadValidator = v.object({ workspaceName: text, ...collections });
export type BackupPayload = Infer<typeof payloadValidator>;

export function backupError(code: "BACKUP_INVALID" | "BACKUP_VERSION" | "BACKUP_CHECKSUM" | "BACKUP_LIMIT" | "BACKUP_RELATIONSHIP"): never {
  throw new ConvexError(code);
}

export function byteLength(text: string) {
  return encoder.encode(text).byteLength;
}

type Shape = Validator<unknown, "required" | "optional", string>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only the JSON types in the format are accepted. Recursion follows the fixed
// validator depth, even when an untrusted input contains deeply nested values.
function matches(shape: Shape, value: unknown): boolean {
  if (value === undefined) return shape.isOptional === "optional";
  switch (shape.kind) {
    case "string": return typeof value === "string";
    case "float64": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "literal": return shape.value === value;
    case "array": return Array.isArray(value) && value.length <= MAX_BACKUP_RECORDS &&
      value.every(item => matches(shape.element, item));
    case "union": return shape.members.some(member => matches(member, value));
    case "object": return object(value) && Object.keys(value).every(key => Object.hasOwn(shape.fields, key)) &&
      Object.entries(shape.fields).every(([key, field]) => matches(field, value[key]));
    default: return false;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!object(value)) return JSON.stringify(value);
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function checksum(canonical: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validateShape(payload: unknown): asserts payload is BackupPayload {
  if (!object(payload)) backupError("BACKUP_INVALID");
  let count = 0;
  for (const name of Object.keys(collections)) {
    const records = payload[name];
    if (!Array.isArray(records)) backupError("BACKUP_INVALID");
    if (name === "preferences" && records.length > 1) backupError("BACKUP_INVALID");
    count += records.length;
    if (count > MAX_BACKUP_RECORDS) backupError("BACKUP_LIMIT");
  }
  if (!matches(payloadValidator, payload)) backupError("BACKUP_INVALID");
}

export async function encodeBackup(payload: BackupPayload) {
  validateShape(payload);
  validateRecords(payload);
  const canonical = canonicalJson(payload);
  const archive = `{"format":"${format}","version":${version},"checksum":"${await checksum(canonical)}","payload":${canonical}}`;
  if (byteLength(archive) > MAX_BACKUP_BYTES) backupError("BACKUP_LIMIT");
  return archive;
}

export async function decodeBackup(archive: string) {
  if (archive.length > MAX_BACKUP_BYTES || byteLength(archive) > MAX_BACKUP_BYTES) backupError("BACKUP_LIMIT");
  let parsed: unknown;
  try {
    parsed = JSON.parse(archive);
  } catch {
    backupError("BACKUP_INVALID");
  }
  if (!object(parsed) || parsed.format !== format || Object.keys(parsed).length !== 4 ||
    typeof parsed.checksum !== "string" || !/^[a-f0-9]{64}$/.test(parsed.checksum) ||
    !Object.hasOwn(parsed, "payload")) backupError("BACKUP_INVALID");
  if (parsed.version !== version) backupError("BACKUP_VERSION");
  const payload = parsed.payload;
  validateShape(payload);
  if (await checksum(canonicalJson(payload)) !== parsed.checksum) backupError("BACKUP_CHECKSUM");
  validateRecords(payload);
  return { payload, checksum: parsed.checksum, version };
}

function index<R extends { publicId: string }>(rows: R[]) {
  const indexed = new Map<string, R>();
  for (const row of rows) {
    if (!row.publicId || indexed.has(row.publicId)) backupError("BACKUP_RELATIONSHIP");
    indexed.set(row.publicId, row);
  }
  return indexed;
}

function lookup<R>(rows: ReadonlyMap<string, R>, id: string | undefined) {
  if (id === undefined) return undefined;
  const row = rows.get(id);
  if (row === undefined) backupError("BACKUP_RELATIONSHIP");
  return row;
}

function requireProjectLane(
  lanes: ReadonlyMap<string, { projectId?: string }>, laneId: string | undefined, projectId: string | undefined,
) {
  const lane = lookup(lanes, laneId);
  if (lane?.projectId !== undefined && lane.projectId !== projectId) backupError("BACKUP_RELATIONSHIP");
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(date: string) {
  const timestamp = Date.parse(date);
  if (!datePattern.test(date) || !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== date) backupError("BACKUP_INVALID");
}

function checkZone(timezone: string) {
  try {
    if (/^[+-]/.test(timezone)) backupError("BACKUP_INVALID");
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    backupError("BACKUP_INVALID");
  }
}

function validateRecords(payload: BackupPayload) {
  const { workspaceName, ...records } = payload;
  if (!workspaceName.trim()) backupError("BACKUP_INVALID");
  for (const rows of Object.values(records)) {
    index(rows as BackupPayload[keyof typeof collections][number][]);
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (key.endsWith("At") || key === "snoozeUntil" || key === "revision") {
          if (value !== undefined && !Number.isSafeInteger(value)) backupError("BACKUP_INVALID");
        }
        if (typeof value === "string" && key.endsWith("Date")) checkDate(value);
        if (typeof value === "string" && key === "timezone") checkZone(value);
      }
      if (row.revision < 1) backupError("BACKUP_INVALID");
    }
  }

  const projects = index(payload.projects);
  const lanes = index(payload.lanes);
  const tasks = index(payload.tasks);
  const captures = index(payload.captures);
  const plans = index(payload.dayPlans);
  for (const { board, publicId } of payload.projects) {
    const laneIds = board?.laneIds ?? [];
    if (laneIds.length > 64 || new Set(laneIds).size !== laneIds.length) backupError("BACKUP_RELATIONSHIP");
    for (const laneId of laneIds) requireProjectLane(lanes, laneId, publicId);
  }
  for (const { projectId } of payload.lanes) lookup(projects, projectId);
  for (const task of payload.tasks) {
    lookup(projects, task.projectId);
    requireProjectLane(lanes, task.laneId, task.projectId);
    if (task.deadline?.kind === "date") checkDate(task.deadline.date);
    if (task.deadline?.kind === "instant") {
      if (!Number.isSafeInteger(task.deadline.at)) backupError("BACKUP_INVALID");
      if (task.deadline.timezone !== undefined) checkZone(task.deadline.timezone);
    }
  }
  for (const capture of payload.captures) lookup(tasks, capture.promotedTaskId);
  for (const { source } of [...payload.tasks, ...payload.captures, ...payload.dayNotes, ...payload.reminders]) {
    if (source?.kind === "capture") lookup(captures, source.captureId);
  }
  for (const row of [...payload.taskSteps, ...payload.reminders, ...payload.externalLinks]) lookup(tasks, row.taskId);
  for (const plan of payload.dayPlans) for (const id of plan.focusTaskIds) lookup(tasks, id);
  for (const block of payload.timeBlocks) {
    if (block.endAt <= block.startAt) backupError("BACKUP_INVALID");
    if ("taskId" in block) lookup(tasks, block.taskId);
    lookup(plans, block.planId);
  }
  for (const { recurrence } of payload.reminders) {
    if (recurrence?.kind === "monthly" && (!Number.isInteger(recurrence.day) || recurrence.day < 1 || recurrence.day > 31)) {
      backupError("BACKUP_INVALID");
    }
    if (recurrence?.kind === "interval" && (!Number.isSafeInteger(recurrence.everySeconds) || recurrence.everySeconds < 1)) {
      backupError("BACKUP_INVALID");
    }
    if (recurrence?.kind === "weekly" && (!recurrence.weekdays.length || new Set(recurrence.weekdays).size !== recurrence.weekdays.length)) {
      backupError("BACKUP_INVALID");
    }
  }
  for (const preferences of payload.preferences) {
    for (const { startMinute, endMinute } of [...preferences.workHours, ...preferences.breaks ?? []]) {
      if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute) || startMinute < 0 ||
        endMinute > 1440 || startMinute >= endMinute) backupError("BACKUP_INVALID");
    }
  }
}
