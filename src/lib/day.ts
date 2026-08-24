/**
 * The one place a Date becomes a day key.
 *
 * The backend never derives a calendar day from a timestamp — only the
 * frontend knows the user's local calendar, and two implementations would
 * eventually disagree about which day a moment belongs to. Everything that
 * needs a day key comes through here.
 */

/**
 * A local calendar date as 'YYYY-MM-DD'. Zero-padded so that lexical
 * ordering is chronological, which the SQL range query depends on.
 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Half-open [startMs, endMs) covering the local day `d` falls in. Half-open
 * so an item landing exactly on midnight belongs to exactly one day.
 */
export function dayBounds(d: Date): { startMs: number; endMs: number } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
