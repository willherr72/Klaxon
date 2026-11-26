import { ConvexError } from "convex/values";

export const minuteMs = 60_000;
const dayMs = 1_440 * minuteMs;
const hourMs = 60 * minuteMs;

export type Interval = { startAt: number; endAt: number };

export function calendarError(code: string, message?: string): never {
  throw new ConvexError({ code, message });
}

export function overlaps(a: Interval, b: Interval) {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

export function validateInstant(value: number) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) {
    calendarError("INVALID_ARGUMENT", "Expected a valid UTC millisecond timestamp");
  }
}

export function validateInterval(startAt: number, endAt: number) {
  validateInstant(startAt);
  validateInstant(endAt);
  if (startAt >= endAt || endAt - startAt > 7 * dayMs) {
    calendarError("INVALID_ARGUMENT", "A time block must last more than zero and at most seven elapsed days");
  }
  return { startAt, endAt };
}

function midnight(localDate: string) {
  const result = Date.parse(`${localDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || localDate.startsWith("0000-") ||
      !Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== localDate) {
    calendarError("INVALID_ARGUMENT", "Expected a valid YYYY-MM-DD local date");
  }
  return result;
}

export function addLocalDays(localDate: string, days: number) {
  return new Date(midnight(localDate) + days * dayMs).toISOString().split("T")[0];
}

export function localWeekday(localDate: string) {
  return (new Date(midnight(localDate)).getUTCDay() + 6) % 7;
}

export function zonedClock(timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    if (timezone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timezone)) throw new RangeError();
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    calendarError("INVALID_ARGUMENT", "Expected an IANA timezone such as America/Chicago");
  }

  function fields(instant: number) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map(({ type, value }) => [type, value]));
    const date = `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`;
    return { date, time: `${parts.hour}:${parts.minute}:${parts.second}` };
  }

  function wallTime(instant: number) {
    const { date, time } = fields(instant);
    return Date.parse(`${date}T${time}Z`);
  }

  function at(localDate: string, minute: number) {
    const wall = midnight(localDate) + minute * minuteMs;
    const candidates = new Set<number>();
    // Both sides of an offset transition are needed to resolve gaps and folds.
    for (const offsetHours of [-36, -12, 0, 12, 36]) {
      const probe = wall + offsetHours * hourMs;
      candidates.add(wall - (wallTime(probe) - probe));
    }
    const exact = [...candidates].filter(instant => wallTime(instant) === wall);
    if (exact.length) return Math.min(...exact); // Earlier occurrence on a fold.
    // Clamp a missing wall time to the transition. A work window contained
    // entirely in the gap then contributes zero elapsed minutes.
    let before = Math.max(...[...candidates].filter(instant => wallTime(instant) < wall));
    let after = Math.min(...[...candidates].filter(instant => wallTime(instant) > wall));
    if (!Number.isFinite(before) || !Number.isFinite(after) || before >= after) {
      calendarError("INVALID_ARGUMENT", "Could not resolve this local time");
    }
    while (after - before > 1_000) {
      const probe = Math.floor((before + (after - before) / 2) / 1_000) * 1_000;
      if (wallTime(probe) < wall) before = probe;
      else after = probe;
    }
    return after;
  }

  return { timezone: formatter.resolvedOptions().timeZone, date: (instant: number) => fields(instant).date, at };
}

export function calendarRange(localDate: string, days: number, clock: ReturnType<typeof zonedClock>) {
  return { startAt: clock.at(localDate, 0), endAt: clock.at(addLocalDays(localDate, days), 0) };
}
