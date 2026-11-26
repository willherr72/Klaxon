import { ConvexError } from "convex/values";
import { expect, test, vi } from "vitest";
import { readAgentPage } from "../convex/model/agentPagination";

test("agent pagination bounds reads and emits only safe cursor errors", async () => {
  const load = vi.fn(async () => ["item"]);
  await expect(readAgentPage(load, {})).resolves.toEqual(["item"]);
  expect(load).toHaveBeenCalledWith({ cursor: null, numItems: 25, maximumRowsRead: 51, endCursor: undefined });
  await expect(readAgentPage(load, { limit: 51 })).rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT", field: "limit" } });
  await expect(readAgentPage(load, { cursor: "x".repeat(4097) }))
    .rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT", field: "cursor" } });
  expect(load).toHaveBeenCalledTimes(1);
  for (const original of [
    new SyntaxError("Unexpected token from private cursor"),
    new Error("InvalidCursor: private workspace"),
    new ConvexError({ paginationError: "InvalidCursor", diagnostic: "private" }),
  ]) {
    await expect(readAgentPage(() => Promise.reject(original), { cursor: "mismatch" }))
      .rejects.toMatchObject({ data: { code: "INVALID_ARGUMENT", field: "cursor" } });
  }
  const unrelated = new Error("transaction failed");
  await expect(readAgentPage(() => Promise.reject(unrelated), { cursor: "valid" })).rejects.toBe(unrelated);
});
