import { ConvexError, v } from "convex/values";
import { boundedPage } from "./pagination";

export const pageArgs = { cursor: v.optional(v.string()), limit: v.optional(v.number()) };

export async function readAgentPage<T>(load: (page: ReturnType<typeof boundedPage>) => Promise<T>,
  { cursor, limit = 25 }: { cursor?: string; limit?: number }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "limit" });
  }
  if (cursor !== undefined && (!cursor || cursor.length > 4096)) {
    throw new ConvexError({ code: "INVALID_ARGUMENT", field: "cursor" });
  }
  try {
    return await load(boundedPage({ cursor: cursor ?? null, numItems: limit }));
  } catch (error) {
    if (cursor !== undefined && (error instanceof SyntaxError ||
        (error instanceof Error && /InvalidCursor|is not valid JSON/.test(error.message)) ||
        (error instanceof ConvexError && (error.data as { paginationError?: string } | null)?.paginationError === "InvalidCursor"))) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", field: "cursor" });
    }
    throw error;
  }
}
