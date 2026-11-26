import { ConvexError, v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { checkedBriefing } from "./agentLifecycle";
import { agentReason, portableAgentReceipt, requirePlanningOwner, type AgentGrant, type AgentOrigin } from "./agentOperations";
import { prepareLifecycle, scopeTasks, validateCarryIntents, writeLifecycle } from "./agentPlanLifecycle";
import { enforceAutonomy, ownerAutonomy } from "./autonomy";
import { calendarError } from "./calendarTime";
import { requireExpectedRevision, runOperation } from "./operations";
import { carryForwardIntent } from "./planIntentValues";
import { applyPreview, revisionByPublicId, savePreview, validatePlanSelection } from "./planPreview";
import { checkPublicId } from "./taskDomain";

export const previewAgentPlanArgs = v.object({
  localDate: v.string(), taskPublicIds: v.array(v.string()), expectedDayPlanRevision: v.union(v.number(), v.null()),
  operationId: v.string(), reason: v.string(),
  briefing: v.optional(v.string()), carryForwards: v.optional(v.array(carryForwardIntent)),
});
export const planDecisionFields = { publicId: v.string(), expectedRevision: v.number(), operationId: v.string() };
export const applyAgentPlanArgs = v.object({ ...planDecisionFields, reason: v.string() });

type Revision = Doc<"planRevisions">;

type AgentPreview = Revision & {
  actor: Extract<Revision["actor"], { kind: "agent" }>;
  agentSummary: NonNullable<Revision["agentSummary"]>;
  previewSummary: NonNullable<Revision["previewSummary"]>;
  expiresAt: number;
  reason: string;
};
function isAgentPreview(saved: Revision | null): saved is AgentPreview {
  return saved?.actor.kind === "agent" && saved.agentSummary !== undefined && saved.previewSummary !== undefined &&
    saved.expiresAt !== undefined && saved.reason !== undefined;
}

function portablePreview(saved: AgentPreview, revision: number) {
  const { publicId, localDate, timezone, expiresAt, baseDayPlanRevision, reason, previewSummary, agentSummary } = saved;
  const names = new Map(agentSummary.tasks.map(task => [task.taskPublicId, task]));
  const moves = new Map(agentSummary.moves.map(move => [move.blockPublicId, move]));
  function task(publicId: string) {
    const row = names.get(publicId);
    if (!row) throw new Error("Missing reviewed task");
    return row;
  }
  return { publicId, revision, localDate, timezone, expiresAt, baseDayPlanRevision, reason, agentLabel: agentSummary.agentLabel,
    placements: previewSummary.placements.map(item => ({
      ...item, ...task(item.taskPublicId),
      ...(item.blockPublicId === undefined ? {} : moves.get(item.blockPublicId)),
    })),
    unscheduled: previewSummary.unscheduled.map(item => ({ ...item, ...task(item.taskPublicId) })),
    focusTaskPublicIds: agentSummary.focusTaskPublicIds, focusTasks: agentSummary.focusTaskPublicIds.map(task),
    briefing: agentSummary.briefing, previousBriefing: agentSummary.previousBriefing, carryForwards: agentSummary.carryForwards ?? [],
  };
}

export async function createAgentPreview(db: DatabaseWriter, grant: AgentGrant,
  { localDate, taskPublicIds, expectedDayPlanRevision, reason, operationId,
    briefing: text, carryForwards = [] }: Infer<typeof previewAgentPlanArgs>,
  origin: AgentOrigin = "api") {
  requirePlanningOwner(grant);
  const { workspace, actor, credential } = grant;
  const checkedReason = agentReason(reason);
  const briefing = text === undefined ? undefined : checkedBriefing(text);
  const hasLifecycle = briefing !== undefined || carryForwards.length > 0;
  validatePlanSelection(taskPublicIds, expectedDayPlanRevision, hasLifecycle);
  validateCarryIntents(carryForwards, taskPublicIds, localDate);
  const workspaceId = workspace._id;
  const result = await runOperation(db, { workspace, actor, origin, action: "planning.preview", operationId,
    input: { localDate, taskPublicIds, expectedDayPlanRevision, reason: checkedReason, briefing,
      carryForwards: carryForwards.length ? carryForwards : undefined },
  }, async ({ db, now }) => {
    let lifecycle: Awaited<ReturnType<typeof prepareLifecycle>> | undefined;
    const change = await savePreview(db, { workspaceId, userId: workspace.ownerId, localDate, taskPublicIds,
      expectedDayPlanRevision, actor, now, reason: checkedReason,
      authorizeSelection: async tasks => {
        if (hasLifecycle) {
          const { timezone } = await ownerAutonomy(db, workspaceId);
          lifecycle = await prepareLifecycle(db, workspaceId, localDate, timezone, briefing, carryForwards, now);
        }
        await enforceAutonomy(db, workspaceId, scopeTasks(tasks, lifecycle), now, "preview");
      },
      agentSummary: (context, { changes }) => {
        const existingFocus = new Set(context.plan?.focusTaskIds);
        const publicIds = new Map(context.tasks.map(task => [task._id, task.publicId]));
        const blocks = new Map(context.blocks.map(block => [block._id, block]));
        const focusTaskPublicIds = changes.flatMap(change => change.kind === "set_focus"
          ? change.taskIds.filter(id => !existingFocus.has(id)).map(id => {
            const publicId = publicIds.get(id);
            if (!publicId) throw new Error("New focus task was not selected");
            return publicId;
          }) : []);
        const moves = changes.flatMap(change => {
          if (change.kind !== "move_block") return [];
          const block = blocks.get(change.blockId);
          if (!block) throw new Error("A proposed move is missing its source block");
          return [{ blockPublicId: block.publicId, previousStartAt: block.startAt, previousEndAt: block.endAt }];
        });
        return { agentLabel: credential.label, focusTaskPublicIds, moves, briefing,
          previousBriefing: lifecycle?.previousBriefing,
          carryForwards: lifecycle?.carries.map(({ task, intent }) => ({ ...intent, taskTitle: task.title })),
          tasks: context.tasks.map(task => ({ taskPublicId: task.publicId, taskTitle: task.title })) };
      },
    });
    return { ...change, agentReason: checkedReason };
  });
  const saved = await revisionByPublicId(db, workspaceId, result.targetPublicId);
  if (!isAgentPreview(saved)) throw new Error("Missing agent preview");
  return portablePreview(saved, result.revision);
}

function applyAgentProposal(db: DatabaseWriter, saved: AgentPreview, userId: Doc<"workspaces">["ownerId"],
  now: number, phase: "apply" | "review") {
  const { workspaceId, localDate, timezone, agentSummary } = saved;
  const { briefing, previousBriefing, carryForwards = [] } = agentSummary;
  const hasLifecycle = briefing !== undefined || carryForwards.length > 0;
  let lifecycle: Awaited<ReturnType<typeof prepareLifecycle>> | undefined;
  const scheduled = new Set<string>();
  return applyPreview(db, saved, userId, now, "agent", async tasks => {
    if (hasLifecycle) {
      lifecycle = await prepareLifecycle(db, workspaceId, localDate, timezone, briefing, carryForwards, now);
      if (lifecycle.previousBriefing !== previousBriefing) calendarError("PLAN_CONTEXT_CHANGED");
    }
    await enforceAutonomy(db, workspaceId, scopeTasks(tasks, lifecycle), now, phase);
    for (const task of tasks) scheduled.add(task.publicId);
  }, async () => {
    if (lifecycle) await writeLifecycle(db, workspaceId, localDate, timezone, lifecycle, scheduled, now);
  });
}

export async function applyAgentPreview(db: DatabaseWriter, grant: AgentGrant,
  { publicId, expectedRevision, operationId, reason }: Infer<typeof applyAgentPlanArgs>, origin: AgentOrigin = "api") {
  requirePlanningOwner(grant);
  const { workspace, actor } = grant;
  checkPublicId(publicId);
  const checkedReason = agentReason(reason);
  const result = await runOperation(db, { workspace, actor, origin, action: "planning.apply", operationId,
    targetPublicId: publicId, expectedRevision, input: { reason: checkedReason },
  }, async ({ db, now }) => {
    const saved = await revisionByPublicId(db, workspace._id, publicId);
    if (!isAgentPreview(saved) || saved.actor.credentialId !== actor.credentialId) calendarError("PLAN_UNAVAILABLE");
    requireExpectedRevision(expectedRevision, saved.revision);
    const change = await applyAgentProposal(db, saved, workspace.ownerId, now, "apply");
    return { ...change, agentReason: checkedReason };
  });
  return portableAgentReceipt(db, result);
}

export async function pendingAgentPlans(db: DatabaseReader, workspace: Doc<"workspaces">) {
  const { policy } = await ownerAutonomy(db, workspace._id);
  if (policy.planApplication !== "review") return [];
  const rows = await db.query("planRevisions").withIndex("by_workspace_actor_state_expiry", q =>
    q.eq("workspaceId", workspace._id).eq("actor.kind", "agent").eq("state", "preview").gt("expiresAt", Date.now()),
  ).take(20);
  return rows.filter(isAgentPreview).map(row => portablePreview(row, row.revision));
}

export async function decideAgentPlan(db: DatabaseWriter, workspace: Doc<"workspaces">,
  { publicId, expectedRevision, operationId }: { publicId: string; expectedRevision: number; operationId: string },
  decision: "approve" | "reject") {
  checkPublicId(publicId);
  const actor = { kind: "user" as const, userId: workspace.ownerId };
  const result = await runOperation(db, { workspace, actor, origin: "app", action: `planning.${decision}`, operationId,
    targetPublicId: publicId, expectedRevision, input: null,
  }, async ({ db, now }) => {
    const saved = await revisionByPublicId(db, workspace._id, publicId);
    if (!isAgentPreview(saved)) calendarError("PLAN_UNAVAILABLE");
    requireExpectedRevision(expectedRevision, saved.revision);
    if (decision === "approve") {
      const credential = await db.get("agentCredentials", saved.actor.credentialId);
      if (!credential || credential.workspaceId !== workspace._id || credential.userId !== workspace.ownerId ||
          credential.revokedAt !== undefined || credential.expiresAt <= now ||
          !credential.scopes.includes("planning:preview")) {
        throw new ConvexError("AGENT_UNAUTHORIZED");
      }
      return applyAgentProposal(db, saved, actor.userId, now, "review");
    }
    if (saved.state !== "preview") calendarError("PLAN_NOT_PENDING");
    if (saved.expiresAt <= now) calendarError("PLAN_EXPIRED");
    const revision = saved.revision + 1;
    await db.patch("planRevisions", saved._id, { state: "discarded", updatedAt: now, revision });
    return { target: { kind: "plan_revision", id: saved._id }, targetPublicId: publicId,
      revision, beforeRevision: saved.revision };
  });
  return portableAgentReceipt(db, result);
}
