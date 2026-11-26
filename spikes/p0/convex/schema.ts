import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const disposableFixtureRetirement = v.object({
  ownersRetired: v.number(),
  sessionsRevoked: v.number(),
  tasksDeleted: v.number(),
  usernamesDeleted: v.number(),
  usersDeleted: v.number(),
  passwordRowsRetained: v.number(),
  authUserIdRowsRetained: v.number(),
});

export default defineSchema({
  users: defineTable({}),
  fixtureEnrollments: defineTable({}),
  disposableFixtureRuns: defineTable({
    runId: v.string(),
    owners: v.array(v.object({ owner: v.id("users"), username: v.string() })),
    retirement: v.optional(disposableFixtureRetirement),
  }).index("by_run", ["runId"]),
  tasks: defineTable({
    owner: v.id("users"),
    title: v.string(),
  }).index("by_owner", ["owner"]),
});
