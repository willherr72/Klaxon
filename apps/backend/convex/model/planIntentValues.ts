import { v } from "convex/values";

export const nullablePlanRevision = v.union(v.number(), v.null());
export const carryForwardIntentFields = {
  taskPublicId: v.string(),
  expectedRevision: v.number(),
  fromDate: v.string(),
  toDate: v.string(),
  expectedSourceDayPlanRevision: nullablePlanRevision,
  expectedTargetDayPlanRevision: nullablePlanRevision,
};
export const carryForwardIntent = v.object(carryForwardIntentFields);
export const reviewedCarryForward = v.object({ ...carryForwardIntentFields, taskTitle: v.string() });
