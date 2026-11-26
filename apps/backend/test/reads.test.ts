import { expect, test } from "vitest";
import { listTasks, taskByPublicId, type TaskFilter } from "../convex/model/reads";
import { insertProject, insertWorkspace, taskRecord, testBackend } from "./fixtures";

async function readPages(
  t: ReturnType<typeof testBackend>,
  workspaceId: Parameters<typeof listTasks>[1],
  filter: TaskFilter,
) {
  let cursor: string | null = null;
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const previousCursor: string | null = cursor;
    const result = await t.query(({ db }): ReturnType<typeof listTasks> =>
      listTasks(db, workspaceId, filter, { numItems: 1, cursor: previousCursor }));
    expect(result.page.length).toBeLessThanOrEqual(1);
    ids.push(...result.page.map((task) => task.publicId));
    if (result.isDone) return ids;
    expect(result.page).toHaveLength(1);
    expect(result.continueCursor).not.toBe(previousCursor);
    cursor = result.continueCursor;
  }
  throw new Error("Pagination did not reach the end of the fixture");
}

test("looks up the same public ID independently in each workspace and retains it after an update", async () => {
  const t = testBackend();
  const { alpha, beta, first, second } = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    const first = await db.insert("tasks", taskRecord(alpha, "shared-id"));
    const second = await db.insert("tasks", taskRecord(beta, "shared-id"));
    await db.insert("tasks", taskRecord(beta, "beta-only"));
    return { alpha, beta, first, second };
  });

  const lookup = (workspaceId: typeof alpha, publicId: string) =>
    t.query(({ db }) => taskByPublicId(db, workspaceId, publicId));

  expect(await lookup(alpha, "shared-id")).toMatchObject({ _id: first, workspaceId: alpha, publicId: "shared-id" });
  expect(await lookup(beta, "shared-id")).toMatchObject({ _id: second, workspaceId: beta, publicId: "shared-id" });
  expect(await lookup(alpha, "beta-only")).toBeNull();

  await t.run(({ db }) => db.patch(first, { title: "Renamed", updatedAt: 2, revision: 2 }));
  expect(await lookup(alpha, "shared-id")).toMatchObject({
    _id: first,
    publicId: "shared-id",
    title: "Renamed",
    revision: 2,
  });
});

test("detects duplicate task public IDs within a workspace", async () => {
  const t = testBackend();
  const workspaceId = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, "alpha");
    await db.insert("tasks", taskRecord(workspaceId, "duplicate"));
    await db.insert("tasks", taskRecord(workspaceId, "duplicate"));
    return workspaceId;
  });

  await expect(t.query(({ db }) => taskByPublicId(db, workspaceId, "duplicate")))
    .rejects.toThrow(/more than one/i);
});

test("paginates tied statuses within one workspace", async () => {
  const t = testBackend();
  const alpha = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    await db.insert("tasks", taskRecord(alpha, "ready-z"));
    await db.insert("tasks", taskRecord(beta, "foreign-ready"));
    await db.insert("tasks", taskRecord(alpha, "completed", { status: "done" }));
    await db.insert("tasks", taskRecord(alpha, "ready-a"));
    return alpha;
  });

  const ready = await readPages(t, alpha, { kind: "status", status: "ready" });
  expect(ready.toSorted()).toEqual(["ready-a", "ready-z"]);
  expect(await readPages(t, alpha, { kind: "status", status: "done" })).toEqual(["completed"]);
  expect(await readPages(t, alpha, { kind: "status", status: "in_progress" })).toEqual([]);
});

test("applies independent half-open ranges to planned dates, deadline dates, and deadline instants", async () => {
  const t = testBackend();
  const from = "2026-11-25";
  const until = "2026-11-27";
  const instantFrom = Date.UTC(2026, 10, 25);
  const instantUntil = Date.UTC(2026, 10, 27);

  const alpha = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");

    await db.insert("tasks", taskRecord(alpha, "planned-start", {
      plannedDate: from,
      deadline: { kind: "date", date: until },
    }));
    await db.insert("tasks", taskRecord(alpha, "planned-tie", {
      plannedDate: from,
      deadline: { kind: "instant", at: instantUntil },
    }));
    await db.insert("tasks", taskRecord(alpha, "deadline-date-start", {
      plannedDate: until,
      deadline: { kind: "date", date: from },
    }));
    await db.insert("tasks", taskRecord(alpha, "deadline-date-tie", {
      deadline: { kind: "date", date: from },
    }));
    await db.insert("tasks", taskRecord(alpha, "deadline-instant-start", {
      plannedDate: "2026-11-24",
      deadline: { kind: "instant", at: instantFrom, timezone: "America/Chicago" },
    }));
    await db.insert("tasks", taskRecord(alpha, "deadline-instant-tie", {
      deadline: { kind: "instant", at: instantFrom },
    }));
    await db.insert("tasks", taskRecord(alpha, "inside", {
      plannedDate: "2026-11-26",
      deadline: { kind: "date", date: "2026-11-26" },
    }));
    await db.insert("tasks", taskRecord(alpha, "last-instant", {
      deadline: { kind: "instant", at: instantUntil - 1 },
    }));
    await db.insert("tasks", taskRecord(alpha, "date-before", {
      deadline: { kind: "date", date: "2026-11-24" },
    }));
    await db.insert("tasks", taskRecord(alpha, "instant-before", {
      deadline: { kind: "instant", at: instantFrom - 1 },
    }));
    await db.insert("tasks", taskRecord(alpha, "undated"));
    await db.insert("tasks", taskRecord(beta, "foreign-planned-and-date", {
      plannedDate: from,
      deadline: { kind: "date", date: from },
    }));
    await db.insert("tasks", taskRecord(beta, "foreign-instant", {
      deadline: { kind: "instant", at: instantFrom },
    }));
    return alpha;
  });

  const planned = await readPages(t, alpha, { kind: "planned", from, until });
  expect(planned.slice(0, 2).toSorted()).toEqual(["planned-start", "planned-tie"]);
  expect(planned.slice(2)).toEqual(["inside"]);

  const localDeadlines = await readPages(t, alpha, { kind: "deadlineDate", from, until });
  expect(localDeadlines.slice(0, 2).toSorted()).toEqual(["deadline-date-start", "deadline-date-tie"]);
  expect(localDeadlines.slice(2)).toEqual(["inside"]);

  const instantDeadlines = await readPages(t, alpha, {
    kind: "deadlineInstant",
    from: instantFrom,
    until: instantUntil,
  });
  expect(instantDeadlines.slice(0, 2).toSorted()).toEqual(["deadline-instant-start", "deadline-instant-tie"]);
  expect(instantDeadlines.slice(2)).toEqual(["last-instant"]);
});

