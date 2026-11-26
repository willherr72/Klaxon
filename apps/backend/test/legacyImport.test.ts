import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { legacyImportDivergentFixture, legacyImportFixture, legacyImportMalformedCandidateFixture } from "./legacyImportFixture";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

const transaction = vi.hoisted(() => ({ failAfterWrites: false }));
vi.mock("../convex/model/operations", async importOriginal => {
  const actual = await importOriginal<typeof import("../convex/model/operations")>();
  const runOperation: typeof actual.runOperation = async (db, request, apply) => {
    const result = await actual.runOperation(db, request, apply);
    if (transaction.failAfterWrites && request.action === "legacy_import.apply") {
      throw new Error("forced failure after domain and ledger writes");
    }
    return result;
  };
  return { ...actual, runOperation };
});

async function backend() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/imports.ts": () => import("../convex/imports"),
    "../convex/tasks.ts": () => import("../convex/tasks"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
    "../convex/steps.ts": () => import("../convex/steps"),
  } });
  const [ownerId, otherId] = await t.run(async ({ db }) =>
    [await db.insert("users", {}), await db.insert("users", {})]);
  const owner = t.withIdentity({ subject: ownerId });
  const other = t.withIdentity({ subject: otherId });
  const personal = await owner.mutation(anyApi.workspaces.ensurePersonal, {});
  const createArgs = { workspaceId: personal._id, operationId: crypto.randomUUID() };
  const { workspaceId }: { workspaceId: Id<"workspaces"> } =
    await owner.mutation(anyApi.imports.createWorkspace, createArgs);
  const applyArgs = { workspaceId, operationId: crypto.randomUUID(), timezone: "America/Chicago", ...legacyImportFixture };
  return { t, owner, other, otherId, personal, createArgs, applyArgs, workspaceId };
}

async function checksum(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function withArtifact(
  fixture: typeof legacyImportFixture,
  name: "projection" | "report",
  change: (input: ReturnType<typeof JSON.parse>) => void,
) {
  const manifest = JSON.parse(fixture.manifest);
  const input = JSON.parse(fixture[name]);
  change(input);
  const changed = JSON.stringify(input);
  manifest.artifacts[`${name}.json`] = await checksum(changed);
  return { ...fixture, manifest: JSON.stringify(manifest), [name]: changed };
}

test("imports the CLI's synthetic projection and replays without duplicating destinations or mappings", async () => {
  const { t, owner, applyArgs, createArgs, workspaceId } = await backend();
  expect(await owner.mutation(anyApi.imports.createWorkspace, createArgs)).toMatchObject({ workspaceId });
  await expect(owner.mutation(anyApi.tasks.apply, {
    ...createArgs, command: { kind: "task.create", publicId: "same-operation", title: "Conflicting request" },
  })).rejects.toThrow(/OPERATION_ID_CONFLICT/);
  const run = await owner.mutation(anyApi.imports.apply, applyArgs);
  expect(run).toMatchObject({
    archiveHash: await checksum(applyArgs.manifest), checkpoint: { phase: "complete", nextBatch: 1 }, state: "verified",
    verification: { checks: [
      { code: "artifact_checksums", passed: true }, { code: "report_consistency", passed: true },
      { code: "workspace_reconciliation", passed: true },
    ] },
  });
  expect(await owner.mutation(anyApi.imports.apply, applyArgs)).toEqual(run);
  expect(await owner.mutation(anyApi.imports.apply, { ...applyArgs, operationId: crypto.randomUUID() })).toEqual(run);
  expect(await owner.query(anyApi.imports.get, { workspaceId, publicId: run.publicId })).toEqual(run);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, operationId: crypto.randomUUID(), timezone: "UTC" }))
    .rejects.toThrow(/LEGACY_IMPORT_ARCHIVE_CONFLICT/);
  expect(run.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "task_date_intent_unknown" }),
    expect.objectContaining({ code: "device_local_sound" }),
    expect.objectContaining({ code: "preference_not_applied" }),
  ]));

  const task = await t.run(async ({ db }) => {
    const lanes = await db.query("lanes").collect();
    const tasks = await db.query("tasks").collect();
    const done = tasks.find(row => row.status === "done")!;
    expect(lanes).toHaveLength(2);
    expect(tasks).toHaveLength(2);
    expect(lanes.find(row => row._id === done.laneId)?.isDefault).toBe(true);
    expect(done).toMatchObject({ rank: 100.0000000001, deadline: { kind: "instant", at: 1795449600000 } });
    expect(done.completedAt).toBeUndefined();
    expect((await db.query("reminders").collect()).find(row => row.state === "snoozed")).toMatchObject({
      timezone: "America/Chicago", snoozeUntil: 200, recurrence: { kind: "monthly", day: 31 },
      recurrenceBasis: "legacy_utc", source: { kind: "legacy", source: "provider", externalId: "external-attribution" },
    });
    for (const reminder of await db.query("reminders").collect()) expect(reminder.nextTriggerAt).toBeUndefined();
    expect(await db.query("reminderOccurrences").collect()).toEqual([]);
    expect(await db.query("pushSubscriptions").collect()).toEqual([]);
    expect(await db.query("captures").collect()).toEqual([expect.objectContaining({ body: "capture" })]);
    expect(await db.query("dayNotes").collect()).toEqual(expect.arrayContaining([
      expect.objectContaining({ localDate: "2024-02-29", body: "" }),
      expect.objectContaining({ localDate: "2026-11-23", body: "mañana 日本語" }),
    ]));
    expect(await db.query("importRuns").collect()).toHaveLength(1);
    expect(await db.query("importMappings").collect()).toHaveLength(13);
    return done;
  });
  const steps = await owner.query(anyApi.steps.list, { workspaceId, taskId: task._id, paginationOpts: { cursor: null, numItems: 5 } });
  expect(steps.page.map((step: { title: string }) => step.title)).toEqual(["earlier step", "committed"]);
});

