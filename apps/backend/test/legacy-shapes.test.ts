import { expect, test } from "vitest";
import { insertWorkspace, taskRecord, testBackend } from "./fixtures";

test("preserves legacy ordering, a snoozed month-end reminder and an empty local-date note", async () => {
  const backend = testBackend();
  const { workspaceId, taskId } = await backend.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, "migration");
    const version = { workspaceId, createdAt: 1, updatedAt: 2, revision: 1 };
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "task", {
      rank: 1.5, status: "done", source: { kind: "legacy", source: "local" },
    }));
    for (const publicId of ["step-b", "step-a"]) {
      await db.insert("taskSteps", { ...version, taskId, publicId, title: publicId, completed: true, rank: 7 });
    }
    await db.insert("reminders", {
      ...version, publicId: "reminder", title: "Synthetic reminder", priority: "normal", state: "snoozed",
      timezone: "UTC", dueAt: 1000, snoozeUntil: 2000, nextTriggerAt: 2000,
      recurrence: { kind: "monthly", day: 31 }, recurrenceBasis: "legacy_utc",
    });
    await db.insert("dayNotes", { ...version, publicId: "note", localDate: "2024-02-29", body: "" });
    return { workspaceId, taskId };
  });

  await backend.run(async ({ db }) => {
    const task = await db.get("tasks", taskId);
    expect(task?.rank).toBe(1.5);
    expect(task?.status).toBe("done");
    expect(task?.completedAt).toBeUndefined();
    const steps = await db.query("taskSteps").withIndex("by_workspace_task_rank", q =>
      q.eq("workspaceId", workspaceId).eq("taskId", taskId)
    ).take(3);
    expect(steps.map(step => step.publicId)).toEqual(["step-a", "step-b"]);
    const reminder = await db.query("reminders").withIndex("by_workspace_state_trigger", q =>
      q.eq("workspaceId", workspaceId).eq("state", "snoozed").eq("nextTriggerAt", 2000)
    ).unique();
    expect(reminder).toMatchObject({ dueAt: 1000, snoozeUntil: 2000, recurrenceBasis: "legacy_utc",
      recurrence: { kind: "monthly", day: 31 } });
    const note = await db.query("dayNotes").withIndex("by_workspace_local_date", q =>
      q.eq("workspaceId", workspaceId).eq("localDate", "2024-02-29")
    ).unique();
    expect(note?.body).toBe("");
  });
});
