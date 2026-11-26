import { makeFunctionReference } from 'convex/server';
import type { Task, TaskPage } from '../contracts';

export type View = 'today' | 'upcoming' | 'waiting';
type AgendaTask = Task & {
  estimateMinutes?: number; waitingPerson?: string; waitingReason?: string; followUpDate?: string;
  deadline?: { kind: 'instant'; at: number } | { kind: 'date'; date: string };
};
type Section = { items: AgendaTask[]; partial: boolean };
export const sections = {
  focus: 'Focus', overdue: 'Overdue', dueToday: 'Due today', followUps: 'Follow up',
  planned: 'Planned for today', unplanned: 'Unplanned',
} as const;
export const sectionKeys = Object.keys(sections) as (keyof typeof sections)[];
export type Today = Record<keyof typeof sections, Section> & { briefing?: string; needsReplan: boolean };
export type Upcoming = { items: { kind: 'deadline' | 'planned' | 'reminder'; date: string; at?: number; publicId: string; title: string }[]; partial: boolean };
type Interval = { publicId: string; startAt: number; endAt: number; title?: string };
export type Schedule = { blocks: (Interval & { taskPublicId?: string; taskTitle?: string })[]; events: (Interval & { allDay: boolean })[] };
export type Waiting = Omit<TaskPage, 'page'> & { page: AgendaTask[] };
type Workspace = { workspaceId: string };
type Day = Workspace & { localDate: string; timezone: string };
export const queries = {
  preferences: makeFunctionReference<'query', Workspace, {timezone: string}>('planning:getPreferences'),
  today: makeFunctionReference<'query', Day & { asOf: number }, Today>('agenda:today'),
  schedule: makeFunctionReference<'query', Day & {view: 'day'}, Schedule>('calendar:list'),
  upcoming: makeFunctionReference<'query', Workspace & {from: string; timezone: string}, Upcoming>('agenda:upcoming'),
  waiting: makeFunctionReference<'query', Workspace & {filter: {kind: 'status'; status: 'waiting'}; paginationOpts: {cursor: string | null; numItems: number}}, Waiting>('tasks:list'),
};

export function localDate(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(timestamp);
  const part = (key: string) => parts.find(p => p.type === key)?.value;
  return [part('year'), part('month'), part('day')].join('-');
}

export function addDays(day: string, count: number) {
  const value = new Date(day + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
