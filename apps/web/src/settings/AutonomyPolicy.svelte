<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { onDestroy, untrack } from 'svelte';
  import { errorCode, pageSize } from '../contracts';
  import { recoverDraft } from '../draft-recovery';
  import { projectsApi, type Page, type Project } from '../projects/contracts';

  type Item = { publicId: string; name: string };
  type Window = { weekday: number; startMinute: number; endMinute: number };
  type Scope = { kind: 'all' | 'work' | 'personal' } | { kind: 'projects'; projectPublicIds: string[] };
  type Policy = {
    planApplication: 'automatic' | 'review';
    schedule: Window[];
    scope: Scope;
    excludedTaskPublicIds: string[];
    excludedProjectPublicIds: string[];
  };
  type Snapshot = { revision: number; timezone: string; policy: Policy; taskNames: Item[]; projectNames: Item[] };
  type Save = { workspaceId: string; policy: Policy; expectedRevision: number; operationId: string };
  const get = makeFunctionReference<'query', { workspaceId: string }, Snapshot>('autonomy:get');
  const update = makeFunctionReference<'mutation', Save, { revision: number }>('autonomy:update');
  const searchTasks = makeFunctionReference<'query', { workspaceId: string; title: string }, Item[]>('autonomy:searchTasks');
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  let { client, workspaceId, disabled, onDirtyChange, onUnauthenticated }: {
    client: ConvexClient;
    workspaceId: string;
    disabled: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onUnauthenticated: () => void;
  } = $props();

  let snapshot = $state.raw<Snapshot>();
  let draft = $state<Policy>();
  let baseRevision = $state(0);
  let savedRevision = $state<number>();
  let attempt = $state.raw<Save>();
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let loadError = $state(false);
  let refresh = $state(0);
  let projectCursor = $state<string | null>(null);
  let projects = $state.raw<Page<Project>>();
  let projectError = $state(false);
  let projectRefresh = $state(0);
  let selectedTaskNames = $state.raw<Item[]>([]);
  let selectedProjectNames = $state.raw<Item[]>([]);
  let taskQuery = $state('');
  let taskResults = $state.raw<Item[]>();
  let searchError = $state(false);
  let alive = true;
  const restored = recoverDraft('autonomy-policy', () => draft ? {
    draft: $state.snapshot(draft), baseRevision, savedRevision, attempt,
    selectedTaskNames, selectedProjectNames, taskQuery,
  } : undefined);
  if (restored) {
    draft = restored.draft;
    baseRevision = restored.baseRevision;
    savedRevision = restored.savedRevision;
    attempt = restored.attempt;
    selectedTaskNames = restored.selectedTaskNames;
    selectedProjectNames = restored.selectedProjectNames;
    taskQuery = restored.taskQuery;
  }
  onDestroy(() => {
    alive = false;
    onDirtyChange(false);
  });

  const editingDisabled = $derived(disabled || busy || Boolean(attempt));
  const stale = $derived(Boolean(draft && savedRevision === undefined && snapshot && snapshot.revision !== baseRevision));
  $effect(() => {
    const dirty = Boolean(draft);
    untrack(() => onDirtyChange(dirty));
  });

  function authFailure(reason: unknown) {
    if (alive && errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
  }

  $effect(() => {
    void refresh;
    loadError = false;
    return client.onUpdate(get, { workspaceId }, value => {
      snapshot = value;
      loadError = false;
      if (savedRevision !== undefined && value.revision >= savedRevision) {
        savedRevision = undefined;
        draft = undefined;
      }
    }, reason => {
      loadError = true;
      authFailure(reason);
    });
  });

  $effect(() => {
    if (!draft) return;
    void projectRefresh;
    projects = undefined;
    projectError = false;
    return client.onUpdate(projectsApi.projects, { workspaceId, paginationOpts: { cursor: projectCursor, numItems: pageSize } },
      value => { projects = value; projectError = false; },
      reason => { projectError = true; authFailure(reason); });
  });

  $effect(() => {
    const title = taskQuery.trim();
    taskResults = undefined;
    searchError = false;
    if (!draft || title.length < 2) return;
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => {
      cancel = client.onUpdate(searchTasks, { workspaceId, title },
        value => { taskResults = value; searchError = false; },
        reason => { searchError = true; authFailure(reason); });
    }, 250);
    return () => { clearTimeout(timer); cancel?.(); };
  });

  function edit() {
    if (!snapshot) return;
    draft = structuredClone(snapshot.policy);
    baseRevision = snapshot.revision;
    selectedTaskNames = snapshot.taskNames;
    selectedProjectNames = snapshot.projectNames;
    projectCursor = null;
    taskQuery = error = notice = '';
  }

  function cancelEdit() {
    attempt = undefined;
    draft = undefined;
    error = '';
  }

  function setScope(kind: Scope['kind']) {
    if (draft) draft.scope = kind === 'projects' ? { kind, projectPublicIds: [] } : { kind };
  }

  function addProject(id: string, exclusion: boolean) {
    const project = projects?.page.find(item => item.publicId === id);
    if (!draft || !project) return;
    const ids = exclusion ? draft.excludedProjectPublicIds :
      draft.scope.kind === 'projects' ? draft.scope.projectPublicIds : [];
    if (ids.includes(id)) return;
    ids.push(id);
    selectedProjectNames = [...selectedProjectNames.filter(item => item.publicId !== id), { publicId: id, name: project.name }];
  }

  function addTask(task: Item) {
    if (!draft || draft.excludedTaskPublicIds.includes(task.publicId)) return;
    draft.excludedTaskPublicIds.push(task.publicId);
    selectedTaskNames = [...selectedTaskNames.filter(item => item.publicId !== task.publicId), task];
    taskQuery = '';
  }

  function clockValue(minute: number) {
    return [Math.floor((minute % 1440) / 60), minute % 60].map(value => String(value).padStart(2, '0')).join(':');
  }

  function parseTime(value: string, end: boolean) {
    const [hour, minute] = value.split(':').map(Number);
    const result = hour * 60 + minute;
    return end && result === 0 ? 1440 : result;
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!draft || disabled || busy || (stale && !attempt) || savedRevision !== undefined) return;
    busy = true;
    notice = error = '';
    attempt ??= { workspaceId, operationId: crypto.randomUUID(), expectedRevision: baseRevision, policy: $state.snapshot(draft) };
    try {
      const result = await client.mutation(update, attempt);
      if (!alive) return;
      attempt = undefined;
      if (snapshot && snapshot.revision >= result.revision) draft = undefined;
      else savedRevision = result.revision;
      notice = 'Planning policy saved.';
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code) attempt = undefined;
      authFailure(reason);
      error = code === 'REVISION_CONFLICT' ? 'Planning settings changed. Reload the latest policy before saving.' :
        code === 'INVALID_ARGUMENT' ? 'Check your project selection, exclusions and overlapping run hours.' :
        code ? 'The workspace rejected the planning policy.' : 'Could not confirm the save. Retry to check the same update.';
    } finally {
      if (alive) busy = false;
    }
  }