test("requires an owner and a dedicated workspace before accepting an archive", async () => {
  const { t, owner, other, otherId, personal, applyArgs } = await backend();
  await expect(t.mutation(anyApi.imports.apply, applyArgs)).rejects.toThrow(/UNAUTHENTICATED/);
  await expect(other.mutation(anyApi.imports.apply, applyArgs)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  await t.run(({ db }) => db.insert("memberships", {
    workspaceId: applyArgs.workspaceId, userId: otherId, publicId: "planner", role: "planner",
    createdAt: 1, updatedAt: 1, revision: 1,
  }));
  await expect(other.mutation(anyApi.imports.apply, applyArgs)).rejects.toThrow(/FORBIDDEN/);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, workspaceId: personal._id }))
    .rejects.toThrow(/LEGACY_IMPORT_WORKSPACE/);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, projection: `${applyArgs.projection} ` }))
    .rejects.toThrow(/LEGACY_IMPORT_CHECKSUM/);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, report: `${applyArgs.report} ` }))
    .rejects.toThrow(/LEGACY_IMPORT_CHECKSUM/);
  const manifest = JSON.stringify({ ...JSON.parse(applyArgs.manifest), version: 2 });
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, manifest })).rejects.toThrow(/LEGACY_IMPORT_VERSION/);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, projection: "x".repeat(512 * 1024) }))
    .rejects.toThrow(/LEGACY_IMPORT_LIMIT/);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, timezone: "Fake/Zone" }))
    .rejects.toThrow(/LEGACY_IMPORT_TIMEZONE/);
  expect(await t.run(({ db }) => db.query("importRuns").collect())).toEqual([]);
});

