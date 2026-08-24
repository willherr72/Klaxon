import { describe, expect, it } from "vitest";
import { localDayKey, dayBounds } from "./day";

describe("localDayKey", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 7, 23, 14, 30))).toBe("2026-08-23");
  });

  // Zero-padding is what keeps lexical comparison chronological, which is
  // what the SQL range query relies on.
  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  // The whole point of a LOCAL key: a moment late in the evening belongs to
  // that evening's date, not to tomorrow in UTC.
  it("uses the local date, not the UTC date", () => {
    const lateEvening = new Date(2026, 7, 23, 23, 30);
    expect(localDayKey(lateEvening)).toBe("2026-08-23");
  });

  it("sorts lexically in chronological order", () => {
    const keys = [
      localDayKey(new Date(2026, 8, 1)),
      localDayKey(new Date(2026, 7, 31)),
      localDayKey(new Date(2026, 7, 9)),
    ];
    expect([...keys].sort()).toEqual(["2026-08-09", "2026-08-31", "2026-09-01"]);
  });
});

describe("dayBounds", () => {
  it("spans local midnight to the next local midnight", () => {
    const { startMs, endMs } = dayBounds(new Date(2026, 7, 23, 14, 30));
    expect(new Date(startMs).getHours()).toBe(0);
    expect(new Date(startMs).getDate()).toBe(23);
    expect(endMs - startMs).toBe(86_400_000);
  });

  it("is half-open so an item at midnight belongs to one day only", () => {
    const a = dayBounds(new Date(2026, 7, 23));
    const b = dayBounds(new Date(2026, 7, 24));
    expect(a.endMs).toBe(b.startMs);
  });
});
