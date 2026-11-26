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
const states = ["pending", "fired", "snoozed", "dismissed", "completed"] as const;
const state = v.union(...states.map(value => v.literal(value)));
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
export type SourceCandidate = {
  kind: SourceKind; legacyId: string; payloadHash: string; sourceUpdatedAt?: number;
  selected?: boolean; issues?: string[];
};
const tombstoneOutcomes = ["no_observed_entity", "ambiguous_identity", "unresolved_tombstone", "deleted",
  "unresolved_version", "surviving_version"] as const;
type Outcome = typeof tombstoneOutcomes[number];
export type Tombstone = {
  legacyId: string; deletedAt: number | null; observedKinds: Exclude<SourceKind, "dayNotes">[]; outcome: Outcome;
  observations: Record<string, number | null>; invalidOrigins: string[];
};
export type LegacyArchive = {
  archiveHash: string;
  reportHash: string;
  sourceOrigin: string;
  records: Record<LegacyKind, LegacyRow[]>;
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
const encoder = new TextEncoder();
const envelopeKeys = ["format", "version", "sourceSchemaVersion"];
const manifestKinds = [...legacyKinds, "unknownReminder", "tombstones"] as const;
type ManifestKind = typeof manifestKinds[number];

export function legacyError(code: string): never {
  throw new ConvexError(code);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key) || optional.includes(key));
}

function requireConsistent(condition: unknown): asserts condition {
  if (!condition) legacyError("LEGACY_IMPORT_INVALID");
}

