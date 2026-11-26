"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { deliveryConfiguration } from "./model/deliverySecrets";
import { claimRef, finishRef } from "./model/deliveryStore";
import { sendWebPush } from "./model/deliveryTransport";

export const send = internalAction({
  args: { attemptId: v.id("deliveryAttempts") },
  handler: async (ctx, { attemptId }) => {
    const claim = await ctx.runMutation(claimRef, { attemptId });
    if (!claim) return;
    const config = deliveryConfiguration();
    const outcome = config ? await sendWebPush(claim.subscription, config.vapid, claim.payload, claim.expiresAt, Date.now(), fetch)
      : { kind: "failed", code: "delivery_disabled" } as const;
    await ctx.runMutation(finishRef, { attemptId, outcome });
  },
});
