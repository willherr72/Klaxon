<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { api, errorCode, pageSize, type TaskStatus } from '../contracts';
  import { addDays, calendarClock, height, labelDate, minuteMs, validDate, weekStart } from './calendar-clock';
  import { calendarApi, placementConflicts, unscheduledReasons, type Block, type BlockCommand, type CalendarMode,
    type CalendarProps, type CalendarRange, type CalendarTask, type Conflict, type DayPlan, type Interval,
    type PlanPreview, type Preferences, type PreferenceValues } from './calendar-contract';
  import CalendarGrid from './CalendarGrid.svelte';
  import PreferenceEditor from './PreferenceEditor.svelte';

  let { client, workspaceId, disabled = false, onOpenTask, onDirtyChange, onUnauthenticated }: CalendarProps = $props();

  const taskStatuses = ['inbox', 'ready', 'in_progress', 'waiting'] as const satisfies TaskStatus[];
  type TrayStatus = typeof taskStatuses[number];
  type TrayPage = { status: TrayStatus; rows: CalendarTask[]; cursor: string | null };
  type Read = 'preferences' | 'calendar' | 'plan' | 'tasks';
  type Attempt = { execute: () => Promise<void>; reject?: (code: string, error: unknown) => void };
  type BlockDraft = {
    publicId: string; block?: Block; task?: CalendarTask; timezone: string; title: string;
    start: string; end: string; originalStart: number; originalEnd: number; startOccurrence?: number; endOccurrence?: number;
  };
  type Drag = { kind: 'task'; task: CalendarTask } | { kind: 'move' | 'resize'; block: Block };
  const dragMime = 'application/x-klaxon-calendar';
  const maxSelected = 40;

  let alive = true;
  let mode = $state<CalendarMode>('day');
  let selectedDate = $state('');
  let preferences = $state.raw<Preferences>();
  let planRead = $state.raw<{ date: string; value: DayPlan | null }>();
  let calendarRead = $state.raw<{ key: string; value: CalendarRange }>();
  let tray = $state.raw<TrayPage[]>([]);
  let trayBusy = $state(false);
  let reads = $state<Record<Read, string>>({ preferences: '', calendar: '', plan: '', tasks: '' });
  let readRetry = $state(0);
  let selectedIds = $state.raw<string[]>([]);
  let preferencesBase = $state.raw<Preferences>();
  let draft = $state<BlockDraft>();
  let draftOpener: HTMLElement | undefined;
  let editorRegion = $state<HTMLDivElement>();
  let preferenceTrigger: HTMLButtonElement;
  let previewTrigger: HTMLButtonElement;
  let reviewHeading = $state<HTMLHeadingElement>();
  let proposed = $state.raw<{ command: BlockCommand; interval: Interval }>();
  let conflicts = $state.raw<Conflict[]>([]);
  let review = $state.raw<{ plan: PlanPreview; preferencesRevision: number }>();
  let previewExpired = $state(false);
  let drag: Drag | undefined;
  let checking = $state(false);
  let pending = $state.raw<Attempt>();
  let retry = $state.raw<Attempt>();
  let dismissingRetry = $state(false);
  let confirmingRemove = $state(false);
  let staleEditor = $state(false);
  let message = $state('');
  let error = $state('');

  const clock = $derived(preferences && calendarClock(preferences.timezone));
  const date = $derived(selectedDate || clock?.date(Date.now()) || '');
  const rangeDate = $derived(mode === 'week' ? weekStart(date) : date);
  const rangeKey = $derived(JSON.stringify([preferences?.timezone, rangeDate, mode]));
  const range = $derived(calendarRead?.key === rangeKey ? calendarRead.value : undefined);
  const dayPlan = $derived(planRead?.date === date ? planRead.value : undefined);
  const tasks = $derived(Array.from(new Map(tray.flatMap(page => page.rows).map(task => [task.publicId, task])).values()));
  const dirty = $derived(Boolean(draft || preferencesBase || review || pending || retry));
  const locked = $derived(disabled || Boolean(pending || retry || checking));
  const editing = $derived(Boolean(draft || preferencesBase || review));
  const navigationDisabled = $derived(locked || editing);
  const planStale = $derived(Boolean(review && ((dayPlan !== undefined && review.plan.baseDayPlanRevision !== (dayPlan?.revision ?? null))
    || (preferences && review.preferencesRevision !== preferences.revision))));
  const startCandidates = $derived(draft && clock ? clock.candidates(draft.start) : []);
  const endCandidates = $derived(draft && clock ? clock.candidates(draft.end) : []);
  const draftStart = $derived(draft && chooseInstant(startCandidates, draft.startOccurrence, draft.originalStart));
  const draftEnd = $derived(draft && chooseInstant(endCandidates, draft.endOccurrence, draft.originalEnd));

  onDestroy(() => {
    alive = false;
    onDirtyChange?.(false);
  });

  $effect(() => { onDirtyChange?.(dirty); });

  function readError(source: Read, reason: unknown) {
    if (!alive) return;
    reads[source] = errorCode(reason) === 'CALENDAR_RANGE_LIMIT'
      ? 'There are too many records to show this period. Try a smaller range.'
      : 'Could not load ' + { preferences: 'scheduling preferences', calendar: 'the calendar', plan: 'the day plan', tasks: 'tasks' }[source] + '.';
    if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
  }

  $effect(() => {
    void readRetry;
    let current = true;
    const stop = client.onUpdate(calendarApi.preferences, { workspaceId }, next => {
      if (!current) return;
      preferences = next;
      reads.preferences = '';
    }, reason => { if (current) readError('preferences', reason); });
    return () => { current = false; stop(); };
  });

  $effect(() => {
    void readRetry;
    const timezone = preferences?.timezone;
    if (!timezone || !rangeDate || !addDays(rangeDate, mode === 'week' ? 7 : 1)) return;
    const key = rangeKey;
    let current = true;
    reads.calendar = '';
    const stop = client.onUpdate(calendarApi.list, { workspaceId, timezone, localDate: rangeDate, view: mode }, next => {
      if (!current) return;
      reads.calendar = '';
      calendarRead = { key, value: next };
    }, reason => {
      if (!current) return;
      calendarRead = undefined;
      readError('calendar', reason);
    });
    return () => { current = false; stop(); };
  });

  $effect(() => {
    void readRetry;
    const localDate = date;
    if (!localDate) return;
    let current = true;
    reads.plan = '';
    const stop = client.onUpdate(calendarApi.dayPlan, { workspaceId, localDate }, next => {
      if (!current) return;
      reads.plan = '';
      planRead = { date: localDate, value: next };
    }, reason => {
      if (!current) return;
      planRead = undefined;
      readError('plan', reason);
    });
    return () => { current = false; stop(); };
  });

  $effect(() => {
    void readRetry;
    void untrack(() => fetchTasks());
  });

  $effect(() => {
    const expiresAt = review?.plan.expiresAt;
    previewExpired = expiresAt !== undefined && expiresAt <= Date.now();
    if (expiresAt === undefined || expiresAt <= Date.now()) return;
    const timer = setTimeout(() => previewExpired = true, expiresAt - Date.now());
    return () => clearTimeout(timer);
  });

  async function fetchTasks(more = false) {
    if (trayBusy) return;
    trayBusy = true;
    reads.tasks = '';
    try {
      const next = await Promise.all(taskStatuses.map(async status => {
        const prior = more ? tray.find(page => page.status === status) : undefined;
        if (prior?.cursor === null) return prior;
        const page = await client.query(api.listTasks, { workspaceId, filter: { kind: 'status', status },
          paginationOpts: { cursor: prior?.cursor ?? null, numItems: pageSize } });
        const rows = [...(prior?.rows ?? [])];
        for (const task of page.page) if (!rows.some(row => row.publicId === task.publicId)) rows.push(task);
        return { status, rows, cursor: page.isDone ? null : page.continueCursor };
      }));
      if (alive) tray = next;
    } catch (reason) {
      readError('tasks', reason);
    } finally {
      if (alive) trayBusy = false;
    }
  }

  function changeDate(next: string) {
    if (navigationDisabled || !validDate(next) || !addDays(next, 7) || next === date) return;
    selectedDate = next;
    selectedIds = [];
    message = '';
    error = '';
    drag = undefined;
  }

  function changeMode(next: CalendarMode) {
    if (navigationDisabled || mode === next) return;
    mode = next;
    message = '';
    error = '';
    drag = undefined;
  }

  async function perform(attempt: Attempt) {
    if (!alive || pending || disabled) return;
    pending = attempt;
    retry = undefined;
    dismissingRetry = false;
    message = '';
    error = '';
    try {
      await attempt.execute();
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') onUnauthenticated();
      else if (code) {
        error = writeError(code);
        attempt.reject?.(code, reason);
      } else {
        retry = attempt;
        error = 'Could not confirm the change. Retry to check the same operation.';
      }
    } finally {
      if (alive) pending = undefined;
    }
  }

  function writeError(code: string) {
    switch (code) {
      case 'REVISION_CONFLICT': return 'This record changed. Review the latest version before saving again.';
      case 'BLOCK_UNAVAILABLE': return 'This time block is no longer available.';
      case 'BLOCK_LOCKED': return 'This block is now locked. Reload the block to review it.';
      case 'TASK_CLOSED': return 'Completed or archived tasks keep their historical time blocks.';
      case 'TASK_UNAVAILABLE': return 'A selected task is no longer available. Review your selection.';
      case 'CALENDAR_CONFLICT': return 'This time overlaps a calendar reservation.';
      case 'CALENDAR_RANGE_LIMIT': return 'There are too many records to confirm availability for this time.';
      case 'PLAN_CONTEXT_CHANGED': return 'Calendar or task context changed. Generate a new preview to review the latest plan.';
      case 'PLAN_EXPIRED': return 'This plan preview expired. Generate a new preview to continue.';
      case 'PLAN_NOT_PENDING':
      case 'PLAN_UNAVAILABLE': return 'This plan preview is no longer available. Generate a new preview.';
      case 'INVALID_ARGUMENT': return 'The calendar rejected these values. Review the date, time, and scheduling settings.';
      case 'FORBIDDEN': return 'You do not have permission to change this calendar.';
      default: return 'The calendar could not save this change.';
    }
  }

  function resetFeedback() {
    message = '';
    error = '';
    conflicts = [];
    proposed = undefined;
    confirmingRemove = false;
    staleEditor = false;
    drag = undefined;
  }

  async function focusEditor() {
    await tick();
    if (alive) editorRegion?.focus();
  }

  function openBlock(opener: EventTarget | null | undefined, options: { block?: Block; task?: CalendarTask; interval?: Interval } = {}) {
    if (!clock || !preferences || navigationDisabled) return;
    const { block, task, interval } = options;
    const startAt = interval?.startAt ?? block?.startAt ?? clock.resolve(`${date}T09:00`, true);
    const endAt = interval?.endAt ?? block?.endAt ?? (startAt === undefined ? undefined : startAt + defaultLength(task));
    if (startAt === undefined || endAt === undefined) return;
    resetFeedback();
    draftOpener = opener instanceof HTMLElement ? opener : undefined;
    draft = { block, task, publicId: block?.publicId ?? crypto.randomUUID(), timezone: preferences.timezone,
      title: block?.title ?? '', start: clock.input(startAt), end: clock.input(endAt), originalStart: startAt, originalEnd: endAt };
    void focusEditor();
  }

  async function restoreFocus(opener: HTMLElement | undefined) {
    await tick();
    if (alive && opener?.isConnected && (document.activeElement === document.body || editorRegion?.contains(document.activeElement))) opener.focus();
  }

  function closeBlock() {
    draft = undefined;
    resetFeedback();
    const opener = draftOpener;
    draftOpener = undefined;
    void restoreFocus(opener);
  }

  function openPreferences() {
    if (!preferences || navigationDisabled) return;
    resetFeedback();
    preferencesBase = preferences;
    void focusEditor();
  }

  function closePreferences() {
    preferencesBase = undefined;
    resetFeedback();
    void restoreFocus(preferenceTrigger);
  }

  function invalidatePlacement() {
    proposed = undefined;
    conflicts = [];
    error = '';
    confirmingRemove = false;
  }

  function chooseInstant(options: number[], choice: number | undefined, original: number) {
    if (choice !== undefined && options.includes(choice)) return choice;
    return options.includes(original) ? original : options[0];
  }

  function defaultLength(task: CalendarTask | undefined) {
    return (task?.estimateMinutes && task.estimateMinutes > 0 ? Math.min(task.estimateMinutes, 7 * 1440) : 30) * minuteMs;
  }

  async function checkPlacement(event: SubmitEvent) {
    event.preventDefault();
    const current = draft;
    if (!current || !clock || locked || staleEditor || current.block?.locked) return;
    if (preferences?.timezone !== current.timezone) {
      error = 'The scheduling time zone changed. Cancel this edit and open the block again.';
      return;
    }
    invalidatePlacement();
    const { block, title, task, publicId, timezone } = current;
    const startAt = draftStart;
    const endAt = draftEnd;
    if (startAt === undefined || endAt === undefined) {
      error = 'Enter times that exist in ' + timezone + '. Local times can be skipped when clocks change.';
      return;
    }
    if (endAt <= startAt || endAt - startAt > 7 * 1440 * minuteMs) {
      error = 'End must be after start. A block can last up to seven elapsed days.';
      return;
    }
    const interval = { startAt, endAt };
    let command: BlockCommand;
    if (!block) {
      if (!task && !title.trim()) {
        error = 'Enter a title for this time block.';
        return;
      }
      command = { kind: 'block.create', publicId, ...interval, timezone,
        ...(task ? { taskPublicId: task.publicId } : {}), ...(title.trim() ? { title: title.trim() } : {}) };
    } else {
      if (title.trim() !== (block.title ?? '')) {
        error = 'Save the title before reviewing a placement change.';
        return;
      }
      if (startAt === block.startAt && endAt === block.endAt) {
        error = 'Choose a new start or end time to change the placement.';
        return;
      }
      const target = { publicId, expectedRevision: block.revision, timezone };
      command = endAt - startAt === block.endAt - block.startAt
        ? { kind: 'block.move', ...target, startAt }
        : { kind: 'block.resize', ...target, ...interval };
    }
    checking = true;
    try {
      const result = await client.query(calendarApi.check, { workspaceId, ...interval, ...(block ? { publicId } : {}) });
      if (!alive) return;
      conflicts = result.conflicts;
      if (!conflicts.length) proposed = { command, interval };
    } catch (reason) {
      if (!alive) return;
      if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
      else error = errorCode(reason) === 'CALENDAR_RANGE_LIMIT'
        ? writeError('CALENDAR_RANGE_LIMIT') : 'Could not check availability. Review the placement again.';
    } finally {
      if (alive) checking = false;
    }
  }

  function saveBlock(command: BlockCommand) {
    if (locked || staleEditor) return;
    const args = { workspaceId, operationId: crypto.randomUUID(), command };
    const keepPlacementDraft = command.kind === 'block.update' && draft?.block
      && (draftStart !== draft.block.startAt || draftEnd !== draft.block.endAt);
    void perform({
      async execute() {
        const receipt = await client.mutation(calendarApi.block, args);
        if (!alive) return;
        if (keepPlacementDraft && command.kind === 'block.update' && draft?.block) {
          draft.block = { ...draft.block, title: command.title ?? undefined, revision: receipt.revision };
          draft.title = command.title ?? '';
          resetFeedback();
          message = 'Time block title saved. Review the placement when ready.';
          return;
        }
        closeBlock();
        message = command.kind === 'block.remove' ? 'Time block removed.' : 'Time block saved.';
      },
      reject(code, reason) {
        if (code === 'CALENDAR_CONFLICT') {
          proposed = undefined;
          conflicts = placementConflicts(reason);
        }
        if (code === 'REVISION_CONFLICT' || code === 'BLOCK_LOCKED' || code === 'BLOCK_UNAVAILABLE' || code === 'TASK_CLOSED') {
          staleEditor = true;
          proposed = undefined;
          confirmingRemove = false;
        }
      },
    });
  }

  function blockAction(kind: 'block.update' | 'block.lock' | 'block.unlock' | 'block.remove') {
    if (!draft?.block) return;
    const target = { publicId: draft.block.publicId, expectedRevision: draft.block.revision };
    if (kind === 'block.update') {
      const title = draft.title.trim();
      if (!title && !draft.block.taskPublicId) {
        error = 'Enter a title for this time block.';
        return;
      }
      saveBlock({ ...target, kind, title: title || null });
    } else saveBlock({ ...target, kind });
  }

  function reloadBlock() {
    if (!draft?.block || !clock) return;
    const latest = range?.blocks.find(block => block.publicId === draft?.publicId);
    if (!latest || latest.taskStatus === 'done' || latest.taskStatus === 'archived') {
      closeBlock();
      error = 'This block is no longer editable in this view.';
      return;
    }
    if (latest.revision <= draft.block.revision) {
      error = 'The latest block has not loaded yet. Try again after the calendar updates.';
      return;
    }
    const opener = draftOpener;
    draft = undefined;
    openBlock(opener, { block: latest });
  }

  function savePreferences(values: PreferenceValues, revision: number) {
    if (locked || staleEditor) return;
    const args = { workspaceId, operationId: crypto.randomUUID(), expectedRevision: revision, preferences: values };
    void perform({
      async execute() {
        await client.mutation(calendarApi.savePreferences, args);
        if (!alive) return;
        closePreferences();
        message = 'Scheduling preferences saved.';
      },
      reject(code) { if (code === 'REVISION_CONFLICT') staleEditor = true; },
    });
  }

  function reloadPreferences() {
    if (!preferences || !preferencesBase || preferences.revision <= preferencesBase.revision) {
      error = 'The latest preferences have not loaded yet. Try again after they update.';
      return;
    }
    resetFeedback();
    preferencesBase = preferences;
    void focusEditor();
  }

  function selectTask(task: CalendarTask, included: boolean) {
    if (navigationDisabled) return;
    selectedIds = included ? [...selectedIds, task.publicId].slice(0, maxSelected)
      : selectedIds.filter(id => id !== task.publicId);
    error = '';
  }

  function previewPlan() {
    if (navigationDisabled || !preferences || !selectedIds.length || dayPlan === undefined || !range) return;
    const preferencesRevision = preferences.revision;
    const args = { workspaceId, localDate: date, operationId: crypto.randomUUID(), taskPublicIds: [...selectedIds],
      expectedDayPlanRevision: dayPlan?.revision ?? null };
    void perform({ async execute() {
      const plan = await client.mutation(calendarApi.preview, args);
      if (!alive) return;
      review = { plan, preferencesRevision };
      await tick();
      if (alive) reviewHeading?.focus();
    } });
  }

  function closePreview() {
    review = undefined;
    resetFeedback();
    void restoreFocus(previewTrigger);
  }

  function applyPlan() {
    const plan = review?.plan;
    if (!plan || locked || planStale || Date.now() >= plan.expiresAt) return;
    const args = { workspaceId, operationId: crypto.randomUUID(), publicId: plan.publicId, expectedRevision: plan.revision };
    void perform({
      async execute() {
        await client.mutation(calendarApi.apply, args);
        if (!alive) return;
        closePreview();
        selectedIds = [];
        message = 'Day plan applied.';
      },
      reject(code) {
        if (['REVISION_CONFLICT', 'PLAN_CONTEXT_CHANGED', 'PLAN_EXPIRED', 'PLAN_UNAVAILABLE', 'PLAN_NOT_PENDING'].includes(code)) {
          review = undefined;
          void restoreFocus(previewTrigger);
        }
      },
    });
  }

  function startDrag(event: DragEvent, item: Drag) {
    if (navigationDisabled || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    drag = item;
    event.dataTransfer.setData(dragMime, item.kind);
    event.dataTransfer.effectAllowed = item.kind === 'task' ? 'copy' : 'move';
  }

  function drop(event: DragEvent, day: Interval) {
    if (!drag || navigationDisabled || !event.dataTransfer?.types.includes(dragMime) || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    const item = drag;
    drag = undefined;
    const top = event.currentTarget.getBoundingClientRect().top;
    const slot = 15 * minuteMs;
    const slots = Math.round((event.clientY - top) / height(slot));
    const at = Math.min(day.endAt, day.startAt + Math.max(0, slots) * slot);
    if (item.kind === 'task') {
      if (at >= day.endAt) return;
      openBlock(undefined, { task: item.task, interval: { startAt: at, endAt: at + defaultLength(item.task) } });
    } else if (item.kind === 'move' && at < day.endAt) {
      openBlock(undefined, { block: item.block, interval: { startAt: at, endAt: at + item.block.endAt - item.block.startAt } });
    } else if (item.kind === 'resize' && at > item.block.startAt) {
      openBlock(undefined, { block: item.block, interval: { startAt: item.block.startAt, endAt: at } });
    }
  }

  function dismissRetry() {
    retry = undefined;
    dismissingRetry = false;
    if (draft) closeBlock();
    if (preferencesBase) closePreferences();
    if (review) closePreview();
    error = 'Retry dismissed. Refresh the calendar to check whether the change was saved.';
  }

  function taskName(publicId: string) { return tasks.find(task => task.publicId === publicId)?.title ?? publicId; }
</script>

<div class="calendar-view">
  <div class="calendar-toolbar">
    <div><h2>Calendar</h2>{#if preferences}<p class="calendar-muted">{preferences.timezone}</p>{/if}</div>
    <div class="calendar-actions">
      <button type="button" disabled={!preferences || navigationDisabled} bind:this={preferenceTrigger} onclick={openPreferences}>Scheduling preferences</button>
      <button type="button" class="calendar-primary" disabled={!range || navigationDisabled}
        onclick={event => openBlock(event.currentTarget)}>New time block</button>
    </div>
  </div>
  <div class="calendar-toolbar calendar-date-bar">
    <div class="calendar-actions" role="group" aria-label="Calendar period">
      <button type="button" aria-label="Previous period" disabled={!date || navigationDisabled}
        onclick={() => changeDate(addDays(date, mode === 'week' ? -7 : -1))}>←</button>
      <button type="button" disabled={!clock || navigationDisabled} onclick={() => clock && changeDate(clock.date(Date.now()))}>Today</button>
      <button type="button" aria-label="Next period" disabled={!date || navigationDisabled}
        onclick={() => changeDate(addDays(date, mode === 'week' ? 7 : 1))}>→</button>
      {#if date}
        <input type="date" aria-label="Calendar date" value={date} min="0001-01-01" max="9999-12-24"
          disabled={navigationDisabled} onchange={event => {
            changeDate(event.currentTarget.value);
            event.currentTarget.value = date;
          }} />
      {/if}
    </div>
    <div class="calendar-actions" role="group" aria-label="Calendar view">
      <button type="button" aria-pressed={mode === 'day'} disabled={navigationDisabled} onclick={() => changeMode('day')}>Day</button>
      <button type="button" aria-pressed={mode === 'week'} disabled={navigationDisabled} onclick={() => changeMode('week')}>Week</button>
    </div>
  </div>

  {#if message}<p role="status" class="calendar-success">{message}</p>{/if}
  {#if error}<p role="alert" class="calendar-error">{error}</p>{/if}
  {#if Object.values(reads).some(Boolean)}
    <div class="calendar-error" role="alert">
      {#each Object.values(reads).filter(Boolean) as issue (issue)}<p>{issue}</p>{/each}
      <button type="button" disabled={Boolean(pending)} onclick={() => readRetry++}>Reload calendar data</button>
    </div>
  {/if}
  {#if retry}
    <div class="calendar-actions">
      <button type="button" class="calendar-primary" {disabled} onclick={() => retry && perform(retry)}>Retry change</button>
      <button type="button" onclick={() => dismissingRetry = !dismissingRetry}>Dismiss retry</button>
    </div>
    {#if dismissingRetry}
      <p>The change may already have been saved.</p>
      <button type="button" onclick={dismissRetry}>Stop retrying</button>
    {/if}
  {/if}

  {#if draft || preferencesBase}
    <div class="calendar-editor-region" role="region" aria-label="Calendar editor" tabindex="-1" bind:this={editorRegion}>
      {#if draft}
        <form class="calendar-editor" aria-label={draft.block ? 'Edit time block' : 'New time block'} onsubmit={checkPlacement}>
          <h3>{draft.block ? 'Edit time block' : 'New time block'}</h3>
          {#if draft.task || draft.block?.taskTitle}<p>{draft.task?.title ?? draft.block?.taskTitle}</p>{/if}
          {#if draft.block?.locked}<p>This block is locked. Unlock it to edit the title or time.</p>{/if}
          {#if preferences?.timezone !== draft.timezone}<p role="alert">The time zone changed. Cancel the draft and open the editor again.</p>{/if}
          <fieldset class="calendar-fields" disabled={locked || staleEditor || Boolean(draft.block?.locked)}>
            <label>Block title <input type="text" maxlength="300" bind:value={draft.title} oninput={invalidatePlacement} /></label>
            <label>Start <input type="datetime-local" step="any" required bind:value={draft.start} oninput={() => {
              if (draft) draft.startOccurrence = undefined;
              invalidatePlacement();
            }} /></label>
            <label>End <input type="datetime-local" step="any" required bind:value={draft.end} oninput={() => {
              if (draft) draft.endOccurrence = undefined;
              invalidatePlacement();
            }} /></label>
            {#each [{ name: 'Start occurrence', key: 'startOccurrence', choices: startCandidates, selected: draftStart },
              { name: 'End occurrence', key: 'endOccurrence', choices: endCandidates, selected: draftEnd }] as item (item.key)}
              {#if clock && item.choices.length > 1}
                <label>{item.name}
                  <select value={item.selected} onchange={event => {
                    if (draft && item.key === 'startOccurrence') draft.startOccurrence = Number(event.currentTarget.value);
                    if (draft && item.key === 'endOccurrence') draft.endOccurrence = Number(event.currentTarget.value);
                    invalidatePlacement();
                  }}>
                    {#each item.choices as instant, index (instant)}
                      <option value={instant}>{index === 0 ? 'First' : 'Second'} · {clock.label(instant)}</option>
                    {/each}
                  </select>
                </label>
              {/if}
            {/each}
          </fieldset>
          <p class="calendar-muted">Times in {draft.timezone}.</p>
          {#if conflicts.length}
            <div role="status" class="calendar-error">
              <p>Choose a time outside these reservations.</p>
              <ul>
                {#each conflicts as conflict (`${conflict.kind}:${conflict.publicId}`)}
                  <li><strong>{conflict.title ?? (conflict.kind === 'event' ? 'Busy event'
                    : range?.blocks.find(block => block.publicId === conflict.publicId)?.taskTitle ?? 'Time block')}</strong>
                    {#if clock}<span> · {clock.label(conflict.startAt)}–{clock.label(conflict.endAt)}</span>{/if}
                    {#if conflict.locked}<span> · Locked</span>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
          {#if proposed && clock}
            <p role="status">Available · {labelDate(clock.date(proposed.interval.startAt))}, {clock.label(proposed.interval.startAt)}–{clock.label(proposed.interval.endAt)}</p>
          {/if}
          {#if confirmingRemove}
            <p role="status">Remove this time block from the calendar?</p>
            <div class="calendar-actions">
              <button type="button" disabled={locked || staleEditor} onclick={() => blockAction('block.remove')}>Confirm removal</button>
              <button type="button" disabled={locked} onclick={() => confirmingRemove = false}>Keep block</button>
            </div>
          {:else}
            <div class="calendar-actions">
              {#if staleEditor}
                <button type="button" disabled={locked} onclick={reloadBlock}>Reload block</button>
              {:else if draft.block?.locked}
                <button type="button" disabled={locked} onclick={() => blockAction('block.unlock')}>Unlock block</button>
              {:else}
                {#if proposed}
                  <button type="button" class="calendar-primary" disabled={locked || preferences?.timezone !== draft.timezone}
                    onclick={() => proposed && saveBlock(proposed.command)}>Save placement</button>
                {/if}
                <button type="submit" class:calendar-primary={!proposed} disabled={locked || preferences?.timezone !== draft.timezone}>Review placement</button>
                {#if draft.block}
                  <button type="button" disabled={locked || draft.title.trim() === (draft.block.title ?? '')} onclick={() => blockAction('block.update')}>Save title</button>
                  <button type="button" disabled={locked} onclick={() => blockAction('block.lock')}>Lock block</button>
                  <button type="button" disabled={locked} onclick={() => confirmingRemove = true}>Remove block</button>
                {/if}
              {/if}
              <button type="button" disabled={Boolean(pending || retry || checking)} onclick={closeBlock}>Cancel</button>
            </div>
          {/if}
        </form>
      {:else if preferencesBase}
        {#key preferencesBase.revision}
          <PreferenceEditor base={preferencesBase} disabled={locked || staleEditor} cancelDisabled={Boolean(pending || retry)}
            onSubmit={savePreferences} onCancel={closePreferences} />
        {/key}
        {#if staleEditor}<button type="button" disabled={locked} onclick={reloadPreferences}>Load latest preferences</button>{/if}
      {/if}
    </div>
  {/if}

  {#if review}
    {@const plan = review.plan}
    {@const planClock = calendarClock(plan.timezone)}
    <section class="calendar-editor" aria-labelledby="calendar-review-heading">
      <h3 id="calendar-review-heading" tabindex="-1" bind:this={reviewHeading}>Review day plan</h3>
      <p>{labelDate(plan.localDate)} · {plan.timezone}</p>
      {#if plan.placements.length}
        <h4>Proposed blocks</h4>
        <ul>
          {#each plan.placements as placement, index (index)}
            <li>{placement.action === 'add' ? 'Add' : 'Move'} · {taskName(placement.taskPublicId)} ·
              {planClock.label(placement.startAt)}–{planClock.label(placement.endAt)}</li>
          {/each}
        </ul>
      {:else}<p>No time block changes proposed.</p>{/if}
      {#if plan.unscheduled.length}
        <h4>Unscheduled</h4>
        <ul>
          {#each plan.unscheduled as item (item.taskPublicId)}
            <li>{taskName(item.taskPublicId)} · {unscheduledReasons[item.reason]}{item.remainingMinutes === undefined ? '' : ` · ${item.remainingMinutes} min remaining`}</li>
          {/each}
        </ul>
      {/if}
      {#if planStale || previewExpired}
        <p role="status">{planStale ? 'The day plan or preferences changed.' : 'This preview expired.'} Discard it and generate a new preview.</p>
      {/if}
      <div class="calendar-actions">
        <button type="button" class="calendar-primary" disabled={locked || planStale || previewExpired} onclick={applyPlan}>Apply plan</button>
        <button type="button" disabled={Boolean(pending || retry)} onclick={closePreview}>Discard preview</button>
      </div>
    </section>
  {/if}

  <div class="calendar-layout">
    <div class="calendar-main">
      {#if range && clock}
        {#if !range.blocks.length && !range.events.length}<p class="calendar-muted">No blocks or events.</p>{/if}
        <CalendarGrid {range} {mode} {clock} selectedDate={date} disabled={navigationDisabled} onSelectDate={changeDate} {onOpenTask}
          onEdit={(block, event) => openBlock(event.currentTarget, { block })} onDrag={(event, block, kind) => startDrag(event, { kind, block })}
          onDrop={drop} onEndDrag={() => drag = undefined} />
      {:else if !reads.preferences && !reads.calendar}<p role="status">Loading calendar…</p>{/if}
    </div>
    <aside class="calendar-tray" aria-label="Tasks to schedule">
      <h3>Tasks to schedule</h3>
      {#if date}<p class="calendar-muted">Plan for {labelDate(date)}</p>{/if}
      {#if dayPlan?.needsReplan}<p role="status">This day plan needs review.</p>{/if}
      {#if trayBusy && !tasks.length}<p role="status">Loading tasks…</p>
      {:else if !tasks.length && !reads.tasks}<p>No active tasks to schedule.</p>{/if}
      <ul class="calendar-task-list">
        {#each tasks as task (task.publicId)}
          <li>
            <label class="calendar-check">
              <input type="checkbox" aria-label={'Include ' + task.title + ' in plan'} checked={selectedIds.includes(task.publicId)}
                disabled={navigationDisabled || (selectedIds.length >= maxSelected && !selectedIds.includes(task.publicId))}
                onchange={event => selectTask(task, event.currentTarget.checked)} />
              <span role="none" draggable={!navigationDisabled && Boolean(range)} class:calendar-draggable={!navigationDisabled && Boolean(range)}
                ondragstart={event => startDrag(event, { kind: 'task', task })} ondragend={() => drag = undefined}>{task.title}</span>
            </label>
            {#if task.estimateMinutes}<small class="calendar-muted">{task.estimateMinutes} min</small>{/if}
            <button type="button" aria-label={'Schedule ' + task.title} disabled={navigationDisabled || !range}
              onclick={event => openBlock(event.currentTarget, { task })}>Schedule</button>
          </li>
        {/each}
      </ul>
      {#if tray.some(page => page.cursor !== null)}
        <button type="button" disabled={trayBusy || navigationDisabled} onclick={() => fetchTasks(true)}>Load more tasks</button>
      {/if}
      {#if selectedIds.length}<p class="calendar-muted">{selectedIds.length} of {maxSelected} tasks selected</p>{/if}
      <button type="button" class="calendar-primary" bind:this={previewTrigger} disabled={navigationDisabled || !range || dayPlan === undefined || !selectedIds.length}
        onclick={previewPlan}>Preview day plan</button>
    </aside>
  </div>
</div>
