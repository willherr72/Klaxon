<script lang="ts">
  import { recoverDraft } from '../draft-recovery';
  import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
  import { onDestroy, tick, untrack } from 'svelte';
  import { api, conflictRevision, errorCode, pageSize, type Task } from '../contracts';
  import { minuteMs } from '../calendar/calendar-clock';
  import DeliverySettings from './DeliverySettings.svelte';
  import ReminderEditor from './ReminderEditor.svelte';
  import { dateLabel, occurrenceStates, remindersApi, weekdays, type Occurrence, type Page, type Reminder, type ReminderProps,
    type ReminderWrite } from './reminder-contract';
  import { createDraft, mergeDraft, readDraft, reminderPatch, type ReminderDraft } from './reminder-draft';

  let { client, workspaceId, workspacePublicId, disabled = false, onOpenTask, onUnauthenticated,
    onDirtyChange }: ReminderProps = $props();
  const tabs = { list: 'All reminders', due: 'Due', history: 'Occurrence history' } as const;
  type Tab = keyof typeof tabs;
  type Read = Tab | 'detail';
  type Action = 'activate' | 'remove' | 'dismiss' | 'complete';
  const actions: Record<Action, { label: string; confirm: string; explanation: string }> = {
    activate: { label: 'Activate reminder', confirm: 'Confirm activation', explanation: 'Activate this dormant reminder and create its current occurrence.' },
    remove: { label: 'Remove reminder', confirm: 'Confirm removal', explanation: 'Permanently remove this reminder and cancel its current occurrence.' },
    dismiss: { label: 'Dismiss occurrence', confirm: 'Confirm dismissal', explanation: 'Dismiss this occurrence. A repeating reminder advances to its next scheduled time.' },
    complete: { label: 'Complete reminder', confirm: 'Confirm completion', explanation: 'Complete this reminder and end its schedule.' },
  };
  const resultMessages = {
    create: 'Reminder created.', update: 'Reminder updated.', activate: 'Reminder activated.', remove: 'Reminder removed.',
    dismiss: 'Occurrence dismissed.', complete: 'Reminder completed.', snooze: 'Reminder snoozed.',
  };
  const deliveryLabels = {
    disabled: 'Delivery disabled', scheduled: 'Delivery scheduled', attempted: 'Delivery attempted',
    accepted_by_provider: 'Accepted by push provider', failed: 'Delivery failed', cancelled: 'Delivery cancelled',
  };
  const delayOptions = [5, 15, 30, 60];

  let tab = $state<Tab>('list');
  let cursors = $state<(string | null)[]>([null]);
  let list = $state.raw<Page<Reminder>>();
  let upcoming = $state.raw<{ items: Reminder[]; partial: boolean }>();
  let history = $state.raw<Page<Occurrence>>();
  let selectedId = $state<string>();
  let selected = $state.raw<Reminder | null>();
  let linkedTask = $state.raw<Task | null>();
  let readErrors = $state<Partial<Record<Read, boolean>>>({});
  let readAttempts = $state({ list: 0, due: 0, history: 0, detail: 0 });
  let asOf = $state(0);
  let edit = $state<{ original?: Reminder; values: ReminderDraft; baseline: ReminderDraft }>();
  let confirmation = $state.raw<{ kind: Action; target: Reminder }>();
  let snooze = $state.raw<Reminder>();
  let snoozeMinutes = $state(15);
  let pending = $state(false);
  let attempt = $state.raw<ReminderWrite>();
  let review = $state<number | null>();
  let notice = $state('');
  let writeError = $state('');
  let deliveryDirty = $state(false);
  let container = $state<HTMLElement>();
  let detailHeading = $state<HTMLHeadingElement>();
  let newButton = $state<HTMLButtonElement>();
  let alive = true;

  const edited = $derived(Boolean(edit && JSON.stringify(edit.values) !== JSON.stringify(edit.baseline)));
  const busy = $derived(disabled || pending || Boolean(attempt));
  const hasPanel = $derived(Boolean(edit || confirmation || snooze));
  const dirty = $derived(edited || Boolean(attempt || confirmation || snooze) || deliveryDirty);
  const canSelect = $derived(!busy && !hasPanel && !deliveryDirty);
  const page = $derived(tab === 'list' ? list : history);

  const restored = recoverDraft('reminders', () => dirty ? {
    tab, selectedId, confirmation, snooze, snoozeMinutes, attempt, review, writeError, edit: $state.snapshot(edit),
  } : undefined);
  if (restored) {
    tab = restored.tab;
    selectedId = restored.selectedId;
    confirmation = restored.confirmation;
    snooze = restored.snooze;
    snoozeMinutes = restored.snoozeMinutes;
    attempt = restored.attempt;
    review = restored.review;
    writeError = restored.writeError;
    edit = restored.edit;
  }

  $effect(() => {
    const value = dirty;
    const report = onDirtyChange;
    untrack(() => report?.(value));
  });
  onDestroy(() => { alive = false; onDirtyChange?.(false); });

  function watch<Query extends FunctionReference<'query'>>(
    reference: Query, args: FunctionArgs<Query>, kind: Read, receive: (value: FunctionReturnType<Query>) => void,
  ) {
    readErrors[kind] = false;
    let active = true;
    const stop = client.onUpdate(reference, args, result => {
      if (!active) return;
      receive(result);
      readErrors[kind] = false;
    }, reason => {
      if (!active) return;
      if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
      else readErrors[kind] = true;
    });
    return () => { active = false; stop(); };
  }

  function updateClock() { asOf = Date.now(); }

  $effect(() => {
    if (tab !== 'due') return;
    updateClock();
    const timer = window.setInterval(updateClock, minuteMs);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    upcoming = undefined;
    void readAttempts.due;
    if (tab !== 'due' || !asOf) return;
    return watch(remindersApi.due, { workspaceId, asOf, limit: 50 }, 'due', result => { upcoming = result; });
  });

  $effect(() => {
    const paginationOpts = { cursor: cursors.at(-1) ?? null, numItems: pageSize };
    if (tab === 'list') {
      void readAttempts.list;
      list = undefined;
      return watch(remindersApi.list, { workspaceId, paginationOpts }, 'list', result => { list = result; });
    }
    if (tab === 'history') {
      void readAttempts.history;
      history = undefined;
      return watch(remindersApi.history, { workspaceId, paginationOpts }, 'history', result => { history = result; });
    }
  });

  $effect(() => {
    selected = undefined;
    void readAttempts.detail;
    if (!selectedId) return;
    return watch(remindersApi.get, { workspaceId, publicId: selectedId }, 'detail', result => { selected = result; });
  });

  $effect(() => {
    const publicId = selected?.taskPublicId;
    linkedTask = undefined;
    if (!publicId) return;
    let active = true;
    const stop = client.onUpdate(api.getTask, { workspaceId, publicId }, value => {
      if (active) linkedTask = value;
    }, reason => {
      if (!active) return;
      if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
      else linkedTask = null;
    });
    return () => { active = false; stop(); };
  });

  function resetMessages() { notice = ''; writeError = ''; review = undefined; }

  function changeTab(next: Tab) {
    if (!canSelect || tab === next) return;
    selectedId = undefined;
    cursors = [null];
    resetMessages();
    tab = next;
  }

  function changePage(direction: -1 | 1) {
    if (!canSelect || !page) return;
    if (direction < 0 && cursors.length > 1) cursors = cursors.slice(0, -1);
    if (direction > 0 && !page.isDone) cursors = [...cursors, page.continueCursor];
  }

  async function open(publicId: string) {
    if (!canSelect) return;
    resetMessages();
    selectedId = publicId;
    await tick();
    if (alive) detailHeading?.focus();
  }

  async function startEdit(original: Reminder | undefined = undefined) {
    if (!canSelect) return;
    resetMessages();
    edit = { original, values: createDraft(original), baseline: createDraft(original) };
    await tick();
    if (alive) container?.querySelector<HTMLInputElement>('[data-reminder-editor-title]')?.focus();
  }

  async function closeAction() {
    edit = undefined;
    confirmation = undefined;
    snooze = undefined;
    review = undefined;
    await tick();
    if (alive) (detailHeading ?? newButton)?.focus();
  }

  function reviewLatest() {
    if (!edit?.original || !selected || selected.publicId !== edit.original.publicId ||
        selected.revision < (review ?? edit.original.revision + 1)) return;
    const baseline = createDraft(selected);
    edit = { original: selected, values: mergeDraft(edit.values, edit.baseline, baseline), baseline };
    resetMessages();
  }

  function save() {
    if (!edit || busy || review !== undefined) return;
    try {
      const values = readDraft(edit.values);
      const operation = { workspaceId, operationId: crypto.randomUUID() };
      if (edit.original) {
        const patch = reminderPatch(values, edit.original);
        if (!Object.keys(patch).length) { void closeAction(); return; }
        void apply({ kind: 'update', args: { ...operation, publicId: edit.original.publicId, expectedRevision: edit.original.revision, patch } });
      } else {
        const { title, timezone, dueAt, priority, description, taskPublicId, recurrence } = values;
        void apply({ kind: 'create', args: { ...operation, reminder: { title, timezone, dueAt,
          ...(priority !== 'normal' && { priority }), ...(description && { description }),
          ...(taskPublicId && { taskPublicId }), ...(recurrence && { recurrence }) } } });
      }
    } catch (reason) {
      writeError = reason instanceof Error ? reason.message : 'Check the reminder fields.';
    }
  }

  function startAction(kind: Action, target: Reminder) {
    if (!canSelect) return;
    resetMessages();
    confirmation = { kind, target };
  }

  function runConfirmation() {
    if (!confirmation || busy) return;
    const { kind, target } = confirmation;
    const args = { workspaceId, operationId: crypto.randomUUID(), publicId: target.publicId, expectedRevision: target.revision };
    if (kind === 'activate' || kind === 'remove') void apply({ kind, args });
    else if (target.occurrence) void apply({ kind, args: { ...args, occurrencePublicId: target.occurrence.publicId } });
  }

  function startSnooze(reminder: Reminder) {
    if (!canSelect) return;
    resetMessages();
    snoozeMinutes = 15;
    snooze = reminder;
  }

  function runSnooze() {
    if (!snooze?.occurrence || busy) return;
    const snoozeUntil = Math.max(Date.now(), snooze.occurrence.triggerAt) + snoozeMinutes * minuteMs;
    void apply({ kind: 'snooze', args: { workspaceId, operationId: crypto.randomUUID(), publicId: snooze.publicId,
      expectedRevision: snooze.revision, occurrencePublicId: snooze.occurrence.publicId, snoozeUntil } });
  }

  async function apply(write: ReminderWrite) {
    if (disabled || pending) return;
    attempt = write;
    pending = true;
    resetMessages();
    try {
      const receipt = await client.mutation(remindersApi[write.kind], write.args);
      if (!alive) return;
      attempt = undefined;
      if (write.kind === 'remove') selectedId = undefined;
      if (write.kind === 'create') selectedId = receipt.targetPublicId;
      await closeAction();
      if (alive) notice = resultMessages[write.kind];
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') onUnauthenticated();
      else if (!code) writeError = 'Could not confirm the change. Retry to check the same operation.';
      else {
        attempt = undefined;
        const changed = ['REVISION_CONFLICT', 'REMINDER_UNAVAILABLE', 'OCCURRENCE_UNAVAILABLE', 'INVALID_STATE'].includes(code);
        if (changed && write.kind === 'update') review = conflictRevision(reason) ?? null;
        else if (changed) void closeAction();
        writeError = changed ? 'This reminder changed elsewhere. Review its latest state.' :
          code === 'TASK_UNAVAILABLE' ? 'This task is no longer available. Select another task or unlink it.' :
          'The workspace rejected the reminder change. Check your settings or access.';
      }
    } finally {
      if (alive) pending = false;
    }
  }
