<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import { untrack } from 'svelte';
  import { api, errorCode, type Task } from '../contracts';
  import { priorities, remindersApi, weekdays } from './reminder-contract';
  import { zoneClock, type ReminderDraft } from './reminder-draft';

  let { client, workspaceId, draft = $bindable(), editing, blocked, reviewRequired, canSave, onSave, onCancel,
    onUnauthenticated }: {
    client: ConvexClient; workspaceId: string; draft: ReminderDraft; editing: boolean; blocked: boolean;
    reviewRequired: boolean; canSave: boolean; onSave: () => void; onCancel: () => void; onUnauthenticated: () => void;
  } = $props();
  const id = $props.id();
  let taskQuery = $state('');
  let linkedTask = $state.raw<Task | null>();
  let results = $state.raw<Task[]>();
  let queryError = $state(false);
  const term = $derived(taskQuery.trim());
  const clock = $derived(zoneClock(draft.timezone.trim()));
  const folds = $derived(clock?.candidates(draft.due) ?? []);
  const label = $derived(editing ? 'Edit reminder' : 'New reminder');

  $effect(() => {
    const publicId = draft.taskPublicId;
    linkedTask = undefined;
    if (!publicId) return;
    let active = true;
    const stop = client.onUpdate(api.getTask, { workspaceId, publicId }, result => {
      if (active) linkedTask = result;
    }, error => {
      if (!active) return;
      if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated();
      else linkedTask = null;
    });
    return () => { active = false; stop(); };
  });

  $effect(() => {
    results = undefined;
    queryError = false;
    if (!term || draft.taskPublicId) return;
    const text = term;
    const source = client;
    const args = { workspaceId, text };
    let active = true;
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      stop = source.onUpdate(remindersApi.search, args, result => {
        if (active) results = result.tasks.filter(task => task.status !== 'archived');
      }, error => {
        if (!active) return;
        if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated();
        else queryError = true;
      });
    }, 160);
    return () => { active = false; window.clearTimeout(timer); stop?.(); };
  });

  function zoneOrTimeChanged() { draft.fold = 0; }

  function link(task: Task) {
    taskQuery = '';
    draft.taskPublicId = task.publicId;
    untrack(() => { linkedTask = task; });
  }
</script>

<form class="reminder-editor" aria-label={label} onsubmit={event => { event.preventDefault(); onSave(); }}>
  <h3>{label}</h3>
  <fieldset disabled={blocked}>
    <label for={`${id}-title`}>Title</label>
    <input id={`${id}-title`} data-reminder-editor-title bind:value={draft.title} maxlength="256" required />
    <label for={`${id}-description`}>Description</label>
    <textarea id={`${id}-description`} bind:value={draft.description} maxlength="8000" rows="2"></textarea>
    <div class="reminder-fields">
      <label>Due date and time<input type="datetime-local" step="any" required bind:value={draft.due} oninput={zoneOrTimeChanged} /></label>
      <label>Time zone<input bind:value={draft.timezone} oninput={zoneOrTimeChanged} required spellcheck="false" maxlength="100" /></label>
      {#if folds.length > 1}
        <label>Time occurrence<select bind:value={draft.fold}>
          {#each folds as instant, index (instant)}
            <option value={index}>{index === 0 ? 'First' : 'Second'} · {clock?.label(instant)}</option>
          {/each}
        </select></label>
      {/if}
      <label>Priority<select bind:value={draft.priority}>
        {#each priorities as priority (priority)}<option value={priority}>{priority[0].toUpperCase() + priority.slice(1)}</option>{/each}
      </select></label>
      <label>Repeat<select bind:value={draft.kind}>
        <option value="once">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
        <option value="monthly">Monthly</option><option value="interval">Fixed interval</option>
      </select></label>
      {#if draft.kind === 'monthly'}
        <label>Day of month<input type="number" min="1" max="31" step="1" bind:value={draft.day} required /></label>
      {:else if draft.kind === 'interval'}
        <label>Interval in seconds<input type="number" min="1" step="1" bind:value={draft.everySeconds} required /></label>
      {/if}
    </div>
    {#if draft.kind === 'weekly'}
      <fieldset class="reminder-weekdays">
        <legend>Repeat on</legend>
        {#each weekdays as weekday, day (weekday)}
          <label><input type="checkbox" value={day} bind:group={draft.weekdays} /> {weekday}</label>
        {/each}
      </fieldset>
    {/if}
    {#if draft.taskPublicId}
      <div class="reminder-actions"><span>{linkedTask?.title ?? 'Linked task'}</span><button type="button" onclick={() => { draft.taskPublicId = ''; }}>Unlink task</button></div>
    {:else}
      <label for={`${id}-task`}>Find a task</label>
      <input id={`${id}-task`} type="search" maxlength="256" bind:value={taskQuery} autocomplete="off" />
      {#if queryError}<p role="alert">Could not search tasks.</p>
      {:else if results?.length}
        <ul class="reminder-task-results">
          {#each results as task (task.publicId)}<li><button type="button" onclick={() => link(task)}>{task.title}</button></li>{/each}
        </ul>
      {:else if results}<p>No matching tasks.</p>{/if}
    {/if}
    <div class="reminder-actions">
      <button type="submit" disabled={!canSave || reviewRequired}>Save reminder</button>
      <button type="button" onclick={onCancel}>Cancel</button>
    </div>
  </fieldset>
</form>
