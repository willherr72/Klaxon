import { expect, test } from "vitest";
import { getAgentPlanningContext } from "../convex/model/agentPlanningContext";
import { insertWorkspace, recordVersion, taskRecord, testBackend } from "./fixtures";

const date = "2026-11-01";
const timezone = "America/Chicago";
const startAt = Date.parse("2026-11-01T05:00:00Z");
const endAt = Date.parse("2026-11-02T06:00:00Z");

async function fixture() {
  const t = testBackend();
  const grant = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, "context-workspace");
    const workspace = (await db.get("workspaces", workspaceId))!;
    return { workspaceId, workspace, userId: workspace.ownerId };
  });
  const read = (input = { date, timezone }) => t.query(({ db }) => getAgentPlanningContext(db, grant, input));
  return { t, grant, read };
}

test("uses DST-aware day bounds and reveals only caller events under their metadata policy", async () => {
  const { t, grant, read } = await fixture();
  await t.run(async ({ db }) => {
    const { workspaceId, userId } = grant;
    const colleague = await db.insert("users", {});
    const connection = (owner: typeof userId, publicId: string, metadataPolicy: "minimal" | "busy_only") =>
      db.insert("integrationConnections", { workspaceId, userId: owner, publicId, accountId: "hidden-account",
        state: "active", provider: "outlook", scopeIds: [], metadataPolicy, ...recordVersion });
    const event = (connectionId: Awaited<ReturnType<typeof connection>>, publicId: string) =>
      db.insert("calendarEvents", { workspaceId, connectionId, publicId, externalEventId: "hidden-source",
        provider: "outlook", startAt: startAt - 3600_000, endAt: startAt + 3600_000, timezone, localDate: "2026-10-31",
        allDay: false, availability: "busy", title: "Hidden title", lastSeenAt: startAt - 1, ...recordVersion });
    await db.insert("dayPlans", { workspaceId, publicId: "day", localDate: date, timezone,
      source: "manual", focusTaskIds: [], ...recordVersion });
    await db.insert("timeBlocks", { workspaceId, publicId: "booking", title: "Review", timezone, localDate: date,
      origin: "manual", startAt, endAt: startAt + 900_000, locked: true, ...recordVersion });
    await event(await connection(userId, "busy-calendar", "busy_only"), "busy-window");
    await event(await connection(colleague, "private-calendar", "minimal"), "private-window");
  });

  const view = await read();
  expect(view).toMatchObject({ date, timezone, startAt, endAt, workspacePublicId: "context-workspace" });
  expect(view.meetings).toMatchObject({ partial: false, items: [{ publicId: "busy-window", availability: "busy", revision: 1 }] });
  // Honolulu's day starts after the Chicago conflict.
  const shifted = await read({ date, timezone: "Pacific/Honolulu" });
  expect(shifted.meetings.items).toHaveLength(0);
  expect(shifted.dayPlan?.needsReplan).toBe(true);
  const json = JSON.stringify(view);
  for (const hidden of ["private-window", "Hidden title", "hidden-account", "hidden-source", "connectionId", "workspaceId"]) {
    expect(json).not.toContain(hidden);
  }
});

test("includes portable revisions, ordering and partial flags for tasks, steps and locked blocks", async () => {
  const { t, grant, read } = await fixture();
  const { workspaceId } = grant;
  await t.run(async ({ db }) => {
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "deadline", { deadline: { kind: "date", date },
      revision: 4, description: "private-context-detail", priority: "high" }));
    for (let index = 10; index >= 0; index--) {
      await db.insert("taskSteps", { workspaceId, taskId, title: `Step ${index}`, publicId: `step-${index}`,
        rank: index, completed: index === 0, ...recordVersion });
    }
    for (let index = 0; index < 30; index++) await db.insert("tasks", taskRecord(workspaceId, `queue-${index}`));
    const planId = await db.insert("dayPlans", { workspaceId, publicId: "day", localDate: date, timezone,
      source: "manual", focusTaskIds: [taskId], briefing: "hidden-briefing", ...recordVersion, revision: 2 });
    await db.insert("timeBlocks", { workspaceId, publicId: "locked-block", taskId, planId, timezone, localDate: date,
      origin: "manual", startAt, endAt: startAt + 900_000, locked: true, ...recordVersion });
    await db.insert("reminders", { workspaceId, taskId, publicId: "reminder", title: "Call vendor", priority: "normal",
      timezone, dueAt: startAt + 1000, nextTriggerAt: startAt + 1000, state: "pending", ...recordVersion });
  });

  const view = await read();
  expect(view.tasks.partial).toBe(true);
  expect(view.tasks.items[0]).toMatchObject({ publicId: "deadline", revision: 4, steps: { partial: true } });
  expect(view.tasks.items[0].steps.items.map(({ publicId }) => publicId)).toEqual(
    Array.from({ length: 8 }, (_, index) => `step-${index}`));
  expect(view.blocks.items).toMatchObject([{ taskPublicId: "deadline", publicId: "locked-block", locked: true,
    planOwned: true, revision: 1 }]);
  expect(view.reminders.items).toMatchObject([{ taskPublicId: "deadline", publicId: "reminder", nextTriggerAt: startAt + 1000 }]);
  expect(view.dayPlan).toMatchObject({ publicId: "day", revision: 2, focusTaskPublicIds: ["deadline"] });
  expect(JSON.stringify(view)).not.toMatch(/hidden-briefing|private-context-detail|"taskId"|"planId"/);
});
