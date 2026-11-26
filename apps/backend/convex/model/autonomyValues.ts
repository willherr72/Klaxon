import { v } from "convex/values";
import { weekday } from "./values";

const planApplication = v.union(v.literal("review"), v.literal("automatic"));
const schedule = v.array(v.object({ weekday, startMinute: v.number(), endMinute: v.number() }));
const scope = v.union(
  v.object({ kind: v.literal("all") }),
  v.object({ kind: v.literal("work") }),
  v.object({ kind: v.literal("personal") }),
  v.object({ kind: v.literal("projects"), projectPublicIds: v.array(v.string()) }),
);
const ids = v.array(v.string());

export const autonomyPolicy = v.object({
  planApplication, schedule, scope, excludedTaskPublicIds: ids, excludedProjectPublicIds: ids,
});

export const storedAutonomyPolicy = v.object({
  planApplication,
  lockManuallyMovedBlocks: v.boolean(),
  discretionaryMinutes: v.optional(v.number()),
  schedule: v.optional(schedule),
  scope: v.optional(scope),
  excludedTaskPublicIds: v.optional(ids),
  excludedProjectPublicIds: v.optional(ids),
});
