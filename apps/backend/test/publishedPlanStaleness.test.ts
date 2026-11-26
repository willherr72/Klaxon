import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { addLocalDays, localWeekday } from "../convex/model/calendarTime";
import schema from "../convex/schema";
import { insertWorkspace, recordVersion, taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

async function fixture() {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agenda.ts": () => import("../convex/agenda"),
    "../convex/agentPlanningContext.ts": () => import("../convex/agentPlanningContext"),
    "../convex/planning.ts": () => import("../convex/planning"),
    "../convex/tasks.ts": () => import("../convex/tasks"),
  } });
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = addLocalDays(today, 1);
  const date = localWeekday(tomorrow) < 5 ? tomorrow : addLocalDays(tomorrow, 7 - localWeekday(tomorrow));
  const secondDate = addLocalDays(date, 1);
  const unrelatedDate = addLocalDays(secondDate, 1);
  const tokenHash = "a".repeat(64);
  const workspacePublicId = "published";
  const { userId, workspaceId } = await t.run(async ({ db }) => {
    const workspaceId = await insertWorkspace(db, workspacePublicId);
    const { ownerId: userId } = (await db.get("workspaces", workspaceId))!;
    await db.insert("memberships", { workspaceId, userId, publicId: "owner", role: "owner", ...recordVersion });
    await db.insert("agentCredentials", { workspaceId, userId, publicId: "agent", label: "Planner",
      scopes: ["planning:read"], tokenHash, expiresAt: Date.now() + 600_000, ...recordVersion });
    const taskId = await db.insert("tasks", taskRecord(workspaceId, "changed", { plannedDate: date, estimateMinutes: 30 }));
    await db.insert("tasks", taskRecord(workspaceId, "unestimated"));
    await db.insert("tasks", taskRecord(workspaceId, "unrelated", { estimateMinutes: 20 }));
    for (const localDate of [date, secondDate, unrelatedDate]) {
      await db.insert("dayPlans", { workspaceId, publicId: localDate, localDate, timezone: "UTC", source: "agent",
        publishedAt: Date.now(), focusTaskIds: [], ...recordVersion });
    }
    await db.insert("timeBlocks", { workspaceId, publicId: "lock", taskId, localDate: secondDate, timezone: "UTC",
      startAt: Date.parse(secondDate + "T09:00:00Z"), endAt: Date.parse(secondDate + "T10:00:00Z"),
      locked: true, origin: "manual", ...recordVersion });
    return { userId, workspaceId };
  });
  const owner = t.withIdentity({ subject: userId });
  const update = (patch: object, expectedRevision = 1) => owner.mutation(anyApi.tasks.apply, {
    workspaceId, operationId: crypto.randomUUID(),
    command: { kind: "task.update", publicId: "changed", expectedRevision, patch },
  });
  const create = (publicId: string, task: object) => owner.mutation(anyApi.tasks.apply, {
    workspaceId, operationId: crypto.randomUUID(), command: { kind: "task.create", publicId, title: publicId, ...task },
  });
  const read = (localDate: string) => owner.query(anyApi.agenda.today, {
    workspaceId, localDate, timezone: "UTC", asOf: Date.parse(localDate + "T12:00:00Z"),
  });
  const context = (localDate: string) => t.query(anyApi.agentPlanningContext.get, {
    workspacePublicId, tokenHash, date: localDate, timezone: "UTC",
  });
  async function apply(localDate: string, taskPublicIds: string[], expectedDayPlanRevision: number) {
    const preview = await owner.mutation(anyApi.planning.preview, {
      workspaceId, localDate, taskPublicIds, expectedDayPlanRevision, operationId: crypto.randomUUID(),
    });
    return owner.mutation(anyApi.planning.apply, { workspaceId, publicId: preview.publicId,
      expectedRevision: preview.revision, operationId: crypto.randomUUID() });
  }
  return { update, create, read, context, apply, date, secondDate, unrelatedDate };
}

test("a real task edit marks both the planned date and the published date of locked work for review", async () => {
  const f = await fixture();
  await f.update({ estimateMinutes: 45 });
  for (const date of [f.date, f.secondDate]) {
    expect((await f.read(date)).needsReplan).toBe(true);
    expect((await f.context(date)).dayPlan).toMatchObject({ needsReplan: true, revision: 2 });
  }
  expect((await f.read(f.unrelatedDate)).needsReplan).toBe(false);
});

test("no-op and unrelated previews preserve unresolved plan staleness", async () => {
  const f = await fixture();
  await f.update({ estimateMinutes: 45 });
  await f.apply(f.date, ["unestimated"], (await f.context(f.date)).dayPlan.revision);
  expect((await f.read(f.date)).needsReplan).toBe(true);
  await f.apply(f.date, ["unrelated"], (await f.context(f.date)).dayPlan.revision);
  expect((await f.context(f.date)).dayPlan.needsReplan).toBe(true);
  await f.apply(f.date, ["changed"], (await f.context(f.date)).dayPlan.revision);
  expect((await f.read(f.date)).needsReplan).toBe(false);
});

test("non-planning edits leave existing plans current and a move marks both planned dates", async () => {
  const f = await fixture();
  await f.update({ title: "Renamed" });
  expect((await f.read(f.date)).needsReplan).toBe(false);
  await f.update({ plannedDate: f.unrelatedDate }, 2);
  for (const date of [f.date, f.unrelatedDate]) {
    expect((await f.context(date)).dayPlan).toMatchObject({ needsReplan: true, revision: 2 });
  }
});

test("adding work with a due date invalidates that published day", async () => {
  const f = await fixture();
  await f.create("new-deadline", { deadline: { kind: "instant", at: Date.parse(f.unrelatedDate + "T12:00:00Z") } });
  expect((await f.read(f.unrelatedDate)).needsReplan).toBe(true);
  expect((await f.read(f.date)).needsReplan).toBe(false);
});
