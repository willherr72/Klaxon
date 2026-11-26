import { ConvexError, v, type Infer, type Validator } from "convex/values";
import { weekday } from "./values";

export const legacyKinds = ["lanes", "tasks", "steps", "reminders", "captures", "dayNotes"] as const;
export type LegacyKind = typeof legacyKinds[number];

export const sourceTables = {
  lanes: "task_lanes", tasks: "reminders", steps: "task_steps", reminders: "reminders",
  captures: "thoughts", dayNotes: "day_notes", unknownReminder: "reminders",
} as const;
export type SourceKind = keyof typeof sourceTables;

const base = { legacyId: v.string(), publicId: v.string(), createdAt: v.number(), updatedAt: v.number() };
const state = v.union(v.literal("pending"), v.literal("fired"), v.literal("snoozed"),
  v.literal("dismissed"), v.literal("completed"));
const recurrence = v.union(v.object({ kind: v.literal("daily") }),
  v.object({ kind: v.literal("weekly"), weekdays: v.array(weekday) }),
  v.object({ kind: v.literal("monthly"), day: v.number() }),
  v.object({ kind: v.literal("interval"), everySeconds: v.number() }));
const scheduled = {
  ...base,
  title: v.string(), description: v.optional(v.string()), tags: v.array(v.string()),
  state, priority: v.union(v.literal("low"), v.literal("normal"), v.literal("high")),
  attribution: v.object({ source: v.string(), externalId: v.optional(v.string()) }),
  snoozeUntil: v.optional(v.number()), recurrence: v.optional(recurrence),
  recurrenceBasis: v.optional(v.literal("legacy_utc")),
};
const rowShapes = {
  lanes: v.object({ ...base, name: v.string(), orderIndex: v.number(), isDefault: v.boolean() }),
  tasks: v.object({ ...scheduled, dueAt: v.optional(v.number()), lanePublicId: v.string(), rank: v.optional(v.number()) }),
  steps: v.object({ ...base, title: v.string(), completed: v.boolean(), rank: v.number(), taskPublicId: v.string() }),
  reminders: v.object({ ...scheduled, dueAt: v.number() }),
  captures: v.object({ ...base, body: v.string(), tags: v.array(v.string()) }),
  dayNotes: v.object({ ...base, body: v.string(), localDate: v.string() }),
};
export type LegacyRow<K extends LegacyKind = LegacyKind> = Infer<(typeof rowShapes)[K]>;

export type ImportDiagnostic = { code: string; message?: string };
export type SourceHold = { kind: SourceKind; legacyId: string; code: string; state: "quarantined" | "divergent" };
export type SourceCandidate = { kind: SourceKind; legacyId: string; payloadHash: string; sourceUpdatedAt?: number };
export type Tombstone = {
  legacyId: string; deletedAt: number | null; observedKinds: Exclude<SourceKind, "dayNotes">[]; outcome: string;
};
export type LegacyArchive = {
  archiveHash: string;
  reportHash: string;
  sourceOrigin: string;
  records: Record<LegacyKind, unknown[]>;
  sourceHolds: SourceHold[];
  sourceCandidates: SourceCandidate[];
  tombstones: Tombstone[];
  diagnostics: ImportDiagnostic[];
  needsReview: boolean;
  timezone: string;
};

export const MAX_LEGACY_BYTES = 512 * 1024;
export const MAX_LEGACY_ENTRIES = 500;
const uuidV5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lowercaseHex = /^[0-9a-f]{64}$/;
const sourceLabel = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const issueCode = /^[a-z][a-z0-9_]{0,63}$/;
const encoder = new TextEncoder();

export function legacyError(code: string): never {
  throw new ConvexError(code);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string, format: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    legacyError("LEGACY_IMPORT_INVALID");
  }
  if (!object(value) || value.format !== `klaxon-legacy-${format}`) legacyError("LEGACY_IMPORT_INVALID");
  if (value.version !== 1 || value.sourceSchemaVersion !== 17) legacyError("LEGACY_IMPORT_VERSION");
  function validateJson(part: unknown, depth: number) {
    if (depth > 20 || (typeof part === "number" && !Number.isFinite(part))) legacyError("LEGACY_IMPORT_INVALID");
    if (Array.isArray(part)) part.forEach(item => validateJson(item, depth + 1));
    else if (object(part)) Object.values(part).forEach(item => validateJson(item, depth + 1));
  }
  validateJson(value, 0);
  return value;
}

export async function legacyHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && lowercaseHex.test(value);
}

function sourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && Object.hasOwn(sourceTables, value);
}

function instant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}

function localDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-") &&
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
}

function legacyId(value: unknown): value is string {
  return validText(value) && value.length > 0 && Array.from(value).length <= 256 && !/[\x00-\x1f]/.test(value);
}

export function legacyIdentity(row: unknown) {
  return object(row) && legacyId(row.legacyId) ? row.legacyId : undefined;
}

type Shape = Validator<unknown, "required" | "optional", string>;

