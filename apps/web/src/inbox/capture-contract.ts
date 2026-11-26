import { makeFunctionReference } from 'convex/server';

type Source =
  | { kind: 'manual' | 'capture' | 'integration' | 'agent' }
  | { kind: 'legacy'; source: string; externalId?: string };

export type Capture = {
  publicId: string;
  body: string;
  tags: string[];
  revision: number;
  source?: Source;
  promotedTaskId?: string;
  archivedAt?: number;
};
export type CapturePage = { page: Capture[]; isDone: boolean; continueCursor: string };
type PageArgs = { workspaceId: string; paginationOpts: { cursor: string | null; numItems: number } };
type Identity = { publicId: string };
type ChangedCapture = Identity & { expectedRevision: number };
type Content = { body: string; tags?: string[] };
export type CaptureCommand =
  | (Identity & Content & { kind: 'capture.create' })
  | (ChangedCapture & Content & { kind: 'capture.update' })
  | (ChangedCapture & { kind: 'capture.archive' })
  | (ChangedCapture & { kind: 'capture.promote'; taskPublicId: string; title: string });
export type CaptureOperation = { workspaceId: string; operationId: string; command: CaptureCommand };

export type CaptureEditor =
  | { kind: 'edit'; capture: Capture; body: string; tags: string }
  | { kind: 'promote'; capture: Capture; title: string };

export type CaptureDraft = { body?: string; editor?: CaptureEditor; attempt?: CaptureOperation };

export const captureBodyLimit = 32_768;
export const captureSearchLimit = 256;
export const captureApi = {
  list: makeFunctionReference<'query', PageArgs, CapturePage>('captures:list'),
  search: makeFunctionReference<'query', PageArgs & { text: string }, CapturePage>('captures:search'),
  apply: makeFunctionReference<'mutation', CaptureOperation>('captures:apply'),
};

export function hasCaptureDraft(draft: CaptureDraft | undefined) {
  const editor = draft?.editor;
  return Boolean(draft?.body || draft?.attempt || editor?.kind === 'promote'
    || (editor?.kind === 'edit' && (editor.body !== editor.capture.body || editor.tags !== tagsText(editor.capture))));
}

export function tagsText(capture: Capture) {
  return capture.tags.join('\n');
}

export function sourceLabel(source: Capture['source']) {
  switch (source?.kind) {
    case 'legacy': return source.source === 'thoughts' ? 'Legacy thought' : `Legacy · ${source.source}`;
    case 'manual': return 'Manual capture';
    case 'integration': return 'Integration';
    case 'agent': return 'Agent';
    default: return 'Capture';
  }
}
