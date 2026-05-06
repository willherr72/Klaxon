const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

export function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

export function dayKey(ms: number): string {
  return startOfDay(new Date(ms)).toISOString().slice(0, 10);
}

/** Group label like "TODAY · 06 MAY 2026" or "WEDNESDAY · 08 MAY 2026". */
export function dayHeader(ms: number): string {
  const d = startOfDay(new Date(ms));
  const today = startOfDay(new Date());
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const datePart = `${String(d.getDate()).padStart(2, "0")} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;

  if (diff === 0) return `TODAY · ${datePart}`;
  if (diff === 1) return `TOMORROW · ${datePart}`;
  if (diff === -1) return `YESTERDAY · ${datePart}`;
  if (diff > 1 && diff <= 6) {
    const names = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
    return `${names[d.getDay()]} · ${datePart}`;
  }
  return datePart;
}

/** "14:30  TUE" — short time + weekday. */
export function shortTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}  ${WEEKDAYS[d.getDay()]}`;
}

/** Countdown like "02:14:33" or "1d 03:12" if > 24h. */
export function countdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, targetMs - nowMs);
  const totalSec = Math.floor(diff / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}D ${pad(hours)}:${pad(mins)}`;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}

/** Convert an ISO local datetime-local input value to UTC ms. */
export function localInputToMs(s: string): number {
  // datetime-local has no timezone — interpret as local
  return new Date(s).getTime();
}

/** Convert UTC ms to a datetime-local input value (local TZ). */
export function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
