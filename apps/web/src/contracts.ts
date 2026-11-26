import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';

export const taskStatuses = {
  inbox: 'Inbox',
  ready: 'Ready',
  in_progress: 'In progress',
  waiting: 'Waiting',
  done: 'Done',
  archived: 'Archived',
} as const;

export type TaskStatus = keyof typeof taskStatuses;
export type EditableStatus = Exclude<TaskStatus, 'archived'>;
export const editableStatuses = (Object.keys(taskStatuses) as TaskStatus[])
  .filter((status): status is EditableStatus => status !== 'archived');
export const pageSize = 25;
export const titleLimit = 512;

export type Task = { publicId: string; title: string; status: TaskStatus; revision: number };
export type TaskPage = { page: Task[]; isDone: boolean; continueCursor: string };
export type Workspace = { _id: string; publicId: string; ownerId: string; name: string };
export type TaskPatch = Partial<{ title: string; status: EditableStatus }>;
export type TaskCommand =
  | { kind: 'task.create'; publicId: string; title: string; status: EditableStatus }
  | { kind: 'task.update'; publicId: string; expectedRevision: number; patch: TaskPatch };
export type TaskOperation = { workspaceId: string; operationId: string; command: TaskCommand };

type PageArgs = {
  workspaceId: string;
  filter: { kind: 'status'; status: TaskStatus };
  paginationOpts: { cursor: string | null; numItems: number };
};
type OperationResult = {
  workspacePublicId: string;
  targetPublicId: string;
  revision: number;
  activityEventId: string;
};

export const api = {
  signIn: makeFunctionReference<'mutation', { username: string; password: string }, unknown>(
    'auth:signInWithUsernamePassword',
  ),
  refresh: makeFunctionReference<'mutation', { refreshToken: string }, unknown>('auth:refreshSession'),
  signOut: makeFunctionReference<'mutation', { refreshToken: string }, null>('auth:signOut'),
  ensurePersonal: makeFunctionReference<'mutation', Record<string, never>, Workspace>('workspaces:ensurePersonal'),
  listTasks: makeFunctionReference<'query', PageArgs, TaskPage>('tasks:list'),
  getTask: makeFunctionReference<'query', { workspaceId: string; publicId: string }, Task | null>('tasks:get'),
  applyTask: makeFunctionReference<'mutation', TaskOperation, OperationResult>('tasks:apply'),
};

export function errorCode(error: unknown) {
  if (!(error instanceof ConvexError)) return undefined;
  const { data } = error;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && 'code' in data && typeof data.code === 'string') return data.code;
  return undefined;
}

export function conflictRevision(error: unknown) {
  if (!(error instanceof ConvexError)) return undefined;
  const { data } = error;
  if (data && typeof data === 'object' && 'currentRevision' in data
      && typeof data.currentRevision === 'number' && Number.isSafeInteger(data.currentRevision)) {
    return data.currentRevision;
  }
}
