import { describe, expect, it } from "vitest";
import { starCount, priorityForStars } from "./stars";

describe("star ↔ priority mapping", () => {
  it("maps each priority to its star count", () => {
    expect(starCount("low")).toBe(1);
    expect(starCount("normal")).toBe(2);
    expect(starCount("high")).toBe(3);
  });

  it("round-trips every priority", () => {
    for (const p of ["low", "normal", "high"] as const) {
      expect(priorityForStars(starCount(p))).toBe(p);
    }
  });

  // The card renders exactly three stars, so 1..3 is all the UI can send —
  // but clamping is what stops an out-of-range value becoming `undefined`
  // and being written to the database as a priority.
  it("clamps out-of-range star counts instead of returning undefined", () => {
    expect(priorityForStars(0)).toBe("low");
    expect(priorityForStars(-1)).toBe("low");
    expect(priorityForStars(4)).toBe("high");
    expect(priorityForStars(99)).toBe("high");
  });
});
