import type { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import type { Task, TaskStatus } from '../contracts';

export type CalendarProps = {
  client: ConvexClient;
  workspaceId: string;
  disabled?: boolean;
  onOpenTask: (event: MouseEvent, publicId: string) => void;
  onUnauthenticated: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};

export type CalendarMode = 'day' | 'week';
export type Interval = { startAt: number; endAt: number };
export type Block = Interval & {
  publicId: string; revision: number; localDate: string; timezone: string; locked: boolean;
  title?: string; origin: 'manual' | 'agent' | 'automation'; taskPublicId?: string; taskTitle?: string; taskStatus?: TaskStatus;
};
export type Event = Interval & {
  publicId: string; revision: number; localDate: string; timezone: string; title?: string;
  provider: string; allDay: boolean; availability: string; connectionState: string;
};
export type CalendarRange = Interval & { localDate: string; timezone: string; blocks: Block[]; events: Event[] };
export type CalendarTask = Task & { estimateMinutes?: number };
export type Conflict = Interval & { kind: 'block' | 'event'; publicId: string; title?: string; locked?: boolean };
type Scope = { workspaceId: string };
type Write = Scope & { operationId: string };
type Revised = { publicId: string; expectedRevision: number };
export type BlockCommand =
  | (Interval & { kind: 'block.create'; publicId: string; timezone: string; taskPublicId?: string; title?: string })
  | (Revised & { kind: 'block.update'; title: string | null })
  | (Revised & { kind: 'block.move'; startAt: number; timezone: string })
  | (Revised & Interval & { kind: 'block.resize'; timezone: string })
  | (Revised & { kind: 'block.lock' | 'block.unlock' | 'block.remove' });
type Receipt = { revision: number; targetPublicId: string };

export type WorkWindow = { weekday: number; startMinute: number; endMinute: number };
export type PreferenceValues = {
  timezone: string; workHours: WorkWindow[]; breaks: WorkWindow[];
  bufferMinutes: number; discretionaryMinutes: number; lockManuallyMovedBlocks: boolean;
};
export type Preferences = PreferenceValues & { publicId: string | null; revision: number };
export type DayPlan = { revision: number; needsReplan: boolean };
type Unscheduled = { taskPublicId: string; reason: 'missing_estimate' | 'capacity' | 'deadline' | 'inactive'; remainingMinutes?: number };
type Placement = Interval & { taskPublicId: string; action: 'add' | 'move'; blockPublicId?: string };
export type PlanPreview = {
  publicId: string; revision: number; localDate: string; timezone: string; expiresAt: number;
  baseDayPlanRevision: number | null; placements: Placement[]; unscheduled: Unscheduled[];
};

export const calendarApi = {
  list: makeFunctionReference<'query', Scope & { localDate: string; view: CalendarMode; timezone: string }, CalendarRange>('calendar:list'),
  check: makeFunctionReference<'query', Scope & Interval & { publicId?: string }, { conflicts: Conflict[] }>('calendar:checkPlacement'),
  block: makeFunctionReference<'mutation', Write & { command: BlockCommand }, Receipt>('calendar:apply'),
  preferences: makeFunctionReference<'query', Scope, Preferences>('planning:getPreferences'),
  savePreferences: makeFunctionReference<'mutation', Write & { expectedRevision: number; preferences: PreferenceValues }, Receipt>('planning:updatePreferences'),
  dayPlan: makeFunctionReference<'query', Scope & { localDate: string }, DayPlan | null>('planning:getDayPlan'),
  preview: makeFunctionReference<'mutation', Write & { localDate: string; taskPublicIds: string[]; expectedDayPlanRevision: number | null }, PlanPreview>('planning:preview'),
  apply: makeFunctionReference<'mutation', Write & Revised, Receipt>('planning:apply'),
};

export function placementConflicts(error: unknown): Conflict[] {
  if (error instanceof ConvexError && error.data?.code === 'CALENDAR_CONFLICT' && Array.isArray(error.data.conflicts)) {
    return error.data.conflicts;
  }
  return [];
}

export const unscheduledReasons = {
  missing_estimate: 'Missing estimate', capacity: 'Insufficient capacity', deadline: 'Cannot fit before the deadline', inactive: 'Task is inactive',
} satisfies Record<Unscheduled['reason'], string>;