function oneOf<T>(values: readonly T[], value: unknown): value is T {
  return values.includes(value as T);
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

type Shape = Validator<unknown, "required" | "optional", string>;

function matches(shape: Shape, value: unknown): boolean {
  if (value === undefined) return shape.isOptional === "optional";
  switch (shape.kind) {
    case "string": return validText(value);
    case "float64": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "literal": return shape.value === value;
    case "array": return Array.isArray(value) && value.every(item => matches(shape.element, item));
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

function publicId(value: unknown): value is string {
  return typeof value === "string" && uuidV5.test(value);
}

function distinct<T>(value: unknown, test: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(test) && new Set(value).size === value.length;
}

function tally(values: Iterable<string>) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function checkTotals(value: unknown, expected: ReadonlyMap<string, number>) {
  requireConsistent(exactKeys(value, [...expected.keys()]) &&
    [...expected].every(([key, total]) => value[key] === total));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readSource(value: unknown) {
  requireConsistent(exactKeys(value, ["sha256", "counts", "states"]) && isDigest(value.sha256) &&
    exactKeys(value.counts, manifestKinds) && Object.values(value.counts).every(isCount) &&
    exactKeys(value.states, ["tasks", "reminders"]));
  const counts = value.counts as Record<ManifestKind, number>;
  const stateTotals = value.states;
  for (const kind of ["tasks", "reminders"] as const) {
    const totals = stateTotals[kind];
    requireConsistent(object(totals) && Object.entries(totals).every(([key, total]) =>
      oneOf([...states, "invalid"], key) && isCount(total) && total > 0));
    requireConsistent(Object.values(totals).reduce<number>((sum, total) => sum + (total as number), 0) === counts[kind]);
  }
  return { counts, states: stateTotals as Record<"tasks" | "reminders", Record<string, number>> };
}

const orderedKinds = ["lanes", "tasks", "steps"] as const;
type OrderedKind = typeof orderedKinds[number];
type Order = Record<OrderedKind, Map<string, string | null>>;

function readOrder(value: unknown): Order {
  requireConsistent(exactKeys(value, ["lanes", "tasksByLane", "stepsByTask"]) && distinct(value.lanes, publicId));
  function children(value: unknown) {
    const result = new Map<string, string>();
    requireConsistent(object(value));
    for (const [parent, ids] of Object.entries(value)) {
      requireConsistent(publicId(parent) && distinct(ids, publicId) && ids.length > 0);
      for (const id of ids) {
        requireConsistent(!result.has(id));
        result.set(id, parent);
      }
    }
    return result;
  }
  return { lanes: new Map(value.lanes.map(id => [id, null])), tasks: children(value.tasksByLane), steps: children(value.stepsByTask) };
}

function readTombstone(value: unknown, origins: Set<string>): Tombstone {
  requireConsistent(exactKeys(value, ["legacyId", "deletedAt", "observedKinds", "outcome", "observations", "invalidOrigins"]) &&
    legacyId(value.legacyId) && oneOf(tombstoneOutcomes, value.outcome) &&
    distinct(value.observedKinds, (kind): kind is Tombstone["observedKinds"][number] => sourceKind(kind) && kind !== "dayNotes") &&
    object(value.observations) && distinct(value.invalidOrigins, (origin): origin is string =>
      typeof origin === "string" && origins.has(origin)));
  const observations = value.observations;
  const invalidOrigins = value.invalidOrigins;
  const entries = Object.entries(observations);
  requireConsistent(entries.length > 0 && entries.every(([origin, at]) => origins.has(origin) && (at === null || instant(at))));
  const invalid = entries.filter(([, at]) => at === null).map(([origin]) => origin);
  const dates = Object.values(observations).filter(instant);
  const deletedAt = dates.length ? Math.max(...dates) : null;
  requireConsistent(value.deletedAt === deletedAt && invalidOrigins.length === invalid.length &&
    invalid.every(origin => invalidOrigins.includes(origin)));
  return { legacyId: value.legacyId, deletedAt, observedKinds: value.observedKinds, outcome: value.outcome,
    observations: observations as Tombstone["observations"], invalidOrigins };
}

function pythonFloat(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const [mantissa, exponent] = value.toExponential().split("e");
  const power = Number(exponent);
  if (power < -4 || power >= 16) {
    return `${mantissa}e${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function canonicalRecord(kind: LegacyKind, row: LegacyRow) {
  // The SQLite task_sort_key column has REAL affinity. All other exported numeric
  // record fields are integers. Python emits integral floats with .0 and pads exponents.
  function encode(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    if (!object(value)) return JSON.stringify(value);
    return `{${Object.keys(value).sort().map(key => {
      const part = value[key];
      return `${JSON.stringify(key)}:${kind === "tasks" && value === row && key === "rank" ?
        pythonFloat(part as number) : encode(part)}`;
    }).join(",")}}`;
  }
  return encode(row);
}

export function projectedRowHash(kind: LegacyKind, row: LegacyRow) {
  return legacyHash(canonicalRecord(kind, row));
}

type ReviewIssue = Record<string, unknown> & { code: string; severity: "review" | "quarantine" };
const rowRejects: Record<string, readonly string[]> = {
  invalid_integer: [], invalid_text: [], invalid_local_date: ["id"],
  invalid_tags: ["tags"], invalid_priority: ["priority"], invalid_state: ["state"],
  invalid_recurrence: ["repeat_rule"], invalid_snooze: ["snooze_until"], invalid_silent: ["silent"],
  missing_lane: ["task_lane_id"], invalid_rank: ["task_sort_key"], missing_task_parent: ["task_id"],
};
const rawRejects = ["invalid_tags", "invalid_priority", "invalid_state", "invalid_recurrence", "invalid_snooze",
  "invalid_silent", "missing_lane", "invalid_rank", "missing_task_parent"];

function readIssue(value: unknown, origins: Set<string>): ReviewIssue {
  const origin = (value: unknown): value is string => typeof value === "string" && origins.has(value);
  const kind = (value: unknown): value is ManifestKind => oneOf(manifestKinds, value);
  requireConsistent(object(value) && typeof value.code === "string");
  const validation = (severity: ReviewIssue["severity"], fields: string[], optional: string[] = []) =>
    value.severity === severity && exactKeys(value, ["code", "severity", ...fields], optional);
  const rowFields = ["kind", "legacyId", "origin"];
  const identity = sourceKind(value.kind) && legacyId(value.legacyId);
  const atOrigin = origin(value.origin);
  const sameKind = (kind: SourceKind) => value.kind === kind;
  let valid: boolean;
  if (Object.hasOwn(rowRejects, value.code)) {
    const fields = rowRejects[value.code];
    const raw = rawRejects.includes(value.code);
    valid = validation("quarantine", [...rowFields, "field", ...(raw ? ["raw"] : [])],
      raw ? ["rawTruncated", "rawSha256"] : []) &&
      kind(value.kind) && legacyId(value.legacyId) && atOrigin &&
      typeof value.field === "string" && (!fields.length || fields.includes(value.field)) &&
      (value.rawTruncated === true ? isDigest(value.rawSha256) && typeof value.raw === "string" &&
        Array.from(value.raw).length === 256 : value.rawTruncated === undefined && value.rawSha256 === undefined);
  } else {
    switch (value.code) {
      case "invalid_id":
        valid = validation("quarantine", ["kind", "origin", "rowSha256"]) &&
          kind(value.kind) && atOrigin && isDigest(value.rowSha256);
        break;
      case "task_date_intent_unknown":
        valid = validation("review", [...rowFields, "dueAt"]) && identity && atOrigin &&
          sameKind("tasks") && instant(value.dueAt) && value.dueAt !== 0;
        break;
      case "missing_task_rank": case "silent_task_schedule_metadata":
      case "device_local_sound": case "snooze_state_mismatch":
        valid = validation("review", rowFields) && identity && atOrigin &&
          (sameKind("tasks") || ((value.code === "device_local_sound" || value.code === "snooze_state_mismatch") &&
            sameKind("reminders")));
        break;
      case "invalid_setting":
        valid = validation("quarantine", ["origin", "field"]) && atOrigin && value.field === "list_sort_order";
        break;
      case "unknown_settings":
        valid = validation("review", ["origin", "count"]) && atOrigin && isCount(value.count) && value.count > 0;
        break;
      case "preference_conflict":
        valid = validation("quarantine", ["field", "observations"]) && value.field === "list_sort_order" &&
          object(value.observations) && Object.entries(value.observations).every(([key, sort]) =>
            origins.has(key) && (sort === "date_asc" || sort === "date_desc")) &&
          new Set(Object.values(value.observations)).size === 2;
        break;
      case "silent_kind_conflict": case "ambiguous_tombstone_kind":
        valid = validation("quarantine", ["legacyId", "kinds"]) && legacyId(value.legacyId) &&
          distinct(value.kinds, sourceKind) && value.kinds.length > 1;
        break;
      case "equal_timestamp_conflict":
        valid = validation("quarantine", ["kind", "legacyId", "origins", "updatedAt"]) && identity &&
          distinct(value.origins, origin) && value.origins.length > 1 && instant(value.updatedAt);
        break;
      case "invalid_competing_version": case "invalid_competing_tombstone":
        valid = validation("quarantine", ["kind", "legacyId"]) && identity;
        break;
      case "unresolved_parent":
        valid = validation("quarantine", ["kind", "legacyId", "parentPublicId"]) && identity &&
          (sameKind("tasks") || sameKind("steps")) && publicId(value.parentPublicId);
        break;
      case "missing_default_lane":
        valid = validation("quarantine", ["kind"]) && sameKind("lanes");
        break;
      case "default_lane_repaired":
        valid = validation("review", ["kind", "preferredPublicId", "previousDefaults"]) && sameKind("lanes") &&
          publicId(value.preferredPublicId) && distinct(value.previousDefaults, publicId);
        break;
      case "lane_order_tie":
        valid = validation("review", ["kind", "preferredOrigin", "publicIds", "unresolved"]) && sameKind("lanes") &&
          origin(value.preferredOrigin) && distinct(value.publicIds, publicId) && value.publicIds.length > 1 &&
          typeof value.unresolved === "boolean";
        break;
      case "task_order_tie":
        valid = validation("review", ["kind", "lanePublicId", "publicIds", "unresolved"]) && sameKind("tasks") &&
          publicId(value.lanePublicId) && distinct(value.publicIds, publicId) && value.publicIds.length > 1 &&
          value.unresolved === false;
        break;
      default: valid = false;
    }
  }
  requireConsistent(valid);
  return value as ReviewIssue;
}

type Variant = { hash: string; updatedAt: number | null; origins: string[]; row?: LegacyRow; issues: string[] };
type Decision = { kind: SourceKind; legacyId: string; variants: Variant[]; outcome: Outcome; winnerHash: string | null };
type ObservedCounts = Map<string, Map<ManifestKind, (string | undefined)[]>>;
type ProjectedRows = Record<LegacyKind, Map<string, LegacyRow>>;
const reminderKinds = ["tasks", "reminders", "unknownReminder"] as const;

function identityKey(kind: SourceKind, id: string) {
  return JSON.stringify([kind, id]);
}

async function readDecision(value: unknown, origins: Set<string>): Promise<Decision> {
  requireConsistent(exactKeys(value, ["kind", "legacyId", "candidates", "outcome", "winnerSha256"]) &&
    sourceKind(value.kind) && legacyId(value.legacyId) &&
    oneOf(tombstoneOutcomes, value.outcome) && value.outcome !== "no_observed_entity" &&
    (value.winnerSha256 === null || isDigest(value.winnerSha256)) &&
    Array.isArray(value.candidates) && value.candidates.length > 0);
  const { kind, legacyId: id, candidates, outcome, winnerSha256 } = value;
  const variants = await Promise.all(candidates.map(async (variant: unknown): Promise<Variant> => {
    requireConsistent(object(variant) && distinct(variant.origins, (origin): origin is string =>
      typeof origin === "string" && origins.has(origin)) && variant.origins.length > 0);
    if (Object.hasOwn(variant, "record")) {
      requireConsistent(exactKeys(variant, ["origins", "sha256", "record"]) &&
        kind !== "unknownReminder" && isDigest(variant.sha256));
      const row = await validatedRow(kind, variant.record);
      requireConsistent(row && row.legacyId === id && await projectedRowHash(kind, row) === variant.sha256);
      return { hash: variant.sha256, origins: variant.origins, updatedAt: row.updatedAt, row, issues: [] };
    }
    requireConsistent(exactKeys(variant, ["origins", "rowSha256", "updatedAt"]) && isDigest(variant.rowSha256) &&
      (variant.updatedAt === null || instant(variant.updatedAt)));
    return { hash: variant.rowSha256, origins: variant.origins, updatedAt: variant.updatedAt, issues: [] };
  }));
  const seenOrigins = variants.flatMap(variant => variant.origins);
  requireConsistent(new Set(variants.map(variant => variant.hash)).size === variants.length &&
    new Set(seenOrigins).size === seenOrigins.length);
  return { kind, legacyId: id, variants, outcome, winnerHash: winnerSha256 };
}

function evaluateDecision(decision: Decision, tombstone: Tombstone | undefined, blocked: boolean) {
  const { kind, variants } = decision;
  if (blocked || kind === "unknownReminder") return { outcome: "ambiguous_identity" };
  let contenders = variants;
  if (tombstone) {
    if (kind === "steps" && tombstone.deletedAt !== null) return { outcome: "deleted" };
    if (tombstone.invalidOrigins.length) return { outcome: "unresolved_tombstone", issue: "invalid_competing_tombstone" };
    const deletedAt = tombstone.deletedAt;
    requireConsistent(deletedAt !== null);
    contenders = contenders.filter(variant => variant.updatedAt === null || variant.updatedAt > deletedAt);
    if (!contenders.length) return { outcome: "deleted" };
  }
  if (contenders.some(variant => variant.updatedAt === null)) {
    return { outcome: "unresolved_version", issue: "invalid_competing_version" };
  }
  const latest = Math.max(...contenders.map(variant => variant.updatedAt!));
  const latestVersions = contenders.filter(variant => variant.updatedAt === latest);
  if (latestVersions.some(variant => !variant.row)) {
    return { outcome: "unresolved_version", issue: "invalid_competing_version" };
  }
  if (latestVersions.length > 1) return {
    outcome: "unresolved_version", issue: "equal_timestamp_conflict", latest,
    origins: latestVersions.flatMap(variant => variant.origins),
  };
  return { outcome: "surviving_version", winner: latestVersions[0] };
}

function rowParent(row: LegacyRow) {
  if ("lanePublicId" in row) return row.lanePublicId;
  if ("taskPublicId" in row) return row.taskPublicId;
  return null;
}

function rowState(row?: LegacyRow) {
  return row && "state" in row ? row.state : undefined;
}

function assertSameMembers(left: unknown, right: string[]) {
  requireConsistent(Array.isArray(left) && left.length === right.length && right.every(key => left.includes(key)));
}

function checkSourceCounts(
  sources: Map<string, ReturnType<typeof readSource>>,
  counts: ObservedCounts,
  unassigned: Record<LegacyKind, LegacyRow[]>,
) {
  for (const kind of manifestKinds) {
    const rows = oneOf(legacyKinds, kind) ? unassigned[kind] : [];
    let remaining = 0;
    const remainingStates = new Map<string, number>();
    const unassignedStates = tally(rows.flatMap(row => rowState(row) ?? []));
    for (const [origin, source] of sources) {
      const observed = counts.get(origin)?.get(kind) ?? [];
      const unmatched = source.counts[kind] - observed.length;
      requireConsistent(unmatched >= 0 && unmatched <= rows.length);
      remaining += unmatched;
      if (kind !== "tasks" && kind !== "reminders") continue;
      const known = tally(observed.filter(value => value !== undefined));
      const unknown = observed.length - observed.filter(value => value !== undefined).length;
      for (const state of [...states, "invalid"]) {
        const available = (source.states[kind][state] ?? 0) - (known.get(state) ?? 0);
        requireConsistent(available >= 0 && available <= unknown + Math.min(unmatched, unassignedStates.get(state) ?? 0));
        remainingStates.set(state, (remainingStates.get(state) ?? 0) + available);
      }
    }
    requireConsistent(remaining >= rows.length);
    for (const [state, total] of unassignedStates) requireConsistent((remainingStates.get(state) ?? 0) >= total);
  }
}

async function validateReview(
  issues: ReviewIssue[],
  decisions: Decision[],
  projected: ProjectedRows,
  tombstones: Map<string, Tombstone>,
  orders: Map<string, Order>,
  sources: Map<string, ReturnType<typeof readSource>>,
) {
  const sourceHolds: SourceHold[] = [];
  const sourceCandidates: SourceCandidate[] = [];
  const used = new Set<ReviewIssue>();
  function requireIssue(code: string, predicate: (issue: ReviewIssue) => boolean) {
    const matches = issues.filter(issue => issue.code === code && predicate(issue));
    requireConsistent(matches.length === 1);
    used.add(matches[0]);
    return matches[0];
  }
  const choices = new Map<string, Decision>();
  const observedKinds = new Map<string, Set<SourceKind>>();
  function noteIdentity(kind: SourceKind, id: string) {
    if (!observedKinds.has(id)) observedKinds.set(id, new Set());
    observedKinds.get(id)!.add(kind);
  }
  for (const decision of decisions) {
    const key = identityKey(decision.kind, decision.legacyId);
    requireConsistent(!choices.has(key));
    choices.set(key, decision);
    noteIdentity(decision.kind, decision.legacyId);
  }
  for (const kind of legacyKinds) for (const id of projected[kind].keys()) noteIdentity(kind, id);

  const unparented = new Map<string, ReviewIssue>();
  const rowIds = Object.fromEntries(orderedKinds.map(kind =>
    [kind, new Set([...projected[kind].values()].map(row => row.publicId))])) as Record<OrderedKind, Set<string>>;
  for (const issue of issues.filter(issue => issue.code === "unresolved_parent")) {
    const kind = issue.kind as "tasks" | "steps";
    const id = issue.legacyId as string;
    const key = identityKey(kind, id);
    requireConsistent(!unparented.has(key) && !projected[kind].has(id) &&
      !rowIds[kind === "tasks" ? "lanes" : "tasks"].has(issue.parentPublicId as string));
    unparented.set(key, issue);
    noteIdentity(kind, id);
    sourceHolds.push({ kind, legacyId: id, code: issue.code, state: "quarantined" });
  }

  const blocked = new Set<string>();
  for (const [id, kinds] of observedKinds) {
    const reminders = reminderKinds.filter(kind => kinds.has(kind));
    if (reminders.length < 2) continue;
    const issue = requireIssue("silent_kind_conflict", issue => issue.legacyId === id);
    assertSameMembers(issue.kinds, reminders);
    for (const kind of reminders) blocked.add(identityKey(kind, id));
  }

  const counts: ObservedCounts = new Map();
  function observe(origin: string, kind: ManifestKind, state?: string) {
    if (!counts.has(origin)) counts.set(origin, new Map());
    const summary = counts.get(origin)!;
    if (!summary.has(kind)) summary.set(kind, []);
    summary.get(kind)!.push(state);
  }
  for (const tombstone of tombstones.values()) {
    const { legacyId: id } = tombstone;
    const kinds = [...(observedKinds.get(id) ?? [])].filter(kind => kind !== "dayNotes");
    assertSameMembers(tombstone.observedKinds, kinds);
    if (!kinds.length) requireConsistent(tombstone.outcome === "no_observed_entity");
    if (kinds.length > 1) {
      requireConsistent(tombstone.outcome === "ambiguous_identity");
      const issue = requireIssue("ambiguous_tombstone_kind", issue => issue.legacyId === id);
      assertSameMembers(issue.kinds, kinds);
      for (const kind of kinds) blocked.add(identityKey(kind, id));
    }
    for (const kind of kinds) requireConsistent(choices.has(identityKey(kind, id)));
    for (const [origin, at] of Object.entries(tombstone.observations)) {
      observe(origin, "tombstones");
      if (at === null) requireIssue("invalid_integer", issue => issue.kind === "tombstones" &&
        issue.legacyId === id && issue.origin === origin && issue.field === "deleted_at");
    }
  }
  for (const issue of issues.filter(issue => issue.code === "invalid_id")) {
    observe(issue.origin as string, issue.kind as ManifestKind);
  }

  const lanes = [...projected.lanes.values()] as LegacyRow<"lanes">[];
  const defaults = lanes.filter(row => row.isDefault);
  requireConsistent(!lanes.length || defaults.length === 1);
  if (!lanes.length) requireIssue("missing_default_lane", () => true);
  const repairs = issues.filter(issue => issue.code === "default_lane_repaired");
  const repair = repairs[0];
  requireConsistent(repairs.length <= 1);
  let originalDefaults = new Set(defaults.map(row => row.publicId));
  if (repair) {
    const previous = repair.previousDefaults as string[];
    originalDefaults = new Set(previous);
    const eligible = previous.length ? lanes.filter(lane => originalDefaults.has(lane.publicId)) : lanes;
    const chosen = eligible.find(lane => lane.legacyId === "00000000-0000-4000-8000-000000000001") ?? eligible[0];
    requireConsistent(previous.length !== 1 && (!previous.length || eligible.length === previous.length) &&
      chosen && chosen.publicId === repair.preferredPublicId && defaults[0]?.publicId === chosen.publicId);
  }

  function observeOrder(origin: string, kind: OrderedKind, id: string, parent: string | null, state?: string) {
    const order = orders.get(origin)![kind];
    requireConsistent(order.get(id) === parent);
    order.delete(id);
    observe(origin, kind, state);
  }
  for (const decision of decisions) {
    const { kind, legacyId: id, variants } = decision;
    const key = identityKey(kind, id);
    const tombstone = kind === "dayNotes" ? undefined : tombstones.get(id);
    const { outcome, winner, issue, latest, origins } = evaluateDecision(decision, tombstone, blocked.has(key));
    requireConsistent(decision.outcome === outcome && decision.winnerHash === (winner?.hash ?? null) &&
      (variants.length > 1 || tombstone || !winner));
    if (tombstone?.observedKinds.length === 1) requireConsistent(tombstone.outcome === outcome);
    if (issue) {
      const resolution = requireIssue(issue, candidate => candidate.kind === kind && candidate.legacyId === id);
      if (origins) {
        assertSameMembers(resolution.origins, origins);
        requireConsistent(resolution.updatedAt === latest);
      }
    }
    if (outcome !== "deleted" && !winner) {
      sourceHolds.push({ kind, legacyId: id, code: outcome, state: "divergent" });
    }
    const row = kind === "unknownReminder" ? undefined : projected[kind].get(id);
    const missingParent = unparented.get(key);
    if (kind !== "unknownReminder" && winner?.row) {
      if (row) {
        const original = "isDefault" in row ? { ...row, isDefault: originalDefaults.has(row.publicId) } : row;
        requireConsistent(await projectedRowHash(kind, original) === winner.hash);
      } else {
        requireConsistent(missingParent && rowParent(winner.row) === missingParent.parentPublicId);
      }
    } else requireConsistent(!row && !missingParent);

    for (const variant of variants) {
      const codes = new Set<string>();
      for (const origin of variant.origins) {
        if (variant.row) {
          if (oneOf(orderedKinds, kind)) {
            observeOrder(origin, kind, variant.row.publicId, rowParent(variant.row), rowState(variant.row));
          } else observe(origin, kind, rowState(variant.row));
        } else {
          const rejects = issues.filter(issue => Object.hasOwn(rowRejects, issue.code) &&
            issue.kind === kind && issue.legacyId === id && issue.origin === origin);
          requireConsistent(rejects.length > 0);
          for (const reject of rejects) {
            used.add(reject);
            codes.add(reject.code);
          }
          observe(origin, kind, codes.has("invalid_state") ? "invalid" : undefined);
        }
      }
      sourceCandidates.push({ kind, legacyId: id, payloadHash: variant.hash, sourceUpdatedAt: variant.updatedAt ?? undefined,
        selected: row !== undefined && variant === winner, issues: [...codes].sort() });
    }
  }

  const unassigned = {} as Record<LegacyKind, LegacyRow[]>;
  for (const kind of legacyKinds) {
    const rows = [...projected[kind].values()];
    unassigned[kind] = [];
    for (const row of rows) {
      const child = kind === "tasks" || kind === "steps";
      if (child) requireConsistent(rowIds[kind === "tasks" ? "lanes" : "tasks"].has(rowParent(row)!));
      const key = identityKey(kind, row.legacyId);
      if (choices.has(key)) continue;
      requireConsistent(!blocked.has(key));
      if (oneOf(orderedKinds, kind)) {
        const matched = [...orders].filter(([, order]) => order[kind].has(row.publicId));
        requireConsistent(matched.length > 0);
        for (const [origin] of matched) observeOrder(origin, kind, row.publicId, rowParent(row), rowState(row));
      } else unassigned[kind].push(row);
    }
  }
  for (const [key, issue] of unparented) {
    if (choices.has(key)) continue;
    requireConsistent(!blocked.has(key));
    const kind = issue.kind as "tasks" | "steps";
    const pubId = await expectedPublicId(kind, issue.legacyId as string);
    const matched = [...orders].filter(([, order]) => order[kind].has(pubId));
    requireConsistent(matched.length > 0);
    for (const [origin] of matched) observeOrder(origin, kind, pubId, issue.parentPublicId as string);
  }
  for (const order of orders.values()) requireConsistent(orderedKinds.every(kind => order[kind].size === 0));
  checkSourceCounts(sources, counts, unassigned);
  const decisionIssues = ["silent_kind_conflict", "ambiguous_tombstone_kind", "equal_timestamp_conflict",
    "invalid_competing_version", "invalid_competing_tombstone", "missing_default_lane"];
  requireConsistent(issues.every(issue => (!Object.hasOwn(rowRejects, issue.code) && !decisionIssues.includes(issue.code)) ||
    used.has(issue)));
  return { sourceHolds, sourceCandidates };
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
  if (!exactKeys(header, [...envelopeKeys, "status", "artifacts", "sources"]) ||
      header.status !== "complete" || !exactKeys(header.artifacts, ["projection.json", "report.json"]) || !object(header.sources) ||
      !isDigest(header.artifacts["projection.json"]) || !isDigest(header.artifacts["report.json"])) legacyError("LEGACY_IMPORT_INVALID");
  const origins = Object.keys(header.sources).sort();
  requireConsistent(origins.length > 0 && origins.length <= 8 && origins.every(key => sourceLabel.test(key)));
  const [archiveHash, projectionHash, reportHash] = await Promise.all([legacyHash(manifest), legacyHash(projection), legacyHash(report)]);
  if (projectionHash !== header.artifacts["projection.json"] || reportHash !== header.artifacts["report.json"]) {
    legacyError("LEGACY_IMPORT_CHECKSUM");
  }
  const sources = new Map(Object.entries(header.sources).map(([origin, value]) => [origin, readSource(value)]));
  const originSet = new Set(origins);
  const data = parse(projection, "projection");
  const review = parse(report, "report");
  requireConsistent(exactKeys(data, [...envelopeKeys, "records", "preferences", "observedOrder", "tombstones"]) &&
    exactKeys(data.records, legacyKinds) && exactKeys(data.observedOrder, origins) && Array.isArray(data.tombstones) &&
    exactKeys(data.preferences, [], ["list_sort_order"]) &&
    (data.preferences.list_sort_order === undefined || data.preferences.list_sort_order === "date_asc" ||
      data.preferences.list_sort_order === "date_desc") &&
    exactKeys(review, [...envelopeKeys, "issues", "divergences", "outputCounts", "outputStates", "issueCounts", "tombstoneOutcomes"]) &&
    exactKeys(review.outputCounts, legacyKinds) && exactKeys(review.outputStates, ["tasks", "reminders"]) &&
    Array.isArray(review.issues) && Array.isArray(review.divergences));
  const records = {} as LegacyArchive["records"];
  const projected = {} as ProjectedRows;
  let count = data.tombstones.length + review.issues.length + review.divergences.length;
  for (const kind of legacyKinds) {
    const rows = data.records[kind];
    requireConsistent(Array.isArray(rows) && review.outputCounts[kind] === rows.length);
    count += rows.length;
  }
  for (const decision of review.divergences) {
    requireConsistent(object(decision) && Array.isArray(decision.candidates));
    count += decision.candidates.length;
  }
  if (count > MAX_LEGACY_ENTRIES) legacyError("LEGACY_IMPORT_LIMIT");

  for (const kind of legacyKinds) {
    const rows = await Promise.all((data.records[kind] as unknown[]).map(row => validatedRow(kind, row)));
    const identified = new Map<string, LegacyRow>();
    for (const row of rows) {
      requireConsistent(row && !identified.has(row.legacyId));
      identified.set(row.legacyId, row);
    }
    projected[kind] = identified;
    records[kind] = [...identified.values()];
  }
  for (const kind of ["tasks", "reminders"] as const) {
    checkTotals(review.outputStates[kind], tally([...projected[kind].values()].map(row => rowState(row)!)));
  }
  const issues = review.issues.map(issue => readIssue(issue, originSet));
  const diagnostics = tally(issues.map(issue => issue.code));
  checkTotals(review.issueCounts, diagnostics);
  const tombstones = data.tombstones.map(value => readTombstone(value, originSet));
  const byTombstoneId = new Map(tombstones.map(tombstone => [tombstone.legacyId, tombstone]));
  requireConsistent(byTombstoneId.size === tombstones.length);
  checkTotals(review.tombstoneOutcomes, tally(tombstones.map(tombstone => tombstone.outcome)));
  const orders = new Map(Object.entries(data.observedOrder).map(([origin, value]) => [origin, readOrder(value)]));
  const decisions = await Promise.all(review.divergences.map(decision => readDecision(decision, originSet)));
  const { sourceHolds, sourceCandidates } = await validateReview(issues, decisions, projected, byTombstoneId, orders, sources);
  const needsReview = issues.some(issue => issue.severity === "quarantine" || issue.unresolved === true) ||
    sourceHolds.length > 0 || tombstones.some(tombstone => !["deleted", "surviving_version"].includes(tombstone.outcome));
  if (Object.keys(data.preferences).length) diagnostics.set("preference_not_applied", Object.keys(data.preferences).length);
  return {
    archiveHash, reportHash, sourceOrigin: origins.join("+"), records, sourceHolds, sourceCandidates,
    tombstones,
    diagnostics: Array.from(diagnostics, ([code, total]) => ({ code, message: String(total) })),
    needsReview, timezone: destinationTimezone,
  };
}