function matches(shape: Shape, value: unknown): boolean {
  if (value === undefined) return shape.isOptional === "optional";
  switch (shape.kind) {
    case "string": return validText(value);
    case "float64": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "literal": return shape.value === value;
    case "array": return Array.isArray(value) && value.length <= MAX_LEGACY_ENTRIES &&
      value.every(item => matches(shape.element, item));
    case "union": return shape.members.some(member => matches(member, value));
    case "object": return object(value) && Object.keys(value).every(key => Object.hasOwn(shape.fields, key)) &&
      Object.entries(shape.fields).every(([key, field]) => matches(field, value[key]));
    default: return false;
  }
}

async function expectedPublicId(kind: LegacyKind, legacyId: string) {
  // Same UUIDv5 namespace and name as tools/migration/legacy_source.py.
  const namespace = [0x52, 0x4c, 0xd2, 0xe5, 0x2d, 0x3e, 0x45, 0xa0, 0xad, 0xa3, 0xac, 0xd1, 0x5f, 0x5c, 0x24, 0xb8];
  const name = encoder.encode(`${kind}:${legacyId}`);
  const input = new Uint8Array(namespace.length + name.length);
  input.set(namespace);
  input.set(name, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const id = Array.from(bytes.subarray(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function rowHasShape(kind: LegacyKind, input: unknown): input is LegacyRow {
  return matches(rowShapes[kind], input);
}

export async function validatedRow(kind: LegacyKind, input: unknown): Promise<LegacyRow | undefined> {
  if (!rowHasShape(kind, input) || !legacyId(input.legacyId) ||
      !instant(input.createdAt) || !instant(input.updatedAt) ||
      input.publicId !== await expectedPublicId(kind, input.legacyId)) return undefined;
  if ("localDate" in input && (!localDate(input.localDate) || input.localDate !== input.legacyId)) return undefined;
  if ("orderIndex" in input && !Number.isSafeInteger(input.orderIndex)) return undefined;
  if ("taskPublicId" in input && (!uuidV5.test(input.taskPublicId) || !Number.isSafeInteger(input.rank))) return undefined;
  if ("lanePublicId" in input && !uuidV5.test(input.lanePublicId)) return undefined;
  if ("dueAt" in input && !instant(input.dueAt)) return undefined;
  if ("state" in input) {
    if ((input.snoozeUntil !== undefined && !instant(input.snoozeUntil)) ||
        (input.state === "snoozed" && input.snoozeUntil === undefined) ||
        (input.recurrence === undefined) !== (input.recurrenceBasis === undefined)) return undefined;
    const rule = input.recurrence;
    if (rule?.kind === "weekly" && rule.weekdays.length === 0) return undefined;
    if (rule?.kind === "monthly" && (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31)) return undefined;
    if (rule?.kind === "interval" && (!Number.isSafeInteger(rule.everySeconds) || rule.everySeconds < 1)) return undefined;
  }
  return input;
}

function validOrder(value: unknown) {
  const ids = (items: unknown) => Array.isArray(items) && items.length <= MAX_LEGACY_ENTRIES &&
    items.every(id => typeof id === "string" && uuidV5.test(id));
  const groups = (items: unknown) => object(items) && Object.entries(items).every(([key, entries]) => uuidV5.test(key) && ids(entries));
  return object(value) && ids(value.lanes) && groups(value.tasksByLane) && groups(value.stepsByTask);
}

function readTombstone(value: unknown): Tombstone {
  const outcomes = ["no_observed_entity", "ambiguous_identity", "unresolved_tombstone", "deleted",
    "unresolved_version", "surviving_version"];
  if (!object(value) || !legacyId(value.legacyId) || (value.deletedAt !== null && !instant(value.deletedAt)) ||
      typeof value.outcome !== "string" || !outcomes.includes(value.outcome) ||
      !Array.isArray(value.observedKinds) || !value.observedKinds.every(kind => sourceKind(kind) && kind !== "dayNotes") ||
      new Set(value.observedKinds).size !== value.observedKinds.length) legacyError("LEGACY_IMPORT_INVALID");
  return { legacyId: value.legacyId, deletedAt: value.deletedAt, observedKinds: value.observedKinds, outcome: value.outcome };
}

export async function decodeLegacyArchive(input: { manifest: string; projection: string; report: string; timezone: string }): Promise<LegacyArchive> {
  const { manifest, projection, report, timezone } = input;
  if (manifest.length + projection.length + report.length > MAX_LEGACY_BYTES ||
      [manifest, projection, report].reduce((size, item) => size + encoder.encode(item).byteLength, 0) > MAX_LEGACY_BYTES) {
    legacyError("LEGACY_IMPORT_LIMIT");
  }
  let destinationTimezone: string;
  try {
    if (timezone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(timezone)) legacyError("LEGACY_IMPORT_TIMEZONE");
    destinationTimezone = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    legacyError("LEGACY_IMPORT_TIMEZONE");
  }
  const header = parse(manifest, "manifest");
  if (header.status !== "complete" || !object(header.artifacts) || !object(header.sources) ||
      !isDigest(header.artifacts["projection.json"]) || !isDigest(header.artifacts["report.json"]) ||
      Object.keys(header.artifacts).length !== 2) legacyError("LEGACY_IMPORT_INVALID");
  const origins = Object.keys(header.sources).sort();
  const sources = header.sources;
  if (origins.length === 0 || origins.length > 8 || !origins.every(key => {
    const source = sources[key];
    return sourceLabel.test(key) && object(source) && isDigest(source.sha256);
  })) legacyError("LEGACY_IMPORT_INVALID");
  const [archiveHash, projectionHash, reportHash] = await Promise.all([legacyHash(manifest), legacyHash(projection), legacyHash(report)]);
  if (projectionHash !== header.artifacts["projection.json"] || reportHash !== header.artifacts["report.json"]) {
    legacyError("LEGACY_IMPORT_CHECKSUM");
  }
  const data = parse(projection, "projection");
  const review = parse(report, "report");
  if (!object(data.records) || Object.keys(data.records).length !== legacyKinds.length ||
      !object(data.preferences) || !object(data.observedOrder) || Object.keys(data.observedOrder).length !== origins.length ||
      !Array.isArray(data.tombstones) || !object(review.outputCounts) || !Array.isArray(review.issues) ||
      !Array.isArray(review.divergences)) legacyError("LEGACY_IMPORT_INVALID");
  const order = data.observedOrder;
  if (!origins.every(origin => validOrder(order[origin]))) legacyError("LEGACY_IMPORT_INVALID");
  const records = {} as LegacyArchive["records"];
  let count = data.tombstones.length + review.issues.length + review.divergences.length;
  for (const kind of legacyKinds) {
    const rows = data.records[kind];
    if (!Array.isArray(rows) || review.outputCounts[kind] !== rows.length) legacyError("LEGACY_IMPORT_INVALID");
    records[kind] = rows;
    count += rows.length;
  }
  if (count > MAX_LEGACY_ENTRIES) legacyError("LEGACY_IMPORT_LIMIT");
  if (Object.keys(data.preferences).some(key => key !== "list_sort_order") ||
      (data.preferences.list_sort_order !== undefined && data.preferences.list_sort_order !== "date_asc" &&
        data.preferences.list_sort_order !== "date_desc")) {
    legacyError("LEGACY_IMPORT_INVALID");
  }

  const sourceHolds: SourceHold[] = [];
  const sourceCandidates: SourceCandidate[] = [];
  const diagnostics = new Map<string, number>();
  let needsReview = false;
  for (const issue of review.issues) {
    if (!object(issue) || typeof issue.code !== "string" || !issueCode.test(issue.code) ||
        (issue.severity !== "review" && issue.severity !== "quarantine")) legacyError("LEGACY_IMPORT_INVALID");
    diagnostics.set(issue.code, (diagnostics.get(issue.code) ?? 0) + 1);
    if (issue.severity === "quarantine" || issue.unresolved === true) needsReview = true;
    if (issue.severity === "quarantine" && sourceKind(issue.kind) && legacyId(issue.legacyId)) {
      sourceHolds.push({ kind: issue.kind, legacyId: issue.legacyId, code: issue.code, state: "quarantined" });
    }
  }
  for (const divergence of review.divergences) {
    if (!object(divergence) || !sourceKind(divergence.kind) || !legacyId(divergence.legacyId) ||
        typeof divergence.outcome !== "string" || !issueCode.test(divergence.outcome) ||
        !Array.isArray(divergence.candidates) || divergence.candidates.length === 0) legacyError("LEGACY_IMPORT_INVALID");
    count += divergence.candidates.length;
    if (count > MAX_LEGACY_ENTRIES) legacyError("LEGACY_IMPORT_LIMIT");
    for (const variant of divergence.candidates) {
      if (!object(variant)) legacyError("LEGACY_IMPORT_INVALID");
      const payloadHash = variant.sha256 ?? variant.rowSha256;
      const updatedAt = object(variant.record) ? variant.record.updatedAt : variant.updatedAt;
      if (!isDigest(payloadHash) || (updatedAt !== null && !instant(updatedAt))) legacyError("LEGACY_IMPORT_INVALID");
      sourceCandidates.push({ kind: divergence.kind, legacyId: divergence.legacyId, payloadHash, sourceUpdatedAt: updatedAt ?? undefined });
    }
    if (["surviving_version", "deleted"].includes(divergence.outcome)) continue;
    needsReview = true;
    sourceHolds.push({ kind: divergence.kind, legacyId: divergence.legacyId, code: divergence.outcome, state: "divergent" });
  }
  if (Object.keys(data.preferences).length) diagnostics.set("preference_not_applied", Object.keys(data.preferences).length);
  return {
    archiveHash, reportHash, sourceOrigin: origins.join("+"), records, sourceHolds, sourceCandidates,
    tombstones: data.tombstones.map(readTombstone),
    diagnostics: Array.from(diagnostics, ([code, total]) => ({ code, message: String(total) })),
    needsReview, timezone: destinationTimezone,
  };
}