</script>

<svelte:window onfocus={() => { if (tab === 'due') updateClock(); }} />

{#snippet reminderRow(reminder: Reminder)}
  <li class="reminder-row">
    <div>
      <button class="reminder-title" aria-current={selectedId === reminder.publicId ? 'true' : undefined}
        disabled={!canSelect} onclick={() => void open(reminder.publicId)}>{reminder.title}</button>
      <div>{dateLabel(reminder.snoozeUntil ?? reminder.dueAt, reminder.timezone)}</div>
      <div class="reminder-statuses">
        <span>{reminder.dormant ? 'Dormant' : occurrenceStates[reminder.state]}</span>
        {#if reminder.overdue}<span class="reminder-overdue">Overdue</span>{/if}
        {#if reminder.recurrence}<span>Repeating</span>{/if}
      </div>
    </div>
    {#if reminder.taskPublicId}
      <button disabled={dirty || disabled} onclick={() => { if (reminder.taskPublicId) onOpenTask(reminder.taskPublicId); }}>Open linked task</button>
    {/if}
  </li>
{/snippet}

<section class="reminders-view" aria-label="Reminders" bind:this={container}>
  <header class="reminder-heading">
    <h2>Reminders</h2>
    <button bind:this={newButton} disabled={!canSelect} onclick={() => void startEdit()}>New reminder</button>
  </header>
  <nav class="reminder-actions" aria-label="Reminder views">
    {#each Object.entries(tabs) as [key, value] (key)}
      <button aria-pressed={tab === key} disabled={!canSelect} onclick={() => changeTab(key as Tab)}>{value}</button>
    {/each}
  </nav>

  <div class="reminder-notices">
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if writeError}<p role="alert">{writeError}</p>{/if}
    {#if attempt && !pending}
      <button disabled={disabled} onclick={() => { if (attempt) void apply(attempt); }}>Retry reminder change</button>
    {/if}
    {#if review !== undefined && edit?.original && selected}
      <button disabled={busy || selected.revision < (review ?? edit.original.revision + 1)} onclick={reviewLatest}>Review latest reminder</button>
    {/if}
  </div>

  {#if edit}
    <ReminderEditor {client} {workspaceId} bind:draft={edit.values} editing={Boolean(edit.original)} blocked={busy}
      reviewRequired={review !== undefined} canSave={Boolean(!edit.original || edited)} onSave={save}
      onCancel={() => { resetMessages(); void closeAction(); }} {onUnauthenticated} />
  {:else if selectedId}
    <section class="reminder-detail" aria-label="Reminder details">
      <h3 tabindex="-1" bind:this={detailHeading}>{selected?.title ?? 'Reminder details'}</h3>
      {#if readErrors.detail}
        <p role="alert">Could not load this reminder.</p><button onclick={() => { readAttempts.detail++; }}>Retry loading reminder</button>
      {:else if selected === null}<p>This reminder is no longer available.</p>
      {:else if selected && selected.publicId === selectedId}
        <p>{dateLabel(selected.snoozeUntil ?? selected.dueAt, selected.timezone)} · {selected.dormant ? 'Dormant' : occurrenceStates[selected.state]}</p>
        {#if selected.dormant}<p>Activate this reminder to create its next occurrence.</p>{/if}
        {#if selected.description}<p class="reminder-description">{selected.description}</p>{/if}
        {#if selected.recurrence}
          <p>{selected.recurrence.kind === 'interval' ? `Every ${selected.recurrence.everySeconds} seconds` :
            selected.recurrence.kind === 'monthly' ? `Monthly on day ${selected.recurrence.day}` :
            selected.recurrence.kind === 'weekly' ? `Weekly on ${selected.recurrence.weekdays.map(day => weekdays[day]).join(', ')}` :
              'Daily'}{selected.recurrenceBasis === 'legacy_utc' && selected.recurrence.kind !== 'interval' ? ' · legacy UTC cadence' : ''}</p>
        {/if}
        {#if selected.taskPublicId}
          <button disabled={dirty || disabled} onclick={() => { if (selected?.taskPublicId) onOpenTask(selected.taskPublicId); }}>
            {linkedTask ? `Open ${linkedTask.title}` : 'Open linked task'}
          </button>
        {/if}
        {#if confirmation}
          <div class="reminder-confirmation" role="group" aria-label={actions[confirmation.kind].label}>
            <p>{actions[confirmation.kind].explanation}</p>
            <div class="reminder-actions">
              <button disabled={busy} onclick={runConfirmation}>{actions[confirmation.kind].confirm}</button>
              <button disabled={busy} onclick={() => void closeAction()}>Cancel</button>
            </div>
          </div>
        {:else if snooze}
          <form class="reminder-confirmation" aria-label="Snooze reminder" onsubmit={event => { event.preventDefault(); runSnooze(); }}>
            <label>Delay after the current due time or now, whichever is later
              <select bind:value={snoozeMinutes} disabled={busy}>
                {#each delayOptions as value (value)}<option {value}>{value} minutes</option>{/each}
              </select>
            </label>
            <div class="reminder-actions">
              <button type="submit" disabled={busy}>Confirm snooze</button>
              <button type="button" disabled={busy} onclick={() => void closeAction()}>Cancel</button>
            </div>
          </form>
        {:else}
          <div class="reminder-actions">
            <button disabled={!canSelect} onclick={() => { if (selected) void startEdit(selected); }}>Edit reminder</button>
            {#if selected.dormant}
              <button disabled={!canSelect} onclick={() => { if (selected) startAction('activate', selected); }}>{actions.activate.label}</button>
            {/if}
            {#if selected.occurrence}
              <button disabled={!canSelect} onclick={() => { if (selected) startSnooze(selected); }}>Snooze reminder</button>
              <button disabled={!canSelect} onclick={() => { if (selected) startAction('dismiss', selected); }}>{actions.dismiss.label}</button>
              <button disabled={!canSelect} onclick={() => { if (selected) startAction('complete', selected); }}>{actions.complete.label}</button>
            {/if}
            <button disabled={!canSelect} onclick={() => { if (selected) startAction('remove', selected); }}>{actions.remove.label}</button>
          </div>
        {/if}
      {:else}<p role="status">Loading reminder…</p>{/if}
      {#if !confirmation && !snooze}
        <button disabled={!canSelect} onclick={() => { selectedId = undefined; resetMessages(); }}>Close reminder</button>
      {/if}
    </section>
  {/if}

  {#if readErrors[tab]}
    <p role="alert">Could not load {tabs[tab].toLowerCase()}.</p><button onclick={() => { readAttempts[tab]++; }}>Retry loading</button>
  {:else if tab === 'history'}
    {#if history?.page.length}
      <ul class="reminder-list">
        {#each history.page as item (item.publicId)}
          <li class="reminder-row">
            <div>
              {#if item.reminderPublicId}
                <button class="reminder-title" disabled={!canSelect} onclick={() => { if (item.reminderPublicId) void open(item.reminderPublicId); }}>
                  {item.reminderTitle ?? 'Reminder'}
                </button>
              {:else}<strong>{item.reminderTitle ?? 'Reminder'}</strong>{/if}
              <div>{dateLabel(item.triggerAt, item.timezone)} · {occurrenceStates[item.state]}</div>
              {#if deliveryLabels[item.deliveryState]}<div>{deliveryLabels[item.deliveryState]}</div>{/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if history}<p>No occurrence history yet.</p>
    {:else}<p role="status">Loading occurrence history…</p>{/if}
  {:else}
    {@const rows = tab === 'due' ? upcoming?.items : list?.page}
    {#if rows?.length}
      <ul class="reminder-list">{#each rows as reminder (reminder.publicId)}{@render reminderRow(reminder)}{/each}</ul>
    {:else if rows}<p>{tab === 'due' ? 'No reminders due.' : 'No reminders yet.'}</p>
    {:else}<p role="status">Loading reminders…</p>{/if}
    {#if tab === 'due' && upcoming?.partial}<p>Showing part of the due list. View all reminders for more.</p>{/if}
  {/if}
  {#if tab !== 'due' && page && (cursors.length > 1 || !page.isDone)}
    <div class="reminder-actions" role="group" aria-label="Reminder pages">
      <button disabled={!canSelect || cursors.length === 1} onclick={() => changePage(-1)}>Previous page</button>
      <button disabled={!canSelect || page.isDone} onclick={() => changePage(1)}>Next page</button>
    </div>
  {/if}

  <DeliverySettings {client} {workspaceId} {workspacePublicId} disabled={disabled || dirty && !deliveryDirty}
    {onUnauthenticated} onDirtyChange={value => { deliveryDirty = value; }} />
</section>
