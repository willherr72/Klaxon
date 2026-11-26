import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  legacyError, legacyHash, legacyKinds, MAX_LEGACY_ENTRIES, projectedRowHash, sourceTables,
  type LegacyArchive, type LegacyKind, type LegacyRow, type SourceCandidate, type SourceHold, type Tombstone,
} from "./legacyImportFormat";

type Writer = MutationCtx["db"];
type Count = Doc<"importRuns">["counts"][number];
type Mapping = Doc<"importMappings">;
type Destination = NonNullable<Mapping["destination"]>;
type Candidate = { kind: LegacyKind; row: LegacyRow; order: number };
type SourceGroup = {
  sourceTable: string;
  legacyId: string;
  rows: Candidate[];
  holds: SourceHold[];
  sourceCandidates: SourceCandidate[];
  tombstone?: Tombstone;
};
type Planned = {
  group: SourceGroup;
  row?: LegacyRow;
  state: Mapping["state"];
  issue?: string;
};

export async function existingLegacyRun(db: Writer, workspaceId: Id<"workspaces">, archive: LegacyArchive) {
  const run = await db.query("importRuns").withIndex("by_workspace_created_at", q =>
    q.eq("workspaceId", workspaceId)).unique();
  if (run && (run.archiveHash !== archive.archiveHash || run.sourceOrigin !== archive.sourceOrigin ||
      run.destinationTimezone !== archive.timezone)) legacyError("LEGACY_IMPORT_ARCHIVE_CONFLICT");
  return run;
}

async function requireEmptyDestination(db: Writer, workspaceId: Id<"workspaces">) {
  const tables = ["lanes", "tasks", "taskSteps", "reminders", "captures", "dayNotes", "projects", "dayPlans", "timeBlocks",
    "externalLinks", "preferences", "integrationConnections", "pushSubscriptions", "reminderOccurrences", "importMappings"] as const;
  const existing = await Promise.all(tables.map(table => db.query(table)
    .withIndex("by_workspace_public_id", q => q.eq("workspaceId", workspaceId)).first()));
  if (existing.some(row => row !== null)) legacyError("LEGACY_IMPORT_WORKSPACE_NOT_EMPTY");
}