test("paginates tasks by rank within the selected workspace and project", async () => {
  const t = testBackend();
  const { alpha, beta, project } = await t.run(async ({ db }) => {
    const alpha = await insertWorkspace(db, "alpha");
    const beta = await insertWorkspace(db, "beta");
    const project = await insertProject(db, alpha, "shared-project");
    const anotherProject = await insertProject(db, alpha, "another-project");
    const betaProject = await insertProject(db, beta, "shared-project");
    await db.insert("tasks", taskRecord(alpha, "last", { projectId: project, rank: 20 }));
    await db.insert("tasks", taskRecord(alpha, "tied-z", { projectId: project, rank: 10 }));
    await db.insert("tasks", taskRecord(alpha, "unassigned", { rank: 0 }));
    await db.insert("tasks", taskRecord(alpha, "another-project-task", { projectId: anotherProject, rank: 0 }));
    await db.insert("tasks", taskRecord(beta, "another-workspace-task", { projectId: betaProject, rank: 0 }));
    await db.insert("tasks", taskRecord(alpha, "tied-a", { projectId: project, rank: 10 }));
    await db.insert("tasks", taskRecord(alpha, "first", { projectId: project, rank: 5.25 }));
    return { alpha, beta, project };
  });

  const filter = { kind: "project", projectId: project } as const;
  expect(await readPages(t, alpha, filter)).toEqual(["first", "tied-z", "tied-a", "last"]);
  expect(await readPages(t, beta, filter)).toEqual([]);
});

test.each([0, 1.5, 51])("rejects invalid task page size %s", async (numItems) => {
  const t = testBackend();
  const workspaceId = await t.run(({ db }) => insertWorkspace(db, "alpha"));
  await expect(t.query(({ db }) => listTasks(db, workspaceId, { kind: "status", status: "ready" }, {
    numItems,
    cursor: null,
  }))).rejects.toThrow(/between 1 and 50/);
});

test("reads a full 50-item page and honors a previously returned end cursor", async () => {
  const t = testBackend();
  const workspace = await t.run(async ({ db }) => {
    const workspace = await insertWorkspace(db, "pagination");
    for (let i = 0; i < 51; i++) {
      await db.insert("tasks", taskRecord(workspace, String(i)));
    }
    return workspace;
  });
  const read = (cursor: string | null, numItems: number, endCursor?: string) =>
    t.query(({ db }) => listTasks(db, workspace, { kind: "status", status: "ready" },
      { cursor, numItems, endCursor }));

  const first = await read(null, 50);
  expect(first.page).toHaveLength(50);
  expect(first.pageStatus).not.toBe("SplitRequired");
  const last = await read(first.continueCursor, 50);
  expect(last.isDone).toBe(true);
  expect(new Set([...first.page, ...last.page].map(task => task._id)).size).toBe(51);

  const prefix = await read(null, 8);
  const bounded = await read(null, 50, prefix.continueCursor);
  expect(bounded.page.map(task => task._id)).toEqual(prefix.page.map(task => task._id));
});

test.each<TaskFilter>([
  { kind: "planned", from: "2026-02-30", until: "2026-03-03" },
  { kind: "deadlineDate", from: "2026-03-01", until: "2026-03-01" },
  { kind: "deadlineInstant", from: 2, until: 1 },
])("rejects an invalid $kind range", async (filter) => {
  const t = testBackend();
  const workspaceId = await t.run(({ db }) => insertWorkspace(db, "alpha"));
  await expect(t.query(({ db }) => listTasks(db, workspaceId, filter, { numItems: 1, cursor: null })))
    .rejects.toThrow(/increasing pair/);
});