test("retains the source's unresolved variants and deletions alongside the ordered survivors", async () => {
  const { t, owner, other, applyArgs, workspaceId } = await backend();
  const run = await owner.mutation(anyApi.imports.apply, { ...applyArgs, ...legacyImportDivergentFixture });
  expect(run).toMatchObject({ sourceOrigin: "alpha+beta", state: "needs_reconciliation" });
  expect(run.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "silent_kind_conflict" }),
    expect.objectContaining({ code: "equal_timestamp_conflict" }),
    expect.objectContaining({ code: "tombstone_no_observed_entity" }),
  ]));
  expect(run.counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceTable: "tombstones", extracted: 4, skipped: 3, divergent: 1 }),
  ]));
  const paginationOpts = { cursor: null, numItems: 20 };
  const args = { workspaceId, state: "divergent", paginationOpts };
  await expect(other.query(anyApi.imports.listHolds, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  const { page } = await owner.query(anyApi.imports.listHolds, args);
  expect(page).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceTable: "reminders", legacyId: "t", candidates: expect.arrayContaining([
      expect.objectContaining({ sourceUpdatedAt: 2 }), expect.objectContaining({ sourceUpdatedAt: 3 }),
    ]) }),
    expect.objectContaining({ sourceTable: "day_notes", legacyId: "2026-11-23" }),
    expect.objectContaining({ sourceTable: "tombstones", legacyId: "untyped" }),
  ]));
  const deleted = await owner.query(anyApi.imports.listHolds, { ...args, state: "deleted" });
  expect(deleted.page).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceTable: "task_steps", legacyId: "s" }),
    expect.objectContaining({ sourceTable: "reminders", legacyId: "r" }),
  ]));
  await t.run(async ({ db }) => {
    const lane = await db.query("lanes").collect().then(rows => rows.find(row => row.name === "Work")!);
    const tasks = await db.query("tasks").withIndex("by_workspace_lane_rank", q =>
      q.eq("workspaceId", workspaceId).eq("laneId", lane._id)).collect();
    expect(tasks.map(row => [row.title, row.rank])).toEqual([
      ["childless", 99.9999999999], ["ordered", 100], ["newest", 100],
    ]);
    expect(await db.query("reminders").collect()).toEqual([]);
    expect(await db.query("taskSteps").collect()).toEqual([]);
  });
});

const inconsistentArchives = [
  ["missing state totals", legacyImportFixture, "report", report => delete report.outputStates],
  ["incorrect state totals", legacyImportFixture, "report", report => { report.outputStates.tasks.pending = 2; }],
  ["incorrect issue totals", legacyImportFixture, "report", report => { report.issueCounts = {}; }],
  ["incorrect tombstone totals", legacyImportDivergentFixture, "report", report => { report.tombstoneOutcomes = {}; }],
  ["stripped decisions", legacyImportDivergentFixture, "report", report => { report.divergences = []; }],
  ["stripped quarantines and their totals", legacyImportMalformedCandidateFixture, "report", report => {
    report.issues = report.issues.filter((issue: { code: string }) => issue.code !== "invalid_tags");
    delete report.issueCounts.invalid_tags;
  }],
  ["a stripped decision and its quarantine", legacyImportMalformedCandidateFixture, "report", report => {
    report.divergences = report.divergences.filter((item: { legacyId: string }) => item.legacyId !== "r");
    report.issues = report.issues.filter((issue: { code: string }) => issue.code !== "invalid_tags");
    delete report.issueCounts.invalid_tags;
  }],
  ["a losing candidate marked as winner", legacyImportDivergentFixture, "report", report => {
    const decision = report.divergences.find((item: { legacyId: string }) => item.legacyId === "u");
    decision.winnerSha256 = decision.candidates.find((item: { record: { updatedAt: number } }) =>
      item.record.updatedAt === 2).sha256;
  }],
  ["a winner hash whose record was modified", legacyImportDivergentFixture, "report", report => {
    const decision = report.divergences.find((item: { legacyId: string }) => item.legacyId === "u");
    decision.candidates.find((item: { sha256: string }) => item.sha256 === decision.winnerSha256).record.title = "changed";
  }],
  ["a projected survivor that differs from its winner", legacyImportDivergentFixture, "projection", projection => {
    projection.records.tasks.find((item: { legacyId: string }) => item.legacyId === "u").title = "changed";
  }],
  ["a projected identity with contradictory kind and UUID", legacyImportFixture, "projection", projection => {
    projection.records.reminders[0].legacyId = projection.records.tasks[0].legacyId;
  }],
] satisfies [string, typeof legacyImportFixture, "projection" | "report", (input: ReturnType<typeof JSON.parse>) => void][];

test.each(inconsistentArchives)("rejects rechecksummed archives with %s before writing", async (_name, fixture, name, change) => {
  const { t, owner, applyArgs } = await backend();
  const archive = await withArtifact(fixture, name, change);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, ...archive })).rejects.toThrow(/LEGACY_IMPORT_INVALID/);
  await t.run(async ({ db }) => {
    for (const table of ["lanes", "tasks", "taskSteps", "reminders", "captures", "dayNotes", "importMappings", "importRuns"] as const) {
      expect(await db.query(table).collect()).toEqual([]);
    }
    expect(await db.query("operationReceipts").collect()).toHaveLength(1);
    expect(await db.query("activityEvents").collect()).toHaveLength(1);
  });
});

