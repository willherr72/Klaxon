import type { PaginationOptions } from "convex/server";

export type Page = Pick<PaginationOptions, "cursor" | "numItems" | "endCursor">;

export function boundedPage({ cursor, endCursor, numItems }: Page) {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) {
    throw new RangeError("Request between 1 and 50 items per page");
  }
  // Leave room for a full indexed page before the database requests a split.
  return { cursor, endCursor, numItems, maximumRowsRead: 51 };
}
