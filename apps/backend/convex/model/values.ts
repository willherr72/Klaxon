import { v } from "convex/values";

// Shared storage conventions. Domain functions validate dates, IANA zones,
// finite ranks, integer timestamps/revisions and payload limits before writing.
export const localDate = v.string(); // YYYY-MM-DD
export const timezone = v.string();
export const instant = v.number(); // UTC epoch milliseconds
export const workspaceId = v.id("workspaces");

export const recordFields = {
  publicId: v.string(),
  createdAt: instant,
};

export const mutableFields = {
  ...recordFields,
  updatedAt: instant,
  revision: v.number(),
};

export const workspaceRecordFields = { workspaceId, ...recordFields };
export const workspaceMutableFields = { workspaceId, ...mutableFields };

export const unarchivedTaskStatus = v.union(
  v.literal("inbox"),
  v.literal("ready"),
  v.literal("in_progress"),
  v.literal("waiting"),
  v.literal("done"),
);
export const taskStatus = v.union(unarchivedTaskStatus, v.literal("archived"));

export const priority = v.union(
  v.literal("none"),
  v.literal("low"),
  v.literal("normal"),
  v.literal("high"),
  v.literal("urgent"),
);

export const deadline = v.union(
  v.object({ kind: v.literal("date"), date: localDate }),
  v.object({ kind: v.literal("instant"), at: instant, timezone: v.optional(timezone) }),
);

export const weekday = v.union(
  v.literal(0),
  v.literal(1),
  v.literal(2),
  v.literal(3),
  v.literal(4),
  v.literal(5),
  v.literal(6),
); // Monday = 0

export const provider = v.union(
  v.literal("linear"),
  v.literal("outlook"),
  v.literal("github"),
  v.literal("obsidian"),
  v.literal("t3"),
);

export const source = v.union(
  v.object({ kind: v.literal("manual") }),
  v.object({ kind: v.literal("capture"), captureId: v.id("captures") }),
  v.object({ kind: v.literal("integration"), connectionId: v.id("integrationConnections") }),
  v.object({ kind: v.literal("agent"), credentialId: v.id("agentCredentials") }),
  v.object({
    kind: v.literal("legacy"),
    // Preserve attribution without claiming a verified integration relationship.
    source: v.string(),
    externalId: v.optional(v.string()),
  }),
);

export const actor = v.union(
  v.object({ kind: v.literal("user"), userId: v.id("users") }),
  v.object({ kind: v.literal("agent"), credentialId: v.id("agentCredentials") }),
  v.object({ kind: v.literal("integration"), connectionId: v.id("integrationConnections") }),
  v.object({ kind: v.literal("system"), job: v.string() }),
);

export const notificationChannel = v.union(v.literal("web_push"), v.literal("native"));

export const diagnostic = v.object({
  code: v.string(),
  message: v.optional(v.string()),
});
