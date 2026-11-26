import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { requiredText } from "./taskDomain";

export function linkByPublicId(db: DatabaseReader, workspaceId: Id<"workspaces">, publicId: string) {
  return db.query("externalLinks").withIndex("by_workspace_public_id", q =>
    q.eq("workspaceId", workspaceId).eq("publicId", publicId)).unique();
}

export function referenceFields(input: { url: string; label?: string }) {
  const raw = requiredText(input.url, "url", 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "url" });
  }
  if (url.protocol !== "https:" || url.username || url.password || /[\x00-\x20\x7f]/u.test(raw)) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "url" });
  }
  const label = input.label?.trim() ? requiredText(input.label, "label", 512) : undefined;
  return { canonicalUrl: url.href, label };
}

export async function addReference(db: DatabaseWriter, task: Doc<"tasks">,
  input: { publicId: string; url: string; label?: string }, now: number) {
  if (task.status === "archived") throw new ConvexError({ code: "INVALID_STATE" });
  const { workspaceId, _id: taskId } = task;
  const { publicId } = input;
  if (await linkByPublicId(db, workspaceId, publicId)) throw new ConvexError({ code: "ALREADY_EXISTS" });
  const id = await db.insert("externalLinks", {
    workspaceId, taskId, publicId, provider: "url", relationship: "reference",
    ...referenceFields(input), createdAt: now, updatedAt: now, revision: 1,
  });
  return { target: { kind: "external_link" as const, id }, targetPublicId: publicId, revision: 1 };
}
