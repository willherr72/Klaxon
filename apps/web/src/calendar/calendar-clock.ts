import type { Interval } from './calendar-contract';

export const minuteMs = 60_000;
export const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
export const hourHeight = 48;

export function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) return false;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
}

export function addDays(date: string, days: number) {
  if (!validDate(date)) return '';
  const result = new Date(Date.parse(`${date}T00:00:00Z`) + days * dayMs).toISOString().split('T')[0];
  return validDate(result) ? result : '';
}

export function weekStart(date: string) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7)) || date;
}

const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
export const labelDate = (date: string) => dayLabel.format(Date.parse(`${date}T00:00:00Z`));

export function calendarClock(timezone: string) {
  const fields = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const label = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const hourLabel = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' });

  function wall(instant: number) {
    const parts = Object.fromEntries(fields.formatToParts(instant).map(({ type, value }) => [type, value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function wallAt(instant: number) { return Date.parse(`${wall(instant)}Z`); }

  function samples(local: string) {
    if (!validDate(local.slice(0, 10)) || !/T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(local.slice(10))) return undefined;
    const timestamp = Date.parse(`${local}Z`);
    const whole = Math.floor(timestamp / 1000) * 1000;
    const candidates = [-36, -12, 0, 12, 36].map(hours => {
      const probe = whole + hours * hourMs;
      return whole - (wallAt(probe) - probe);
    });
    const exact = [...new Set(candidates.filter(candidate => wallAt(candidate) === whole))]
      .sort((a, b) => a - b).map(candidate => candidate + timestamp - whole);
    return { whole, candidates, exact };
  }

  function resolve(local: string, clampGap = false) {
    const result = samples(local);
    if (!result) return undefined;
    const { whole, candidates, exact } = result;
    if (exact.length) return exact[0];
    if (!clampGap) return undefined;
    let before = Math.max(...candidates.filter(candidate => wallAt(candidate) < whole));
    let after = Math.min(...candidates.filter(candidate => wallAt(candidate) > whole));
    if (!Number.isFinite(before) || !Number.isFinite(after) || before >= after) return undefined;
    while (after - before > 1000) {
      const probe = Math.floor((before + (after - before) / 2) / 1000) * 1000;
      if (wallAt(probe) < whole) before = probe;
      else after = probe;
    }
    return after;
  }

  function input(instant: number) {
    const value = wall(instant);
    const milliseconds = new Date(instant).getUTCMilliseconds();
    if (milliseconds) return `${value}.${String(milliseconds).padStart(3, '0').replace(/0+$/, '')}`;
    return value.endsWith(':00') ? value.slice(0, -3) : value;
  }

  return {
    date: (instant: number) => wall(instant).slice(0, 10),
    midnight: (date: string) => resolve(`${date}T00:00`, true),
    label: (instant: number) => label.format(instant),
    hourLabel: (instant: number) => hourLabel.format(instant),
    candidates: (local: string) => samples(local)?.exact ?? [], resolve, input,
  };
}

export type CalendarClock = ReturnType<typeof calendarClock>;

export function overlaps(a: Interval, b: Interval) {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}

export function height(milliseconds: number) { return milliseconds / hourMs * hourHeight; }