test("imports a newer valid reminder and attaches the malformed older candidate's issue to its own hash", async () => {
  const { t, owner, applyArgs } = await backend();
  const fixture = legacyImportMalformedCandidateFixture;
  const run = await owner.mutation(anyApi.imports.apply, { ...applyArgs, ...fixture });
  expect(run).toMatchObject({
    state: "needs_reconciliation",
    errors: expect.arrayContaining([expect.objectContaining({ code: "invalid_tags" })]),
  });
  const decision = JSON.parse(fixture.report).divergences.find((item: { legacyId: string }) => item.legacyId === "r");
  const malformed = decision.candidates.find((candidate: { rowSha256?: string }) => candidate.rowSha256);
  await t.run(async ({ db }) => {
    const reminder = await db.query("reminders").unique();
    expect(reminder).toMatchObject({ title: "Newer ☃ 🌍", state: "completed", updatedAt: 3, tags: [] });
    const mappings = await db.query("importMappings").collect();
    const mapping = mappings.find(item => item.sourceTable === "reminders" && item.legacyId === "r");
    expect(mapping).toMatchObject({
      state: "imported",
      destination: { kind: "reminder", id: reminder?._id },
      candidates: [
        { payloadHash: decision.winnerSha256, sourceUpdatedAt: 3, sourceOrder: 0 },
        { payloadHash: malformed.rowSha256, sourceUpdatedAt: 2, issues: [{ code: "invalid_tags" }] },
      ],
    });
    expect(mapping?.candidates[0].issues).toBeUndefined();
    expect((await db.query("tasks").collect()).some(task => task.rank === 1e-7)).toBe(true);
  });
});

test("accepts the CLI's winners removed from the projection because a parent was deleted", async () => {
  const { t, owner, applyArgs } = await backend();
  const fixture = legacyImportMalformedCandidateFixture;
  const run = await owner.mutation(anyApi.imports.apply, { ...applyArgs, ...fixture });
  expect(run.errors).toEqual(expect.arrayContaining([{ code: "unresolved_parent", message: "3" }]));
  const decision = JSON.parse(fixture.report).divergences.find((item: { legacyId: string }) => item.legacyId === "lost");
  const mappings = await t.run(({ db }) => db.query("importMappings").collect());
  expect(mappings).toEqual(expect.arrayContaining([
    expect.objectContaining({ legacyId: "doomed", state: "deleted" }),
    expect.objectContaining({ legacyId: "lost", state: "quarantined", candidates: expect.arrayContaining([
      expect.objectContaining({ payloadHash: decision.winnerSha256, sourceUpdatedAt: 3 }),
    ]) }),
    expect.objectContaining({ legacyId: "stable", state: "quarantined" }),
    expect.objectContaining({ legacyId: "lost-step", state: "quarantined" }),
  ]));
});

test("keeps a destination size hold for a structurally valid projected row", async () => {
  const { t, owner, applyArgs } = await backend();
  const archive = await withArtifact(legacyImportFixture, "projection", projection => {
    projection.records.captures[0].tags = Array.from({ length: 501 }, (_, index) => `tag-${index}`);
  });
  const run = await owner.mutation(anyApi.imports.apply, { ...applyArgs, ...archive });
  expect(run).toMatchObject({
    state: "needs_reconciliation",
    errors: expect.arrayContaining([{ code: "invalid_projected_row", message: "1" }]),
  });
  expect(await t.run(({ db }) => db.query("captures").collect())).toEqual([]);
});

test("rolls back domain rows and ledger after a forced failure and can retry the identical operation", async () => {
  const { t, owner, applyArgs } = await backend();
  transaction.failAfterWrites = true;
  try {
    await expect(owner.mutation(anyApi.imports.apply, applyArgs)).rejects.toThrow(/forced failure/);
  } finally {
    transaction.failAfterWrites = false;
  }
  await t.run(async ({ db }) => {
    for (const table of ["lanes", "tasks", "taskSteps", "reminders", "captures", "dayNotes", "importMappings", "importRuns"] as const) {
      expect(await db.query(table).collect()).toEqual([]);
    }
    expect(await db.query("operationReceipts").collect()).toHaveLength(1);
    expect(await db.query("activityEvents").collect()).toHaveLength(1);
  });
  await expect(owner.mutation(anyApi.imports.apply, applyArgs)).resolves.toMatchObject({ checkpoint: { phase: "complete" } });
});
