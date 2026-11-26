import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { agentAuthArgs, authorizeAgent } from "./model/agentCredentials";
import { createAgentReminderArgs, portableReminderReceipt, snoozeAgentReminderArgs, updateAgentReminderArgs } from "./model/agentReminders";
import { checkedReason } from "./model/agentTasks";
import { acknowledgeReminder, createReminder, updateReminder } from "./model/reminderWrites";

const authArgs = { ...agentAuthArgs, workspacePublicId: v.string(), origin: v.optional(v.literal("mcp")) };

async function reminderPrincipal(ctx: MutationCtx, auth: Parameters<typeof authorizeAgent>[1],
  origin: "mcp" | undefined, reason: string) {
  const { workspace, actor } = await authorizeAgent(ctx.db, auth, "reminders:write");
  return { workspace, actor, origin: origin ?? ("api" as const), agentReason: checkedReason(reason) };
}

export const create = internalMutation({
  args: { ...authArgs, ...createAgentReminderArgs.fields },
  handler: async (ctx, { origin, reason, publicId, operationId, reminder, ...auth }) => {
    const principal = await reminderPrincipal(ctx, auth, origin, reason);
    return portableReminderReceipt(ctx.db, await createReminder(ctx, principal, operationId, reminder, publicId));
  },
});

export const update = internalMutation({
  args: { ...authArgs, ...updateAgentReminderArgs.fields },
  handler: async (ctx, { origin, reason, publicId, operationId, expectedRevision, patch, ...auth }) => {
    const principal = await reminderPrincipal(ctx, auth, origin, reason);
    return portableReminderReceipt(ctx.db, await updateReminder(ctx, principal, { publicId, operationId, expectedRevision }, patch));
  },
});

export const snooze = internalMutation({
  args: { ...authArgs, ...snoozeAgentReminderArgs.fields },
  handler: async (ctx, { origin, reason, publicId, operationId, expectedRevision, occurrencePublicId, snoozeUntil, ...auth }) => {
    const principal = await reminderPrincipal(ctx, auth, origin, reason);
    return portableReminderReceipt(ctx.db, await acknowledgeReminder(ctx, principal,
      { publicId, operationId, expectedRevision, occurrencePublicId }, { kind: "snooze", snoozeUntil }));
  },
});
