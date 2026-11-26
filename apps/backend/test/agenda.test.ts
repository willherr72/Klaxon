import { anyApi } from "convex/server";
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import schema from "../convex/schema";
import { taskRecord } from "./fixtures";

vi.mock("@convex-dev/auth/server", () => ({
  getAuthUserId: async (ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } }) =>
    (await ctx.auth.getUserIdentity())?.subject ?? null,
}));

test("Today separates planned work, overdue deadlines, waiting follow-ups and unscheduled work", async () => {
  const t = convexTest({ schema, modules: {
    "../convex/_generated/server.ts": () => import("../convex/_generated/server"),
    "../convex/agenda.ts": () => import("../convex/agenda"),
    "../convex/workspaces.ts": () => import("../convex/workspaces"),
  } });
  const [a, b] = await t.run(async ({ db }) => [await db.insert("users", {}), await db.insert("users", {})]);
  const owner = t.withIdentity({ subject: a });
  const outsider = t.withIdentity({ subject: b });
  const { _id: workspaceId } = await owner.mutation(anyApi.workspaces.ensurePersonal, {});
  const localDate = "2026-11-01";
  const asOf = Date.parse("2026-11-01T07:30:00Z");
  const args = { workspaceId, localDate, timezone: "America/Chicago", asOf };
  await t.run(async ({ db }) => {
    for (const [id, fields] of [
      ["planned", { plannedDate: localDate, priority: "high", deadline: { kind: "date", date: "2026-11-04" } }],
      ["yesterday", { deadline: { kind: "date", date: "2026-10-31" } }],
      ["earlier", { deadline: { kind: "instant", at: asOf - 1 } }],
      ["due-today", { deadline: { kind: "date", date: localDate } }],
      ["later", { deadline: { kind: "instant", at: Date.parse("2026-11-02T05:30:00Z") } }],
      ["waiting", { status: "waiting", followUpDate: localDate, waitingPerson: "Vendor" }],
      ["done", { status: "done", plannedDate: localDate, deadline: { kind: "date", date: "2026-10-31" } }],
      ["backlog", {}],
    ] as const) await db.insert("tasks", taskRecord(workspaceId, id, fields));
  });
  await expect(outsider.query(anyApi.agenda.today, args)).rejects.toThrow(/WORKSPACE_UNAVAILABLE/);
  const today = await owner.query(anyApi.agenda.today, args);
  const ids = (group: { items: { publicId: string }[] }) => group.items.map(row => row.publicId).sort();
  expect(ids(today.planned)).toEqual(["planned"]);
  expect(ids(today.overdue)).toEqual(["earlier", "yesterday"]);
  expect(ids(today.dueToday)).toEqual(["due-today", "later"]);
  expect(ids(today.followUps)).toEqual(["waiting"]);
  expect(ids(today.unplanned)).toContain("backlog");
  expect(today.planned.partial).toBe(false);
  expect(today.planned.items[0].deadline).toEqual({ kind: "date", date: "2026-11-04" });
  expect(today.planned.items[0]).not.toHaveProperty("description");
  const upcoming = await owner.query(anyApi.agenda.upcoming, { workspaceId, from: "2026-11-02", timezone: args.timezone });
  expect(upcoming.items.map((item: { kind: string; publicId: string; date: string }) =>
    [item.kind, item.publicId, item.date])).toEqual([["deadline", "planned", "2026-11-04"]]);
});
