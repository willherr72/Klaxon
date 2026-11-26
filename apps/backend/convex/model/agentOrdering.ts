import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { enforceAutonomy } from "./autonomy";
import { checkPublicId } from "./taskDomain";

type Member = Pick<Doc<"tasks">, "publicId" | "rank" | "revision">;
type Read = "last" | "equal" | "less" | "greater" | "all";
const maximumRebalance = 256;
const spacing = 1024;

// For ordinary moves read only the destination neighbor and its predecessor.
// Equal legacy ranks are ordered by the same index the board or step list uses.
async function insertion<T extends Member>(moving: string, before: string | undefined,
  neighbor: (id: string) => Promise<T | null>, rows: (kind: Read, rank: number, limit: number) => Promise<T[]>,
  setRank: (item: T, rank: number) => Promise<void>) {
  if (moving === before) throw new ConvexError("INVALID_ARGUMENT");
  if (before) checkPublicId(before);
  const anchor = before === undefined ? null : await neighbor(before);
  if (before !== undefined && !anchor) throw new ConvexError("NOT_FOUND");
  const different = (row: T) => row.publicId !== moving;
  const valid = (rank: number) => Number.isFinite(rank) && Math.abs(rank) <= Number.MAX_SAFE_INTEGER;
  if (!anchor) {
    const last = (await rows("last", 0, 2)).find(different);
    const rank = last ? last.rank + spacing : 0;
    if (valid(rank) && (!last || rank > last.rank)) return {rank, rebalanced:false};
  } else {
    const equal = (await rows("equal", anchor.rank, maximumRebalance + 2)).filter(different);
    const prior = (await rows("less", anchor.rank, 2)).find(different);
    if (equal[0]?.publicId === anchor.publicId) {
      const rank = prior ? prior.rank + (anchor.rank - prior.rank) / 2 : anchor.rank - spacing;
      if (valid(rank) && rank < anchor.rank && (!prior || rank > prior.rank)) return {rank, rebalanced:false};
    } else if (equal.length <= maximumRebalance) {
      const next = (await rows("greater", anchor.rank, 2)).find(different);
      const low = prior?.rank ?? anchor.rank - spacing;
      const high = next?.rank ?? anchor.rank + spacing;
      const position = equal.findIndex(row => row.publicId === anchor.publicId);
      const ranks = Array.from({length:equal.length + 1}, (_, i) => low + (high-low)*(i+1)/(equal.length+2));
      if (position >= 0 && ranks.every((rank,i) => valid(rank) && rank > (i ? ranks[i-1] : low) && rank < high)) {
        for (const [i,row] of equal.entries()) await setRank(row, ranks[i < position ? i : i+1]);
        return {rank:ranks[position], rebalanced:true};
      }
    }
  }
  const all = (await rows("all",0,maximumRebalance+2)).filter(different);
  if (all.length > maximumRebalance) throw new ConvexError("ORDER_RANGE_LIMIT");
  const index = anchor ? all.findIndex(row => row.publicId === anchor.publicId) : all.length;
  if (index < 0) throw new ConvexError("NOT_FOUND");
  for (const [i,row] of all.entries()) await setRank(row, (i < index ? i : i+1)*spacing);
  return {rank:index*spacing,rebalanced:true};
}

export async function stepPosition(db: DatabaseWriter, task: Doc<"tasks">, moving: string, before: string | undefined, now: number) {
  const {workspaceId} = task;
  const orderChanges: NonNullable<Doc<"activityEvents">["orderChanges"]> = [];
  const position = await insertion(moving, before, async publicId => {
    const step = await db.query("taskSteps").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId",workspaceId).eq("publicId",publicId)).unique();
    return step?.taskId === task._id ? step : null;
  }, (kind,rank,limit) => db.query("taskSteps").withIndex("by_workspace_task_rank", q => {
    const group = q.eq("workspaceId",workspaceId).eq("taskId",task._id);
    switch (kind) {
      case "equal": return group.eq("rank",rank);
      case "less": return group.lt("rank",rank);
      case "greater": return group.gt("rank",rank);
      default: return group;
    }
  }).order(kind === "last" || kind === "less" ? "desc" : "asc").take(limit),
  async (row,rank) => {
    if (row.rank === rank) return;
    await db.patch(row._id,{rank,revision:row.revision+1,updatedAt:now});
    orderChanges.push({publicId:row.publicId,beforeRank:row.rank,afterRank:rank,afterRevision:row.revision+1});
  });
  return {rank:position.rank,orderChanges};
}

export async function taskPosition(db: DatabaseWriter, task: Doc<"tasks">, laneId: Id<"lanes"> | undefined, before: string | undefined, now: number) {
  const {workspaceId,projectId} = task;
  const changedRanks: { row: Doc<"tasks">; rank: number }[] = [];
  const position = await insertion(task.publicId, before, async publicId => {
    const row = await db.query("tasks").withIndex("by_workspace_public_id", q =>
      q.eq("workspaceId",workspaceId).eq("publicId",publicId)).unique();
    return row && row.projectId === projectId && row.laneId === laneId ? row : null;
  }, (kind,rank,limit) => db.query("tasks").withIndex("by_workspace_project_lane_rank", q => {
    const group = q.eq("workspaceId",workspaceId).eq("projectId",projectId).eq("laneId",laneId);
    switch (kind) {
      case "equal": return group.eq("rank",rank);
      case "less": return group.lt("rank",rank);
      case "greater": return group.gt("rank",rank);
      default: return group;
    }
  }).order(kind === "last" || kind === "less" ? "desc" : "asc").take(limit),
  async (row,rank) => { if (row.rank !== rank) changedRanks.push({ row, rank }); });
  if (changedRanks.length) {
    await enforceAutonomy(db, workspaceId, changedRanks.map(({ row }) => row), now, "preview");
    for (const { row, rank } of changedRanks) {
      await db.patch(row._id,{rank,rankTieBreak:undefined,revision:row.revision+1,updatedAt:now});
    }
  }
  return {rank:position.rank,orderChanges:changedRanks.map(({row,rank}) => ({
    publicId:row.publicId,beforeRank:row.rank,afterRank:rank,afterRevision:row.revision+1,beforeTieBreak:row.rankTieBreak,
  }))};
}
