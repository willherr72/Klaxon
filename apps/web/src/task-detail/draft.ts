import { taskStatuses } from '../contracts';
import { priorities, type Deadline, type DetailPatch, type Step, type TaskDetail } from './detail-contract';

export const estimateLimit = 525_600;
export const rankLimit = Number.MAX_SAFE_INTEGER;

export function taskDraft(task: TaskDetail) {
  const { deadline } = task;
  return {
    title: task.title, status: task.status, description: task.description ?? '', priority: task.priority,
    rank: String(task.rank), plannedDate: task.plannedDate ?? '', deadlineType: deadline?.kind ?? 'none',
    deadlineDate: deadline?.kind === 'date' ? deadline.date : '',
    deadlineTime: deadline?.kind === 'instant' ? new Date(deadline.at).toISOString().slice(0, -1) : '',
    deadlineTimezone: deadline?.kind === 'instant' ? deadline.timezone ?? '' : '',
    estimateMinutes: task.estimateMinutes === undefined ? '' : String(task.estimateMinutes),
    waitingPerson: task.waitingPerson ?? '', waitingReason: task.waitingReason ?? '',
    followUpDate: task.followUpDate ?? '', projectId: task.projectId ?? '',
  } as const;
}

export type TaskDraft = { -readonly [Key in keyof ReturnType<typeof taskDraft>]: ReturnType<typeof taskDraft>[Key] };
const deadlineFields = ['deadlineType', 'deadlineDate', 'deadlineTime', 'deadlineTimezone'] as const;
const descriptions = {
  title: 'Title', status: 'Status', description: 'Description / notes', priority: 'Priority', rank: 'Rank',
  plannedDate: 'Planned date', deadlineType: 'Deadline', estimateMinutes: 'Estimate (minutes)',
  waitingPerson: 'Waiting for', waitingReason: 'Waiting reason', followUpDate: 'Follow-up date', projectId: 'Project',
} as const;
type DraftField = keyof typeof descriptions;
const draftFields = Object.keys(descriptions) as DraftField[];

function fieldChanged(field: DraftField, first: TaskDraft, second: TaskDraft) {
  if (field !== 'deadlineType') return first[field] !== second[field];
  if (first.deadlineType !== second.deadlineType) return true;
  if (first.deadlineType === 'date') return first.deadlineDate !== second.deadlineDate;
  return first.deadlineType === 'instant' && (first.deadlineTime !== second.deadlineTime
    || first.deadlineTimezone !== second.deadlineTimezone);
}

function changedFields(task: TaskDetail, draft: TaskDraft) {
  const base = taskDraft(task);
  return draftFields.filter(field => fieldChanged(field, base, draft));
}

export function isTaskDirty(task: TaskDetail, draft: TaskDraft) {
  return changedFields(task, draft).length > 0;
}

function requiredTitle(title: string) {
  const value = title.trim();
  if (!value) throw new Error('Enter a task title.');
  return value;
}

function calendarDate(value: string, label: string) {
  if (!value) return null;
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00.000Z') : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`Enter a valid ${label.toLowerCase()}.`);
  }
  return value;
}

function editedDeadline(draft: TaskDraft): Deadline | null {
  if (draft.deadlineType === 'none') return null;
  if (draft.deadlineType === 'date') {
    const date = calendarDate(draft.deadlineDate, 'deadline date');
    if (!date) throw new Error('Enter a deadline date.');
    return { kind: 'date', date };
  }
  const time = draft.deadlineTime;
  const at = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(time)
    ? Date.parse(time + 'Z') : NaN;
  // Date.parse accepts some out-of-range calendar values by rolling them into the next day.
  if (!Number.isFinite(at) || !new Date(at).toISOString().startsWith(time.slice(0, time.indexOf('T') + 6))) {
    throw new Error('Enter a valid deadline time in UTC.');
  }
  const timezone = draft.deadlineTimezone.trim();
  if (!timezone) return { kind: 'instant', at };
  try {
    if (/^[+-]/.test(timezone)) throw new RangeError();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new Error('Enter a valid IANA time zone, such as America/Chicago.');
  }
  return { kind: 'instant', at, timezone };
}

