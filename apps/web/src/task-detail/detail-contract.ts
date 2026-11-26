import type { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { Task, TaskStatus } from '../contracts';

export type DetailProps = {
  client: ConvexClient;
  workspaceId: string;
  publicId: string;
  disabled?: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onUnauthenticated?: () => void;
};

export const priorities = {
  none: 'None', low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent',
} as const;
export type Priority = keyof typeof priorities;
export type Deadline =
  | { kind: 'date'; date: string }
  | { kind: 'instant'; at: number; timezone?: string };
type Source =
  | { kind: 'manual' | 'capture' | 'integration' | 'agent' }
  | { kind: 'legacy'; source: string; externalId?: string };

export type TaskDetail = Task & {
  _id: string;
  priority: Priority;
  rank: number;
  description?: string;
  plannedDate?: string;
  deadline?: Deadline;
  estimateMinutes?: number;
  waitingReason?: string;
  waitingPerson?: string;
  followUpDate?: string;
  projectId?: string;
  laneId?: string;
  source?: Source;
};
export type Step = { publicId: string; title: string; rank: number; completed: boolean; revision: number };
export type Project = { _id: string; name: string; archivedAt?: number };

type TaskCorePatch = Partial<Pick<TaskDetail, 'title' | 'priority' | 'rank'>>;
type TaskOptionalKey = 'description' | 'plannedDate' | 'deadline' | 'estimateMinutes'
  | 'waitingReason' | 'waitingPerson' | 'followUpDate' | 'projectId' | 'laneId';
export type DetailPatch = TaskCorePatch & {
  [Key in TaskOptionalKey]?: NonNullable<TaskDetail[Key]> | null;
} & { status?: Exclude<TaskStatus, 'archived'> };

export type Lifecycle = 'task.archive' | 'task.reopen' | 'task.restore';
type RevisedTarget = { publicId: string; expectedRevision: number };
export type DetailCommand =
  | (RevisedTarget & { kind: 'task.update'; patch: DetailPatch })
  | (RevisedTarget & { kind: Lifecycle })
  | { kind: 'step.create'; publicId: string; taskId: string; title: string }
  | (RevisedTarget & { kind: 'step.update'; patch: Partial<Pick<Step, 'title' | 'rank' | 'completed'>> })
  | (RevisedTarget & { kind: 'step.delete' });
export type DetailOperation = { workspaceId: string; operationId: string; command: DetailCommand };
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type WorkspaceArgs = { workspaceId: string };
type PageArgs = WorkspaceArgs & { paginationOpts: { cursor: string | null; numItems: number } };

export const detailPageSize = 25;
export const detailApi = {
  task: makeFunctionReference<'query', WorkspaceArgs & { publicId: string }, TaskDetail | null>('tasks:get'),
  steps: makeFunctionReference<'query', PageArgs & { taskId: string }, Page<Step>>('steps:list'),
  projects: makeFunctionReference<'query', PageArgs, Page<Project>>('projects:list'),
  apply: makeFunctionReference<'mutation', DetailOperation, {
    workspacePublicId: string; targetPublicId: string; revision: number; activityEventId: string;
  }>('tasks:apply'),
};

export function sourceLabel(source: Source | undefined) {
  if (!source) return 'Source unavailable';
  switch (source.kind) {
    case 'manual': return 'Manual entry';
    case 'capture': return 'Capture';
    case 'integration': return 'Integration';
    case 'agent': return 'Agent';
    case 'legacy': return source.externalId ? `${source.source} (${source.externalId})` : source.source;
  }
}
