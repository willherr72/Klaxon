import { describe, expect, it } from "vitest";
import { neighboursFor } from "./board";

const lane = (...ids: string[]) => ids.map((id) => ({ id }));

describe("neighboursFor", () => {
  it("reports both neighbours for a card dropped mid-lane", () => {
    expect(neighboursFor(lane("a", "b", "c"), "b")).toEqual({
      beforeId: "a",
      afterId: "c",
    });
  });

  it("reports no card above when dropped at the top", () => {
    expect(neighboursFor(lane("a", "b", "c"), "a")).toEqual({
      beforeId: null,
      afterId: "b",
    });
  });

  it("reports no card below when dropped at the bottom", () => {
    expect(neighboursFor(lane("a", "b", "c"), "c")).toEqual({
      beforeId: "b",
      afterId: null,
    });
  });

  // A cross-lane drop into an empty lane, and the single-card lane, both
  // land here — the backend reads "no neighbours" as "use the top of the
  // lane", which is correct for both.
  it("reports neither neighbour when the card is alone in its lane", () => {
    expect(neighboursFor(lane("only"), "only")).toEqual({
      beforeId: null,
      afterId: null,
    });
  });

  // Defensive: if the dropped id isn't in the finalized list we must not
  // seed from whatever happens to sit at index 0 and -1.
  it("reports neither neighbour when the dropped card is not in the list", () => {
    expect(neighboursFor(lane("a", "b"), "missing")).toEqual({
      beforeId: null,
      afterId: null,
    });
  });

  it("handles an empty lane without throwing", () => {
    expect(neighboursFor([], "anything")).toEqual({
      beforeId: null,
      afterId: null,
    });
  });
});
