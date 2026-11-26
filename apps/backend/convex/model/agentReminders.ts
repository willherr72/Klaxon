import { v } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import type { AgentEndpoint } from "./agentEndpoints";
import { portableReceipt } from "./agentTasks";
import type { OperationResult } from "./operations";
import { reminderInput, reminderPatch } from "./reminderWrites";

const write = { publicId: v.string(), operationId: v.string(), reason: v.string() };
const revise = { ...write, expectedRevision: v.number() };

export const createAgentReminderArgs = v.object({ ...write, reminder: reminderInput });
export const updateAgentReminderArgs = v.object({ ...revise, patch: reminderPatch });
export const snoozeAgentReminderArgs = v.object({ ...revise, occurrencePublicId: v.optional(v.string()), snoozeUntil: v.number() });

export const agentReminderEndpoints = [
  { name: "create_reminder", path: "reminders/create", handler: "agentReminders:create", kind: "mutation",
    scope: "reminders:write", schema: createAgentReminderArgs,
    description: "Create one reminder with a public ID and reason. Related tasks must belong to the selected workspace." },
  { name: "update_reminder", path: "reminders/update", handler: "agentReminders:update", kind: "mutation",
    scope: "reminders:write", schema: updateAgentReminderArgs,
    description: "Edit a reminder at its exact revision. Retry with the original arguments and operation ID." },
  { name: "snooze_reminder", path: "reminders/snooze", handler: "agentReminders:snooze", kind: "mutation",
    scope: "reminders:write", schema: snoozeAgentReminderArgs,
    description: "Snooze the current reminder at its exact revision to a later future instant. An occurrence public ID additionally checks the current occurrence." },
] as const satisfies readonly AgentEndpoint[];

export async function portableReminderReceipt(db: DatabaseReader, result: OperationResult) {
  if (!result.reminderSnapshot) throw new Error("Reminder operation snapshot missing");
  return { ...await portableReceipt(db, result), reminder: result.reminderSnapshot };
}