export function taskPatch(task: TaskDetail, draft: TaskDraft): DetailPatch {
  const patch: DetailPatch = {};
  for (const field of changedFields(task, draft)) {
    switch (field) {
      case 'title': {
        const title = requiredTitle(draft.title);
        if (title !== task.title) patch.title = title;
        break;
      }
      case 'status':
        if (draft.status !== 'archived') patch.status = draft.status;
        break;
      case 'rank': {
        const rank = Number(draft.rank);
        if (draft.rank === '' || !Number.isFinite(rank) || Math.abs(rank) > rankLimit) {
          throw new Error('Enter a valid rank.');
        }
        if (rank !== task.rank) patch.rank = rank;
        break;
      }
      case 'estimateMinutes': {
        const minutes = draft.estimateMinutes === '' ? null : Number(draft.estimateMinutes);
        if (minutes !== null && (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > estimateLimit)) {
          throw new Error('Enter an estimate between 0 and 525,600 whole minutes.');
        }
        if (minutes !== task.estimateMinutes) patch.estimateMinutes = minutes;
        break;
      }
      case 'deadlineType':
        patch.deadline = editedDeadline(draft);
        break;
      case 'plannedDate':
      case 'followUpDate':
        patch[field] = calendarDate(draft[field], descriptions[field]);
        break;
      case 'projectId':
        patch.projectId = draft.projectId || null;
        // Assignments to project-specific lanes are invalid under a different project.
        if (task.laneId) patch.laneId = null;
        break;
      case 'description':
      case 'waitingPerson':
      case 'waitingReason':
        patch[field] = draft[field] || null;
        break;
      case 'priority':
        patch.priority = draft.priority;
        break;
    }
  }
  return patch;
}

function fieldText(field: DraftField, draft: TaskDraft, projectName: (id: string) => string) {
  switch (field) {
    case 'deadlineType':
      if (draft.deadlineType === 'instant') {
        return `${draft.deadlineTime.replace('T', ' ')} UTC${draft.deadlineTimezone ? ` (${draft.deadlineTimezone})` : ''}`;
      }
      return draft.deadlineType === 'date' ? draft.deadlineDate : '';
    case 'status': return taskStatuses[draft.status];
    case 'priority': return priorities[draft.priority];
    case 'projectId': return draft.projectId ? projectName(draft.projectId) : '';
    default: return draft[field];
  }
}

export function reviewTaskChanges(
  base: TaskDetail, draft: TaskDraft, latest: TaskDetail, projectName: (id: string) => string,
) {
  const before = taskDraft(base);
  const server = taskDraft(latest);
  return changedFields(base, draft)
    .filter(field => fieldChanged(field, before, server) && fieldChanged(field, draft, server))
    .map(field => ({
      field: descriptions[field], latest: fieldText(field, server, projectName), mine: fieldText(field, draft, projectName),
    }));
}

export function rebaseTaskDraft(base: TaskDetail, draft: TaskDraft, latest: TaskDetail): TaskDraft {
  const carried = changedFields(base, draft).flatMap(field => field === 'deadlineType' ? deadlineFields : [field]);
  return Object.assign(taskDraft(latest), Object.fromEntries(carried.map(field => [field, draft[field]])));
}

export function stepMoveRank(rows: Step[], index: number, direction: -1 | 1, hasMore: boolean) {
  const initial = rows[index]?.rank;
  for (let neighbor = index + direction; rows[neighbor]; neighbor += direction) {
    const near = rows[neighbor].rank;
    const far = rows[neighbor + direction]?.rank;
    if (far === undefined && direction === 1 && hasMore) return undefined;
    const candidate = far === undefined
      ? Math.max(-rankLimit, Math.min(rankLimit, near + direction))
      : near + (far - near) / 2;
    if ((candidate - near) * direction > 0 && (candidate - initial) * direction > 0
      && (far === undefined || (far - candidate) * direction > 0)) return candidate;
  }
}
