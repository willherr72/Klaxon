import { describe, expect, it } from "vitest";
import { localDayKey, dayBounds } from "./day";

// Several cases below can only fail in a DST-observing zone whose local
// time differs from UTC. `vitest.config.ts` pins TZ=America/Chicago for
// exactly that reason. If the pin ever stops taking effect, this fails
// first and says so, rather than letting the others quietly go inert.
it("runs in the pinned DST-observing timezone", () => {
  expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(360);
  expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(300);
});

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
  // that evening's date, not to tomorrow in UTC. The getUTCDate assertion
  // pins the trap open — it proves this moment really does straddle the two
  // calendars, so swapping localDayKey to the getUTC* accessors fails here.
  it("uses the local date, not the UTC date", () => {
    const lateEvening = new Date(2026, 7, 23, 23, 30);
    expect(lateEvening.getUTCDate()).toBe(24);
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
  it("spans local midnight to the next local midnight on an ordinary day", () => {
    const { startMs, endMs } = dayBounds(new Date(2026, 7, 23, 14, 30));
    expect(new Date(startMs).getHours()).toBe(0);
    expect(new Date(startMs).getDate()).toBe(23);
    expect(endMs - startMs).toBe(86_400_000);
  });

  // These two are the cases that separate a real next-local-midnight from
  // `startMs + 86_400_000`. The naive version satisfies every other test in
  // this file and is wrong twice a year, shifting every day boundary in the
  // calendar panel by an hour.
  it("spans 23 hours on the spring-forward day", () => {
    const { startMs, endMs } = dayBounds(new Date(2026, 2, 8));
    expect(endMs - startMs).toBe(23 * 3_600_000);
  });

  it("spans 25 hours on the fall-back day", () => {
    const { startMs, endMs } = dayBounds(new Date(2026, 10, 1));
    expect(endMs - startMs).toBe(25 * 3_600_000);
  });

  it("is half-open so an item at midnight belongs to one day only", () => {
    const a = dayBounds(new Date(2026, 7, 23));
    const b = dayBounds(new Date(2026, 7, 24));
    expect(a.endMs).toBe(b.startMs);
  });
});
