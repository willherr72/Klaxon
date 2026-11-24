import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({}),
  tasks: defineTable({
    owner: v.id("users"),
    title: v.string(),
  }).index("by_owner", ["owner"]),
});