</script>

{#snippet selectedList(ids: string[], names: Item[], remove: (id: string) => void)}
  {#if ids.length}
    <ul class="selection">
      {#each ids as id (id)}
        {@const name = names.find(item => item.publicId === id)?.name ?? id}
        <li><span>{name}</span>
          <button type="button" aria-label={`Remove ${name}`} onclick={() => remove(id)}>Remove</button></li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#snippet projectPicker(label: string, ids: string[], exclusion: boolean)}
  <label>{label}
    <select value="" disabled={projectError || !projects} onchange={event => {
      addProject(event.currentTarget.value, exclusion);
      event.currentTarget.value = '';
    }}>
      <option value="">Select a project</option>
      {#each projects?.page ?? [] as project (project.publicId)}
        <option value={project.publicId} disabled={ids.includes(project.publicId)}>
          {project.name}{project.area ? ` · ${project.area}` : ''}
        </option>
      {/each}
    </select>
  </label>
{/snippet}

<section class="settings" aria-labelledby="autonomy-heading">
  <h2 id="autonomy-heading">Planning autonomy</h2>
  {#if loadError}
    <p role="alert">Could not load the planning policy.</p>
    <button type="button" disabled={disabled} onclick={() => refresh++}>Retry loading policy</button>
  {:else if !snapshot}
    <p role="status">Loading planning policy…</p>
  {:else if draft}
    <form onsubmit={save}>
      <fieldset disabled={editingDisabled || savedRevision !== undefined}>
        <legend>Agent planning policy</legend>
        <label>Plan application
          <select bind:value={draft.planApplication}>
            <option value="automatic">Apply automatically</option>
            <option value="review">Require owner approval</option>
          </select>
        </label>
        <label>Planning scope
          <select value={draft.scope.kind} onchange={event => setScope(event.currentTarget.value as Scope['kind'])}>
            <option value="all">All tasks</option>
            <option value="work">Work projects</option>
            <option value="personal">Personal projects</option>
            <option value="projects">Selected projects</option>
          </select>
        </label>
        {#if draft.scope.kind === 'projects'}
          {@render projectPicker('Include projects', draft.scope.projectPublicIds, false)}
          {@render selectedList(draft.scope.projectPublicIds, selectedProjectNames, id => {
            if (draft?.scope.kind === 'projects') draft.scope.projectPublicIds = draft.scope.projectPublicIds.filter(item => item !== id);
          })}
        {/if}
        {@render projectPicker('Exclude projects', draft.excludedProjectPublicIds, true)}
        {@render selectedList(draft.excludedProjectPublicIds, selectedProjectNames, id => {
          if (draft) draft.excludedProjectPublicIds = draft.excludedProjectPublicIds.filter(item => item !== id);
        })}
        {#if projectError}
          <p role="alert">Could not load projects.</p>
          <button type="button" onclick={() => projectRefresh++}>Retry loading projects</button>
        {:else if projectCursor || (projects && !projects.isDone)}
          <div class="actions">
            <button type="button" disabled={!projectCursor} onclick={() => projectCursor = null}>First projects</button>
            <button type="button" disabled={!projects || projects.isDone}
              onclick={() => { if (projects) projectCursor = projects.continueCursor; }}>More projects</button>
          </div>
        {/if}
        <label>Exclude individual tasks
          <input type="search" maxlength="100" bind:value={taskQuery} placeholder="Search task titles" />
        </label>
        {#if searchError}
          <p role="alert">Could not search tasks.</p>
        {:else if taskResults?.length === 0}
          <p role="status">No matching tasks.</p>
        {:else if taskResults}
          <ul class="selection">
            {#each taskResults as task (task.publicId)}
              <li><button type="button" disabled={draft.excludedTaskPublicIds.includes(task.publicId)}
                onclick={() => addTask(task)}>Exclude {task.name}</button></li>
            {/each}
          </ul>
        {/if}
        {@render selectedList(draft.excludedTaskPublicIds, selectedTaskNames, id => {
          if (draft) draft.excludedTaskPublicIds = draft.excludedTaskPublicIds.filter(item => item !== id);
        })}
        <fieldset>
          <legend>Automatic run hours</legend>
          <p>Times use {snapshot.timezone}. Leave the list empty to allow automatic runs at any time.</p>
          {#each draft.schedule as window, index (window)}
            <div class="window">
              <label>Day
                <select bind:value={window.weekday}>
                  {#each days as day, index (day)}<option value={index}>{day}</option>{/each}
                </select>
              </label>
              <label>Start
                <input type="time" required value={clockValue(window.startMinute)}
                  onchange={event => window.startMinute = parseTime(event.currentTarget.value, false)} />
              </label>
              <label>End
                <input type="time" required value={clockValue(window.endMinute)}
                  onchange={event => window.endMinute = parseTime(event.currentTarget.value, true)} />
              </label>
              <button type="button" aria-label={`Remove run window ${index + 1}`}
                onclick={() => draft?.schedule.splice(index, 1)}>Remove</button>
            </div>
          {/each}
          <button type="button" disabled={draft.schedule.length >= 56}
            onclick={() => draft?.schedule.push({ weekday: 0, startMinute: 540, endMinute: 1020 })}>Add run window</button>
        </fieldset>
      </fieldset>
      {#if stale && !attempt}<p role="alert">Planning settings changed while you were editing.</p>{/if}
      {#if error}<p role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={disabled || busy || (stale && !attempt) || savedRevision !== undefined}>
          {attempt ? 'Retry save' : 'Save planning policy'}
        </button>
        {#if stale && !attempt}
          <button type="button" disabled={busy} onclick={edit}>Reload current policy</button>
        {/if}
        <button type="button" disabled={busy || savedRevision !== undefined} onclick={cancelEdit}>Cancel</button>
      </div>
    </form>
  {:else}
    <p>{snapshot.policy.planApplication === 'automatic' ? 'Authorized agents may apply plans automatically.' : 'Agent plans require owner approval.'}</p>
    <button type="button" disabled={disabled} onclick={edit}>Edit planning policy</button>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</section>

<style>
  .settings { max-width: 46rem; display: grid; gap: .75rem; margin-bottom: 2rem; }
  h2, p { margin: 0; }
  form, fieldset { display: grid; gap: .75rem; min-inline-size: 0; }
  fieldset { border: 1px solid var(--border, currentColor); border-radius: .5rem; padding: .875rem; }
  label { display: grid; gap: .25rem; }
  select, input, button { min-height: 44px; max-width: 100%; }
  .actions, .window { display: flex; flex-wrap: wrap; gap: .5rem; align-items: end; }
  .selection { display: grid; gap: .25rem; margin: 0; padding: 0; list-style: none; }
  .selection li { display: flex; justify-content: space-between; gap: .5rem; align-items: center; overflow-wrap: anywhere; }
</style>
