import { calendarClock, minuteMs } from '../calendar/calendar-clock';
import type { Recurrence, Reminder, ReminderPatch } from './reminder-contract';

export function zoneClock(zone: string) {
  if (zone.length > 100 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone)) return undefined;
  try { return calendarClock(zone); }
  catch { return undefined; }
}

function equalRecurrence(left?: Recurrence, right?: Recurrence) {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === 'interval' && right?.kind === 'interval') return left.everySeconds === right.everySeconds;
  if (left?.kind === 'monthly' && right?.kind === 'monthly') return left.day === right.day;
  if (left?.kind === 'weekly' && right?.kind === 'weekly') {
    return left.weekdays.length === right.weekdays.length && left.weekdays.every(day => right.weekdays.includes(day));
  }
  return true;
}

export function createDraft(original?: Reminder) {
  const timezone = original?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const clock = zoneClock(timezone) ?? calendarClock('UTC');
  const dueAt = original?.dueAt ?? Math.ceil(Date.now() / minuteMs + 30) * minuteMs;
  const due = clock.input(dueAt);
  const recurrence = original?.recurrence;
  return {
    title: original?.title ?? '', description: original?.description ?? '', priority: original?.priority ?? 'normal' as const,
    timezone, due, fold: Math.max(0, clock.candidates(due).indexOf(dueAt)),
    taskPublicId: original?.taskPublicId ?? '', kind: recurrence?.kind ?? 'once' as const,
    weekdays: recurrence?.kind === 'weekly' ? [...recurrence.weekdays] : [] as number[],
    day: recurrence?.kind === 'monthly' ? recurrence.day : Number(due.slice(8, 10)) as number | undefined,
    everySeconds: recurrence?.kind === 'interval' ? recurrence.everySeconds : 3600 as number | undefined,
  };
}

export type ReminderDraft = ReturnType<typeof createDraft>;

export function mergeDraft(draft: ReminderDraft, original: ReminderDraft, latest: ReminderDraft) {
  const sameSchedule = draft.timezone === original.timezone && draft.due === original.due && draft.fold === original.fold;
  const sameRule = draft.kind === original.kind && draft.day === original.day && draft.everySeconds === original.everySeconds &&
    draft.weekdays.join(',') === original.weekdays.join(',');
  return {
    ...draft,
    title: draft.title === original.title ? latest.title : draft.title,
    description: draft.description === original.description ? latest.description : draft.description,
    priority: draft.priority === original.priority ? latest.priority : draft.priority,
    taskPublicId: draft.taskPublicId === original.taskPublicId ? latest.taskPublicId : draft.taskPublicId,
    ...(sameSchedule ? { timezone: latest.timezone, due: latest.due, fold: latest.fold } : {}),
    ...(sameRule ? { kind: latest.kind, day: latest.day, everySeconds: latest.everySeconds, weekdays: latest.weekdays } : {}),
  };
}

export function readDraft(draft: ReminderDraft) {
  const title = draft.title.trim();
  const timezone = draft.timezone.trim();
  const clock = timezone ? zoneClock(timezone) : undefined;
  if (!title) throw new Error('Enter a title.');
  if (!clock) throw new Error('Enter a valid time zone, such as America/Chicago or UTC.');
  const candidates = clock.candidates(draft.due);
  const dueAt = candidates[draft.fold] ?? candidates[0];
  if (dueAt === undefined) throw new Error('Choose an existing local time. Clocks can skip times during daylight saving changes.');
  let recurrence: Recurrence | undefined;
  switch (draft.kind) {
    case 'daily': recurrence = { kind: 'daily' }; break;
    case 'weekly':
      if (!draft.weekdays.length) throw new Error('Choose at least one weekday.');
      recurrence = { kind: 'weekly', weekdays: [...draft.weekdays].sort((a, b) => a - b) };
      break;
    case 'monthly':
      if (draft.day === undefined || !Number.isInteger(draft.day) || draft.day < 1 || draft.day > 31) {
        throw new Error('Enter a day from 1 to 31.');
      }
      recurrence = { kind: 'monthly', day: draft.day };
      break;
    case 'interval':
      if (draft.everySeconds === undefined || !Number.isSafeInteger(draft.everySeconds) || draft.everySeconds < 1) {
        throw new Error('Enter a positive whole number of seconds.');
      }
      recurrence = { kind: 'interval', everySeconds: draft.everySeconds };
      break;
  }
  const description = draft.description.trim() || undefined;
  return { title, timezone, dueAt, description, priority: draft.priority, taskPublicId: draft.taskPublicId || undefined, recurrence };
}

export function reminderPatch(values: ReturnType<typeof readDraft>, original: Reminder): ReminderPatch {
  const patch: ReminderPatch = {};
  if (values.title !== original.title) patch.title = values.title;
  if (values.dueAt !== original.dueAt) patch.dueAt = values.dueAt;
  if (values.timezone !== original.timezone) patch.timezone = values.timezone;
  if (values.priority !== original.priority) patch.priority = values.priority;
  if (values.description !== (original.description?.trim() || undefined)) patch.description = values.description ?? null;
  if (values.taskPublicId !== original.taskPublicId) patch.taskPublicId = values.taskPublicId ?? null;
  if (!equalRecurrence(values.recurrence, original.recurrence)) patch.recurrence = values.recurrence ?? null;
  return patch;
}
