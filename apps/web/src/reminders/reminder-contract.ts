import type { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { Task } from '../contracts';

export type ReminderProps = {
  client: ConvexClient;
  workspaceId: string;
  workspacePublicId: string;
  onOpenTask: (publicId: string) => void;
  onUnauthenticated: () => void;
  disabled?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export type Recurrence = { kind: 'daily' } | { kind: 'weekly'; weekdays: number[] } |
  { kind: 'monthly'; day: number } | { kind: 'interval'; everySeconds: number };
export const priorities = ['none', 'low', 'normal', 'high', 'urgent'] as const;
type Priority = typeof priorities[number];
type State = 'pending' | 'snoozed' | 'fired' | 'dismissed' | 'completed';
export type Occurrence = {
  publicId: string; reminderPublicId?: string; reminderTitle?: string; reminderRevision: number;
  dueAt: number; triggerAt: number; timezone: string; state: State | 'cancelled'; firedAt?: number; rolledOverAt?: number;
  deliveryState: 'disabled' | 'scheduled' | 'attempted' | 'accepted_by_provider' | 'failed' | 'cancelled';
};
type ReminderValues = {
  title: string; dueAt: number; timezone: string; description?: string; priority?: Priority;
  taskPublicId?: string; recurrence?: Recurrence; tags?: string[];
};
export type Reminder = ReminderValues & {
  publicId: string; revision: number; state: State; priority: Priority; dormant: boolean; occurrence: Occurrence | null;
  recurrenceBasis?: 'local_timezone' | 'legacy_utc'; snoozeUntil?: number; overdue?: boolean;
};
export type ReminderPatch = Partial<Omit<ReminderValues, 'description' | 'taskPublicId' | 'recurrence'> & {
    description: string | null; taskPublicId: string | null; recurrence: Recurrence | null;
  }>;

export type Scope = { workspaceId: string };
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
export type PageArgs = Scope & { paginationOpts: { numItems: number; cursor: string | null } };
export type Operation = Scope & { operationId: string };
type Identity = Scope & { publicId: string };
type Change = Identity & Operation & { expectedRevision: number };
type OccurrenceChange = Change & { occurrencePublicId: string };
export type OperationReceipt = { workspacePublicId: string; targetPublicId: string; revision: number; activityEventId: string };
export type ReminderWrite = { kind: 'create'; args: Operation & { reminder: ReminderValues } } |
  { kind: 'update'; args: Change & { patch: ReminderPatch } } |
  { kind: 'activate' | 'remove'; args: Change } |
  { kind: 'dismiss' | 'complete'; args: OccurrenceChange } |
  { kind: 'snooze'; args: OccurrenceChange & { snoozeUntil: number } };

export const remindersApi = {
  list: makeFunctionReference<'query', PageArgs & { taskPublicId?: string }, Page<Reminder>>('reminders:list'),
  get: makeFunctionReference<'query', Identity, Reminder | null>('reminders:get'),
  due: makeFunctionReference<'query', Scope & { asOf: number; limit: number }, { items: Reminder[]; partial: boolean }>('reminders:due'),
  history: makeFunctionReference<'query', PageArgs, Page<Occurrence>>('reminders:history'),
  create: makeFunctionReference<'mutation', Operation & { reminder: ReminderValues }, OperationReceipt>('reminders:create'),
  update: makeFunctionReference<'mutation', Change & { patch: ReminderPatch }, OperationReceipt>('reminders:update'),
  activate: makeFunctionReference<'mutation', Change, OperationReceipt>('reminders:activate'),
  remove: makeFunctionReference<'mutation', Change, OperationReceipt>('reminders:remove'),
  dismiss: makeFunctionReference<'mutation', OccurrenceChange, OperationReceipt>('reminders:dismiss'),
  complete: makeFunctionReference<'mutation', OccurrenceChange, OperationReceipt>('reminders:complete'),
  snooze: makeFunctionReference<'mutation', OccurrenceChange & { snoozeUntil: number }, OperationReceipt>('reminders:snooze'),
  search: makeFunctionReference<'query', Scope & { text: string }, { tasks: Task[] }>('organization:search'),
};

export const occurrenceStates = {
  pending: 'Pending', snoozed: 'Snoozed', fired: 'Fired', dismissed: 'Dismissed', completed: 'Completed', cancelled: 'Cancelled',
} as const;

export const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function dateLabel(instant: number, zone: string) {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
  try { return `${new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone }).format(instant)} · ${zone}`; }
  catch { return `${new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }).format(instant)} · UTC`; }
}
