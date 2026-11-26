import { expect, test } from "vitest";
import { insertWorkspace, taskRecord, testBackend } from "./fixtures";

test.each([
  ["missing revision", { revision: undefined }],
  ["unknown status", { status: "finished" }],
  ["unknown priority", { priority: "critical" }],
  ["string rank", { rank: "10" }],
  ["numeric planned date", { plannedDate: 20261125 }],
  ["instant deadline with a local date", { deadline: { kind: "instant", date: "2026-11-25" } }],
  ["date deadline with an instant", { deadline: { kind: "date", at: 1 } }],
  ["unknown task property", { dueDate: "2026-11-25" }],
])("rejects a malformed task with %s", async (_, fields) => {
  const t = testBackend();
  const workspaceId = await t.run(({ db }) => insertWorkspace(db, "alpha"));
  const valid = taskRecord(workspaceId, "synthetic-task");

  // Submit malformed data at runtime to exercise the production validators.
  await expect(t.run(({ db }) => db.insert("tasks", { ...valid, ...fields } as typeof valid)))
    .rejects.toThrow(/Validator error/);
  expect(await t.run(({ db }) => db.query("tasks").collect())).toEqual([]);
});

test("rejects a workspace ID in the project reference", async () => {
  const t = testBackend();
  const workspaceId = await t.run(({ db }) => insertWorkspace(db, "alpha"));
  const valid = taskRecord(workspaceId, "synthetic-task");
  const invalid = { ...valid, projectId: workspaceId } as unknown as typeof valid;

  await expect(t.run(({ db }) => db.insert("tasks", invalid)))
    .rejects.toThrow(/Expected ID for table "projects"/);
});
