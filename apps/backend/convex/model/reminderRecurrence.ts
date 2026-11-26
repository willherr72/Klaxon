import type { Doc } from "../_generated/dataModel";
import { addLocalDays, calendarError, localWeekday, zonedClock } from "./calendarTime";

type Recurrence = NonNullable<Doc<"reminders">["recurrence"]>;
const maxInstant = 8.64e15;

export function normalizeRecurrence(rule: Recurrence): Recurrence {
  if (rule.kind === "weekly") {
    const weekdays = [...new Set(rule.weekdays)].sort((a, b) => a - b);
    if (weekdays.length === 0 || weekdays.length !== rule.weekdays.length) {
      calendarError("INVALID_ARGUMENT", "Select distinct weekdays for weekly recurrence");
    }
    return { kind: "weekly", weekdays };
  }
  if (rule.kind === "monthly" && (!Number.isInteger(rule.day) || rule.day < 1 || rule.day > 31)) {
    calendarError("INVALID_ARGUMENT", "Monthly recurrence requires a day from 1 to 31");
  }
  if (rule.kind === "interval" && (!Number.isSafeInteger(rule.everySeconds) || rule.everySeconds < 1)) {
    calendarError("INVALID_ARGUMENT", "Interval recurrence requires positive whole seconds");
  }
  return rule;
}

function calendarClock(timezone: string, anchorAt: number, preserveMilliseconds: boolean) {
  const clock = zonedClock(timezone);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: clock.timezone, numberingSystem: "latn", hourCycle: "h23",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  function time(instant: number) {
    return formatter.format(instant);
  }
  const [hour, minute, second] = time(anchorAt).split(":").map(Number);
  const minuteOfDay = hour * 60 + minute;
  const milliseconds = preserveMilliseconds ? new Date(anchorAt).getUTCMilliseconds() : 0;
  return {
    date: clock.date,
    at(date: string) {
      const instant = clock.at(date, minuteOfDay);
      // A skipped wall time resolves to the transition itself. Keep the
      // original anchor so a gap never changes the time on following days.
      const [resolvedHour, resolvedMinute] = time(instant).split(":").map(Number);
      if (clock.date(instant) !== date || resolvedHour !== hour || resolvedMinute !== minute) return instant;
      return instant + second * 1_000 + milliseconds;
    },
  };
}

function nextMonthly(clock: ReturnType<typeof calendarClock>, lastDate: string, cutoffDate: string,
  cutoff: number, day: number, startNextMonth: boolean) {
  const monthOf = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
  const firstMonth = Math.max(monthOf(lastDate) + (startNextMonth ? 1 : 0), monthOf(cutoffDate));
  for (const month of [firstMonth, firstMonth + 1]) {
    const year = Math.floor(month / 12);
    if (year > 9999) return undefined;
    const monthIndex = month % 12;
    const lastDay = new Date(0);
    lastDay.setUTCFullYear(year, monthIndex + 1, 0);
    const target = `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(Math.min(day, lastDay.getUTCDate())).padStart(2, "0")}`;
    const candidate = clock.at(target);
    if (candidate > cutoff) return candidate;
  }
}

function supportsCalendarInstant(instant: number) {
  const year = new Date(instant).getUTCFullYear();
  return year >= 1 && year <= 9999;
}

export function nextReminderDue(reminder: Doc<"reminders">, now: number) {
  const { recurrence, dueAt } = reminder;
  if (!recurrence) return undefined;
  const cutoff = Math.max(dueAt, now);
  if (recurrence.kind === "interval") {
    if (!Number.isSafeInteger(recurrence.everySeconds) || recurrence.everySeconds < 1) return undefined;
    // Integer arithmetic keeps the cadence exact even after many missed cycles.
    const step = BigInt(recurrence.everySeconds) * 1_000n;
    const last = BigInt(dueAt);
    const next = last + ((BigInt(cutoff) - last) / step + 1n) * step;
    return next <= BigInt(maxInstant) ? Number(next) : undefined;
  }

  const anchor = reminder.recurrenceAnchorAt ?? dueAt;
  if (![anchor, dueAt, cutoff].every(supportsCalendarInstant)) return undefined;
  const legacy = reminder.recurrenceBasis === "legacy_utc";
  const clock = calendarClock(legacy ? "UTC" : reminder.timezone, anchor, !legacy || recurrence.kind !== "monthly");
  const lastDate = clock.date(dueAt);
  const cutoffDate = clock.date(cutoff);
  if (![lastDate, cutoffDate].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date))) return undefined;
  if (recurrence.kind === "monthly") {
    return nextMonthly(clock, lastDate, cutoffDate, cutoff, legacy ? Math.min(recurrence.day, 28) : recurrence.day,
      legacy || anchor === dueAt);
  }

  // The cutoff's local date can still have an occurrence when the prior
  // nominal date was skipped and clamped to midnight on the cutoff date.
  let candidateDate = cutoffDate;
  for (let offset = 0; offset < 8; offset++) {
    if (recurrence.kind === "daily" || recurrence.weekdays.includes(localWeekday(candidateDate) as
      (typeof recurrence.weekdays)[number])) {
      const candidate = clock.at(candidateDate);
      if (candidate > cutoff) return candidate;
    }
    if (candidateDate === "9999-12-31") return undefined;
    candidateDate = addLocalDays(candidateDate, 1);
  }
}