function issueCounter(counts: Map<string, number>, code: string) {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

function counter(sourceTable: string): Count {
  return { sourceTable, extracted: 0, imported: 0, skipped: 0, rejected: 0, divergent: 0 };
}

function planArchive(archive: LegacyArchive, counts: Map<string, Count>, issues: Map<string, number>) {
  const groups = new Map<string, SourceGroup>();
  function group(sourceTable: string, legacyId: string) {
    const key = JSON.stringify([sourceTable, legacyId]);
    let found = groups.get(key);
    if (!found) {
      found = { sourceTable, legacyId, rows: [], holds: [], sourceCandidates: [] };
      groups.set(key, found);
    }
    return found;
  }
  for (const kind of legacyKinds) {
    for (const [order, row] of archive.records[kind].entries()) {
      group(sourceTables[kind], row.legacyId).rows.push({ kind, row, order });
    }
  }
  for (const hold of archive.sourceHolds) group(sourceTables[hold.kind], hold.legacyId).holds.push(hold);
  for (const source of archive.sourceCandidates) group(sourceTables[source.kind], source.legacyId).sourceCandidates.push(source);
  const tombstoneCounts = counts.get("tombstones")!;
  for (const tombstone of archive.tombstones) {
    if (tombstone.observedKinds.length === 0) {
      group("tombstones", tombstone.legacyId).tombstone = tombstone;
      continue;
    }
    tombstoneCounts.extracted++;
    switch (tombstone.outcome) {
      case "deleted": case "surviving_version":
        tombstoneCounts.skipped++;
        break;
      default:
        tombstoneCounts.divergent++;
        issueCounter(issues, `tombstone_${tombstone.outcome}`);
    }
    for (const kind of tombstone.observedKinds) group(sourceTables[kind], tombstone.legacyId).tombstone = tombstone;
  }

  const plan = Array.from(groups.values(), (group): Planned => {
    const { rows, holds, tombstone } = group;
    if (holds.some(hold => hold.state === "divergent")) return { group, state: "divergent" };
    if (tombstone && !["deleted", "surviving_version"].includes(tombstone.outcome)) {
      return { group, state: "divergent", issue: `tombstone_${tombstone.outcome}` };
    }
    if (rows.length === 0) {
      if (tombstone?.outcome === "deleted" && tombstone.deletedAt !== null) return { group, state: "deleted" };
      return { group, state: "quarantined", issue: holds.length ? undefined : "missing_projected_tombstone_survivor" };
    }
    const [{ row }] = rows;
    // A source record can be valid evidence while exceeding the destination's import limits.
    if (("tags" in row && row.tags.length > MAX_LEGACY_ENTRIES) ||
        ("recurrence" in row && row.recurrence?.kind === "weekly" && row.recurrence.weekdays.length > MAX_LEGACY_ENTRIES)) {
      return { group, row, state: "quarantined", issue: "invalid_projected_row" };
    }
    if ("lanePublicId" in row && ((row.state !== "pending" && row.state !== "completed") ||
        row.recurrence !== undefined || row.snoozeUntil !== undefined)) {
      return { group, row, state: "quarantined", issue: "unsupported_task_schedule" };
    }
    return { group, row, state: "pending" };
  });

  const defaults = plan.filter(item => item.state === "pending" && item.row && "isDefault" in item.row && item.row.isDefault);
  if (defaults.length === 0) issueCounter(issues, "missing_projected_default_lane");
  if (defaults.length > 1) {
    for (const item of defaults) {
      item.state = "quarantined";
      item.issue = "ambiguous_projected_default_lane";
    }
  }
  return plan;
}

export async function writeLegacyArchive(
  db: Writer,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  archive: LegacyArchive,
  now: number,
) {
  await requireEmptyDestination(db, workspaceId);
  const tables = [...new Set(Object.values(sourceTables)), "tombstones"];
  const counts = new Map(tables.map(table => [table, counter(table)]));
  const issues = new Map<string, number>();
  const plan = planArchive(archive, counts, issues);
  const maxRank = new Map<string, number>();
  for (const item of plan) {
    const row = item.row;
    if (item.state === "pending" && row && "lanePublicId" in row && row.rank !== undefined) {
      const previous = maxRank.get(row.lanePublicId) ?? 0;
      maxRank.set(row.lanePublicId, Math.max(previous, row.rank));
    }
  }

  const ledger = { workspaceId, createdAt: now, updatedAt: now, revision: 1 };
  const runPublicId = crypto.randomUUID();
  const runId = await db.insert("importRuns", {
    ...ledger, publicId: runPublicId, archiveHash: archive.archiveHash, sourceOrigin: archive.sourceOrigin,
    destinationTimezone: archive.timezone, format: "legacy_sqlite", exportFormatVersion: 1, sourceSchemaVersion: 17,
    state: "running", checkpoint: { phase: "materialize", nextBatch: 0 }, counts: [], errors: [],
  });

  const laneIds = new Map<string, Id<"lanes">>();
  const taskIds = new Map<string, Id<"tasks">>();
  async function insert(row: LegacyRow, order: number): Promise<Destination | undefined> {
    const rowBase = { workspaceId, publicId: row.publicId, createdAt: row.createdAt, updatedAt: row.updatedAt, revision: 1 };
    if ("orderIndex" in row) {
      const id = await db.insert("lanes", { ...rowBase, name: row.name, isDefault: row.isDefault, rank: order });
      laneIds.set(row.publicId, id);
      return { kind: "lane", id };
    }
    if ("taskPublicId" in row) {
      const taskId = taskIds.get(row.taskPublicId);
      if (!taskId) return undefined;
      const id = await db.insert("taskSteps", { ...rowBase, taskId, title: row.title, completed: row.completed, rank: order });
      return { kind: "task_step", id };
    }
    if ("state" in row) {
      const common = {
        ...rowBase, title: row.title, description: row.description, priority: row.priority, tags: row.tags,
        source: { kind: "legacy" as const, ...row.attribution },
      };
      if ("lanePublicId" in row) {
        const laneId = laneIds.get(row.lanePublicId);
        if (!laneId) return undefined;
        const id = await db.insert("tasks", {
          ...common, laneId, status: row.state === "completed" ? "done" : "ready",
          deadline: row.dueAt === undefined ? undefined : { kind: "instant", at: row.dueAt },
          rank: row.rank ?? maxRank.get(row.lanePublicId) ?? 0, rankTieBreak: order,
        });
        if (row.rank === undefined) issueCounter(issues, "task_rank_from_projection_order");
        taskIds.set(row.publicId, id);
        return { kind: "task", id };
      }
      // V1 checks weekday membership, so duplicate entries describe one occurrence.
      const recurrence = row.recurrence?.kind === "weekly"
        ? { kind: "weekly" as const, weekdays: [...new Set(row.recurrence.weekdays)] }
        : row.recurrence;
      const id = await db.insert("reminders", {
        ...common, dueAt: row.dueAt, state: row.state, snoozeUntil: row.snoozeUntil,
        timezone: archive.timezone, recurrence, recurrenceBasis: row.recurrenceBasis,
      });
      return { kind: "reminder", id };
    }
    if ("localDate" in row) {
      const id = await db.insert("dayNotes", { ...rowBase, body: row.body, localDate: row.localDate });
      return { kind: "day_note", id };
    }
    const id = await db.insert("captures", {
      ...rowBase, body: row.body, tags: row.tags, source: { kind: "legacy", source: "thoughts" },
    });
    return { kind: "capture", id };
  }

  for (const item of plan) {
    const { group, row } = item;
    const { sourceTable, legacyId, rows, holds, sourceCandidates, tombstone } = group;
    const count = counts.get(sourceTable)!;
    const candidates = rows.length || 1;
    count.extracted += candidates;
    let { state, issue } = item;
    let destination: Destination | undefined;
    if (state === "pending" && row) {
      destination = await insert(row, rows[0].order);
      if (destination) state = "imported";
      else {
        state = "quarantined";
        issue = "unresolved_destination_parent";
      }
    }
    switch (state) {
      case "imported": count.imported++; break;
      case "deleted": count.skipped += candidates; break;
      case "quarantined": count.rejected += candidates; break;
      case "divergent": count.divergent += candidates; break;
      default: throw new Error("An import mapping has no outcome");
    }
    if (issue) issueCounter(issues, issue);
    const codes = [...new Set([...holds.map(hold => hold.code), ...(issue ? [issue] : [])])].sort();
    const evidence: Mapping["candidates"] = [];
    const projected = rows[0];
    if (projected) {
      const selected = sourceCandidates.find(candidate => candidate.selected);
      evidence.push({
        runId, payloadHash: selected?.payloadHash ?? await projectedRowHash(projected.kind, projected.row),
        sourceUpdatedAt: projected.row.updatedAt, sourceOrder: projected.order,
        sourceDeletedAt: tombstone?.deletedAt ?? undefined,
      });
    }
    const retained = new Set(evidence.map(candidate => candidate.payloadHash));
    for (const { payloadHash, sourceUpdatedAt, issues } of sourceCandidates) {
      if (retained.has(payloadHash)) continue;
      retained.add(payloadHash);
      evidence.push({
        runId, payloadHash, sourceUpdatedAt, sourceDeletedAt: tombstone?.deletedAt ?? undefined,
        issues: issues?.length ? issues.map(code => ({ code })) : undefined,
      });
    }
    if (!evidence.length) evidence.push({
      runId, payloadHash: await legacyHash(JSON.stringify([archive.reportHash, sourceTable, legacyId])),
      sourceDeletedAt: tombstone?.deletedAt ?? undefined,
    });
    if (codes.length) {
      const candidateCodes = evidence[0].issues?.map(issue => issue.code) ?? [];
      evidence[0].issues = [...new Set([...candidateCodes, ...codes])].sort().map(code => ({ code }));
    }
    await db.insert("importMappings", {
      ...ledger, publicId: crypto.randomUUID(), sourceTable, legacyId, state, destination,
      destinationPublicId: destination && row?.publicId, selectedRunId: runId, candidates: evidence,
    });
  }

  const resultCounts = Array.from(counts.values());
  const needsReview = archive.needsReview || issues.has("missing_projected_default_lane") ||
    resultCounts.some(count => count.rejected > 0 || count.divergent > 0);
  await db.patch("importRuns", runId, {
    state: needsReview ? "needs_reconciliation" : "verified", checkpoint: { phase: "complete", nextBatch: 1 },
    counts: resultCounts, errors: [...archive.diagnostics, ...Array.from(issues, ([code, total]) => ({ code, message: String(total) }))],
    verification: {
      verifiedAt: now, verifiedBy: userId, reportHash: archive.reportHash,
      checks: [{ code: "artifact_checksums", passed: true }, { code: "report_consistency", passed: true },
        { code: "workspace_reconciliation", passed: !needsReview }],
    },
  });
  return { id: runId, publicId: runPublicId, revision: 1 };
}
