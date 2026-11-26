import type { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { Task } from '../contracts';

export interface ProjectsProps {
  client: ConvexClient;
  workspaceId: string;
  disabled?: boolean;
  onOpenTask: (publicId: string) => void;
  onUnauthenticated?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export type Project = { _id: string; publicId: string; name: string; area?: string; revision: number; archivedAt?: number };
export type ProjectTask = Task & { laneId?: string };
export type Lane = { _id: string; publicId: string; name: string; rank: number };
export type LanePage = { lanes: Lane[]; partial: boolean };
export type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

type Scope = { workspaceId: string };
type ProjectScope = Scope & { projectId: string };
type PageArgs = Scope & { paginationOpts: { cursor: string | null; numItems: number } };
type Operation = Scope & { operationId: string };
type RecordRevision = { publicId: string; expectedRevision: number };
export type ProjectPatch = { name?: string; area?: string | null };
export type Command =
  | { kind: 'project.create'; publicId: string; name: string; area?: string }
  | (RecordRevision & { kind: 'project.update'; patch: ProjectPatch })
  | (RecordRevision & { kind: 'project.archive' | 'project.restore' })
  | (RecordRevision & { kind: 'task.update'; patch: { laneId: string | null } });
export type Write =
  | { kind: 'taskDomain'; args: Operation & { command: Command } }
  | { kind: 'lane'; args: ProjectScope & Operation & { publicId: string; name: string } };

export const projectsApi = {
  projects: makeFunctionReference<'query', PageArgs, Page<Project>>('projects:list'),
  tasks: makeFunctionReference<'query', PageArgs & { filter: { kind: 'project'; projectId: string } }, Page<ProjectTask>>('tasks:list'),
  lanes: makeFunctionReference<'query', ProjectScope, LanePage>('organization:lanes'),
  change: makeFunctionReference<'mutation', Extract<Write, { kind: 'taskDomain' }>['args']>('tasks:apply'),
  createLane: makeFunctionReference<'mutation', Extract<Write, { kind: 'lane' }>['args']>('organization:createLane'),
};
