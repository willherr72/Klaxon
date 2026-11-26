import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { checkedTags, requiredText } from "./taskDomain";

export function captureByPublicId(db: DatabaseReader, workspaceId: Id<"workspaces">, publicId: string) {
  return db.query("captures").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
}

export function searchCaptures(db: DatabaseReader, workspaceId: Id<"workspaces">, text: string) {
  const term = requiredText(text, "text", 256);
  return db.query("captures").withSearchIndex("search_body", q =>
    q.search("body", term).eq("workspaceId", workspaceId));
}

export async function addCapture(db: DatabaseWriter, workspaceId: Id<"workspaces">,
  { publicId, body, tags }: { publicId: string; body: string; tags?: string[] },
  source: NonNullable<Doc<"captures">["source"]>, now: number) {
  if (await captureByPublicId(db, workspaceId, publicId)) throw new ConvexError({ code: "ALREADY_EXISTS" });
  const id = await db.insert("captures", {
    workspaceId, publicId, body: requiredText(body, "body", 32_768), tags: checkedTags(tags ?? []),
    source, revision: 1, createdAt: now, updatedAt: now,
  });
  return { target: { kind: "capture" as const, id }, targetPublicId: publicId, revision: 1 };
}
