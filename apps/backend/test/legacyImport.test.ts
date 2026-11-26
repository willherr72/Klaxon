import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { legacyImportDivergentFixture, legacyImportFixture } from "./legacyImportFixture";

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

async function withProjection(change: (input: ReturnType<typeof JSON.parse>) => void) {
  const manifest = JSON.parse(legacyImportFixture.manifest);
  const input = JSON.parse(legacyImportFixture.projection);
  change(input);
  const projection = JSON.stringify(input);
  manifest.artifacts["projection.json"] = await checksum(projection);
  return { ...legacyImportFixture, manifest: JSON.stringify(manifest), projection };
}

test("imports the CLI's synthetic projection and replays without duplicating destinations or mappings", async () => {
  const { t, owner, applyArgs, createArgs, workspaceId } = await backend();
  expect(await owner.mutation(anyApi.imports.createWorkspace, createArgs)).toMatchObject({ workspaceId });
  await expect(owner.mutation(anyApi.tasks.apply, {
    ...createArgs, command: { kind: "task.create", publicId: "same-operation", title: "Conflicting request" },
  })).rejects.toThrow(/OPERATION_ID_CONFLICT/);
  const run = await owner.mutation(anyApi.imports.apply, applyArgs);
  expect(run).toMatchObject({ archiveHash: await checksum(applyArgs.manifest), checkpoint: { phase: "complete", nextBatch: 1 } });
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

test("quarantines a conflicting identity and a missing relationship with persisted counts", async () => {
  const { t, owner, applyArgs } = await backend();
  const archive = await withProjection(input => {
    input.records.reminders[0].legacyId = input.records.tasks[0].legacyId;
  });
  const run = await owner.mutation(anyApi.imports.apply, { ...applyArgs, ...archive });
  expect(run.state).toBe("needs_reconciliation");
  expect(run.counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceTable: "reminders", divergent: 2 }),
    expect.objectContaining({ sourceTable: "task_steps", rejected: 2 }),
  ]));
  const mappings = await t.run(({ db }) => db.query("importMappings").collect());
  expect(mappings.filter(mapping => mapping.state === "divergent")).toHaveLength(1);
  expect(mappings.filter(mapping => mapping.state === "quarantined")).toHaveLength(2);
  await expect(owner.mutation(anyApi.imports.apply, { ...applyArgs, operationId: crypto.randomUUID() }))
    .rejects.toThrow(/LEGACY_IMPORT_ARCHIVE_CONFLICT/);
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
