<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';
  import { errorCode, pageSize, taskStatuses, titleLimit } from '../contracts';
  import {
    projectsApi, type Command, type LanePage, type Page, type Project, type ProjectPatch,
    type ProjectsProps, type ProjectTask, type Write,
  } from './contracts';

  let { client, workspaceId, disabled = false, onOpenTask, onUnauthenticated, onDirtyChange }: ProjectsProps = $props();
  const id = $props.id();
  type Read = 'projects' | 'tasks' | 'lanes';
  type Draft = { original?: Project; name: string; area: string };
  let projects = $state.raw<Page<Project>>();
  let tasks = $state.raw<Page<ProjectTask>>();
  let lanes = $state.raw<LanePage>();
  let projectCursors = $state<(string | null)[]>([null]);
  let taskCursors = $state<(string | null)[]>([null]);
  let projectId = $state<string>();
  let board = $state(false);
  let draft = $state<Draft>();
  let showLaneEditor = $state(false);
  let laneName = $state('');
  let readErrors = $state<Partial<Record<Read, boolean>>>({});
  let readAttempts = $state({ projects: 0, tasks: 0, lanes: 0 });
  let pending = $state(false);
  let attempt = $state.raw<Write>();
  let writeError = $state('');
  let reviewRequired = $state(false);
  let confirmation = $state('');
  let projectInput = $state<HTMLInputElement>();
  let laneInput = $state<HTMLInputElement>();
  let projectPanel = $state<HTMLElement>();
  let projectHeading = $state<HTMLHeadingElement>();
  let createButton = $state<HTMLButtonElement>();
  let destroyed = false;

  const selected = $derived(projects?.page.find(project => project._id === projectId));
  const projectDirty = $derived(Boolean(draft && (draft.name !== (draft.original?.name ?? '') || draft.area !== (draft.original?.area ?? ''))));
  const dirty = $derived(projectDirty || Boolean(laneName || attempt));
  const canWrite = $derived(!disabled && !pending && !attempt);
  const rows = $derived(tasks?.page ?? []);
  const groups = $derived.by(() => {
    const byArea = new SvelteMap<string, Project[]>();
    for (const project of projects?.page ?? []) {
      const area = project.area?.trim() || 'No area';
      const label = area.toLowerCase() === 'work' ? 'Work' : area.toLowerCase() === 'personal' ? 'Personal' : area;
      const items = byArea.get(label) ?? [];
      items.push(project);
      byArea.set(label, items);
    }
    const rank = (area: string) => area === 'Work' ? 0 : area === 'Personal' ? 1 : 2;
    return [...byArea].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  });
  const otherLaneRows = $derived(board ? rows.filter(task => task.laneId && !lanes?.lanes.some(lane => lane._id === task.laneId)) : []);

  $effect(() => {
    const value = dirty;
    const report = onDirtyChange;
    untrack(() => report?.(value));
  });

  onDestroy(() => {
    destroyed = true;
    onDirtyChange?.(false);
  });

  function watch<Query extends FunctionReference<'query'>>(
    reference: Query, args: FunctionArgs<Query>, name: Read, receive: (value: FunctionReturnType<Query>) => void,
  ) {
    readErrors[name] = false;
    let active = true;
    const stop = client.onUpdate(reference, args, result => {
      if (!active) return;
      receive(result);
      readErrors[name] = false;
    }, error => {
      if (!active) return;
      if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated?.();
      else readErrors[name] = true;
    });
    return () => {
      active = false;
      stop();
    };
  }

  $effect(() => {
    void readAttempts.projects;
    projects = undefined;
    return watch(projectsApi.projects, { workspaceId, paginationOpts: { cursor: projectCursors.at(-1) ?? null, numItems: pageSize } },
      'projects', result => { projects = result; });
  });

  $effect(() => {
    void readAttempts.tasks;
    tasks = undefined;
    if (!projectId) return;
    return watch(projectsApi.tasks, { workspaceId, filter: { kind: 'project', projectId },
      paginationOpts: { cursor: taskCursors.at(-1) ?? null, numItems: pageSize } }, 'tasks', result => { tasks = result; });
  });

  $effect(() => {
    void readAttempts.lanes;
    lanes = undefined;
    if (!projectId || !board) return;
    return watch(projectsApi.lanes, { workspaceId, projectId }, 'lanes', result => { lanes = result; });
  });

  function chooseProject(project: Project) {
    if (dirty || project._id === projectId) return;
    draft = undefined;
    showLaneEditor = false;
    board = false;
    projectId = project._id;
    taskCursors = [null];
    writeError = '';
    confirmation = '';
    void tick().then(() => projectHeading?.focus());
  }

  function changePage(kind: 'projects' | 'tasks', direction: -1 | 1) {
    if (dirty || disabled) return;
    const cursors = kind === 'projects' ? projectCursors : taskCursors;
    const result = kind === 'projects' ? projects : tasks;
    if (direction < 0 && cursors.length === 1 || direction > 0 && (!result || result.isDone)) return;
    const next = direction < 0 ? cursors.slice(0, -1) : [...cursors, result?.continueCursor ?? null];
    if (kind === 'projects') {
      projectId = undefined;
      draft = undefined;
      showLaneEditor = false;
      board = false;
      projectCursors = next;
    } else {
      taskCursors = next;
    }
  }

  function openProjectEditor(original: Project | undefined) {
    if (!canWrite || dirty) return;
    draft = { original, name: original?.name ?? '', area: original?.area ?? '' };
    showLaneEditor = false;
    writeError = '';
    reviewRequired = false;
    confirmation = '';
    void tick().then(() => projectInput?.focus());
  }

  function cancelProjectEditor() {
    const editingExisting = Boolean(draft?.original);
    draft = undefined;
    writeError = '';
    reviewRequired = false;
    void tick().then(() => (editingExisting ? projectHeading : createButton)?.focus());
  }

  function saveProject(event: SubmitEvent) {
    event.preventDefault();
    if (!draft || !canWrite || reviewRequired) return;
    const { original } = draft;
    const name = draft.name.trim();
    const area = draft.area.trim();
    if (!name) return;
    if (!original) {
      change({ kind: 'project.create', publicId: crypto.randomUUID(), name, ...(area ? { area } : {}) });
      return;
    }
    const patch: ProjectPatch = {};
    if (name !== original.name) patch.name = name;
    if (draft.area !== (original.area ?? '')) patch.area = area || null;
    if (Object.keys(patch).length) change({ kind: 'project.update', publicId: original.publicId, expectedRevision: original.revision, patch });
  }

  function reviewLatestProject() {
    if (!draft?.original || !selected || selected.publicId !== draft.original.publicId || !canWrite) return;
    const original = draft.original;
    draft = {
      original: selected,
      name: draft.name === original.name ? selected.name : draft.name,
      area: draft.area === (original.area ?? '') ? selected.area ?? '' : draft.area,
    };
    writeError = '';
    reviewRequired = false;
  }

  function newLane() {
    if (!canWrite || dirty || !selected || selected.archivedAt !== undefined) return;
    draft = undefined;
    showLaneEditor = true;
    confirmation = '';
    void tick().then(() => laneInput?.focus());
  }

  function saveLane(event: SubmitEvent) {
    event.preventDefault();
    const name = laneName.trim();
    if (!canWrite || !selected || selected.archivedAt !== undefined || !name) return;
    void apply({ kind: 'lane', args: { workspaceId, projectId: selected._id, name,
      operationId: crypto.randomUUID(), publicId: crypto.randomUUID() } });
  }

  function moveTask(event: Event & { currentTarget: HTMLSelectElement }, task: ProjectTask) {
    const laneId = event.currentTarget.value;
    const previous = task.laneId ?? '';
    event.currentTarget.value = previous;
    if (!canWrite || dirty || laneId === previous || task.status === 'archived' || selected?.archivedAt !== undefined) return;
    change({ kind: 'task.update', publicId: task.publicId, expectedRevision: task.revision, patch: { laneId: laneId || null } });
  }

  function change(command: Command) {
    if (!canWrite) return;
    void apply({ kind: 'taskDomain', args: { workspaceId, operationId: crypto.randomUUID(), command } });
  }

  async function apply(write: Write) {
    if (disabled || pending || write.args.workspaceId !== workspaceId) return;
    pending = true;
    attempt = write;
    writeError = '';
    reviewRequired = false;
    confirmation = '';
    try {
      if (write.kind === 'lane') await client.mutation(projectsApi.createLane, write.args);
      else await client.mutation(projectsApi.change, write.args);
      if (destroyed) return;
      const messages = {
        'project.create': 'Project created.', 'project.update': 'Project updated.', 'project.archive': 'Project archived.',
        'project.restore': 'Project restored.', 'task.update': 'Task moved.',
      };
      attempt = undefined;
      if (write.kind === 'lane') {
        confirmation = 'Lane added.';
        laneName = '';
        showLaneEditor = false;
      } else {
        confirmation = messages[write.args.command.kind];
        draft = undefined;
        if (write.args.command.kind === 'task.update') void restoreMoveFocus(write.args.command.publicId);
      }
    } catch (error) {
      if (destroyed) return;
      const code = errorCode(error);
      if (code === 'UNAUTHENTICATED') onUnauthenticated?.();
      else if (code) {
        attempt = undefined;
        const changed = code === 'REVISION_CONFLICT' || code === 'NOT_FOUND' || code === 'INVALID_STATE';
        reviewRequired = changed && write.kind === 'taskDomain' && write.args.command.kind === 'project.update';
        writeError = changed ? 'This item changed elsewhere. Review its latest state.' : 'The workspace rejected the change.';
      }
    } finally {
      if (!destroyed) pending = false;
    }
  }

  async function restoreMoveFocus(publicId: string) {
    await tick();
    if (destroyed || document.activeElement !== document.body) return;
    const control = projectPanel?.querySelector<HTMLSelectElement>(`select[data-move-task="${CSS.escape(publicId)}"]:enabled`);
    (control ?? projectHeading)?.focus();
  }
</script>

{#snippet taskRow(task: ProjectTask)}
  <li class="task-row">
    <button class="item" onclick={() => onOpenTask(task.publicId)} disabled={dirty}>{task.title}</button>
    <small>{taskStatuses[task.status]}</small>
    {#if board && lanes && task.status !== 'archived' && selected?.archivedAt === undefined}
      <select data-move-task={task.publicId} aria-label={`Move ${task.title} to lane`} value={task.laneId ?? ''} disabled={!canWrite || dirty}
        onchange={event => moveTask(event, task)}>
        <option value="">No lane</option>
        {#if task.laneId && !lanes.lanes.some(lane => lane._id === task.laneId)}
          <option value={task.laneId} disabled>Current lane</option>
        {/if}
        {#each lanes.lanes as lane (lane._id)}<option value={lane._id}>{lane.name}</option>{/each}
      </select>
    {/if}
  </li>
{/snippet}

{#snippet column(label: string, items: ProjectTask[])}
  <section class="lane" aria-label={label}>
    <h3>{label}</h3>
    {#if items.length}
      <ul>{#each items as task (task.publicId)}{@render taskRow(task)}{/each}</ul>
    {:else}
      <p class="muted">No tasks on this page.</p>
    {/if}
  </section>
{/snippet}

<section class="projects" aria-labelledby={`${id}-title`}>
  <header class="controls heading">
    <h1 id={`${id}-title`}>Projects</h1>
    <button bind:this={createButton} onclick={() => openProjectEditor(undefined)} disabled={!canWrite || dirty}>New project</button>
  </header>

  {#if attempt && !pending}
    {@const retry = attempt}
    <div class="notice">
      <p role="alert">Could not confirm the project change. You can safely retry it.</p>
      <div class="controls">
        <button onclick={() => apply(retry)} {disabled}>Retry project change</button>
        <button onclick={() => { attempt = undefined; }}>Discard retry</button>
      </div>
    </div>
  {:else if writeError}
    <div class="notice">
      <p role="alert">{writeError}</p>
      {#if reviewRequired && draft?.original && selected && selected.revision > draft.original.revision}
        <p>Latest project: {selected.name}{selected.area ? ` · ${selected.area}` : ''}</p>
        <button onclick={reviewLatestProject} disabled={!canWrite}>Use latest revision</button>
      {/if}
    </div>
  {/if}
  {#if pending || confirmation}<p role="status">{pending ? 'Saving…' : confirmation}</p>{/if}

  {#if draft}
    <form class="editor" onsubmit={saveProject}>
      <label for={`${id}-name`}>Project name</label>
      <input id={`${id}-name`} bind:this={projectInput} bind:value={draft.name} maxlength={titleLimit} required disabled={!canWrite} />
      <label for={`${id}-area`}>Area</label>
      <input id={`${id}-area`} bind:value={draft.area} list={`${id}-areas`} maxlength={titleLimit} disabled={!canWrite} />
      <datalist id={`${id}-areas`}><option value="Work"></option><option value="Personal"></option></datalist>
      <div class="controls">
        <button class="primary" disabled={!canWrite || !draft.name.trim() || !projectDirty || reviewRequired}>
          {draft.original ? 'Save project' : 'Create project'}
        </button>
        <button type="button" onclick={cancelProjectEditor} disabled={Boolean(attempt)}>Cancel</button>
      </div>
    </form>
  {/if}

  <div class="layout">
    <aside aria-label="Project directory" class="directory">
      {#if readErrors.projects}
        <p role="alert">Could not load projects.</p>
        <button onclick={() => { readAttempts.projects++; }} {disabled}>Retry loading projects</button>
      {:else if !projects}
        <p role="status">Loading projects…</p>
      {:else if !groups.length}
        <p>No projects on this page.</p>
      {:else}
        {#each groups as [area, items] (area)}
          <section>
            <h2>{area}</h2>
            <ul>
              {#each items as project (project.publicId)}
                <li class="project-row">
                  <button class="item" aria-pressed={project._id === projectId} onclick={() => chooseProject(project)} disabled={dirty}>{project.name}</button>
                  {#if project.archivedAt !== undefined}<small>Archived</small>{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      {/if}
      {#if projectCursors.length > 1 || (projects && !projects.isDone)}
        <nav class="controls" aria-label="Project pages">
          <button onclick={() => changePage('projects', -1)} disabled={disabled || dirty || projectCursors.length === 1}>Previous project page</button>
          <button onclick={() => changePage('projects', 1)} disabled={disabled || dirty || !projects || projects.isDone}>Next project page</button>
        </nav>
      {/if}
    </aside>

    {#if selected}
      <section class="project" aria-labelledby={`${id}-project`} bind:this={projectPanel}>
        <h2 id={`${id}-project`} tabindex="-1" bind:this={projectHeading}>{selected.name}</h2>
        <div class="controls">
          <button aria-pressed={!board} onclick={() => { board = false; showLaneEditor = false; }} disabled={dirty}>List</button>
          <button aria-pressed={board} onclick={() => { board = true; }} disabled={dirty}>Board</button>
          {#if selected.archivedAt === undefined}
            <button onclick={() => openProjectEditor(selected)} disabled={!canWrite || dirty}>Edit project</button>
            <button onclick={() => selected && change({ kind: 'project.archive', publicId: selected.publicId, expectedRevision: selected.revision })}
              disabled={!canWrite || dirty}>Archive project</button>
            {#if board}<button onclick={newLane} disabled={!canWrite || dirty}>New lane</button>{/if}
          {:else}
            <button onclick={() => selected && change({ kind: 'project.restore', publicId: selected.publicId, expectedRevision: selected.revision })}
              disabled={!canWrite || dirty}>Restore project</button>
          {/if}
        </div>

        {#if board && showLaneEditor}
          <form class="editor" onsubmit={saveLane}>
            <label for={`${id}-lane`}>Lane name</label>
            <input id={`${id}-lane`} bind:this={laneInput} bind:value={laneName} maxlength={titleLimit} required disabled={!canWrite} />
            <div class="controls">
              <button class="primary" disabled={!canWrite || !laneName.trim() || selected.archivedAt !== undefined}>Add lane</button>
              <button type="button" onclick={() => { laneName = ''; showLaneEditor = false; }} disabled={Boolean(attempt)}>Cancel</button>
            </div>
          </form>
        {/if}

        {#if readErrors.tasks}
          <p role="alert">Could not load project tasks.</p>
          <button onclick={() => { readAttempts.tasks++; }} {disabled}>Retry loading tasks</button>
        {:else if !tasks}
          <p role="status">Loading tasks…</p>
        {:else if board}
          {#if readErrors.lanes}
            <p role="alert">Could not load lanes.</p>
            <button onclick={() => { readAttempts.lanes++; }} {disabled}>Retry loading lanes</button>
          {:else if !lanes}
            <p role="status">Loading lanes…</p>
          {:else}
            {#if lanes.partial}<p class="muted">Showing the first {lanes.lanes.length} lanes.</p>{/if}
            <div class="board">
              {@render column('No lane', rows.filter(task => !task.laneId))}
              {#each lanes.lanes as lane (lane._id)}
                {@render column(lane.name, rows.filter(task => task.laneId === lane._id))}
              {/each}
              {#if otherLaneRows.length}{@render column('Other lanes', otherLaneRows)}{/if}
            </div>
          {/if}
        {:else if rows.length}
          <ul aria-label="Project tasks">{#each rows as task (task.publicId)}{@render taskRow(task)}{/each}</ul>
        {:else}
          <p>No tasks on this page.</p>
        {/if}

        {#if taskCursors.length > 1 || (tasks && !tasks.isDone)}
          <nav class="controls" aria-label="Project task pages">
            <button onclick={() => changePage('tasks', -1)} disabled={disabled || dirty || taskCursors.length === 1}>Previous task page</button>
            <button onclick={() => changePage('tasks', 1)} disabled={disabled || dirty || !tasks || tasks.isDone}>Next task page</button>
          </nav>
        {/if}
      </section>
    {/if}
  </div>
</section>

<style>
  .projects { min-inline-size: 0; overflow-wrap: anywhere; }
  h1, h2, h3 { margin: 0; line-height: 1.2; }
  h1 { font-size: clamp(1.55rem, 5vw, 2rem); }
  h2 { font-size: 1.25rem; }
  h3 { font-size: 1rem; }
  .heading { justify-content: space-between; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
  .layout, .board, .editor { display: grid; gap: 0.75rem; margin-block-start: 1rem; }
  .layout { grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); }
  .directory { display: grid; gap: 0.75rem; align-content: start; }
  .project { min-inline-size: 0; }
  .project h2 + .controls { margin-block-start: 0.75rem; }
  .editor { max-inline-size: 40rem; margin-block-end: 1rem; }
  .board { grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr)); }
  .lane { padding: 0.75rem; background: var(--planner-surface); border: 1px solid var(--planner-border); border-radius: var(--planner-radius); }
  .lane p { margin-block-end: 0; }
  ul { list-style: none; margin-block: 0.5rem; padding: 0; }
  .project-row, .task-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.65rem; border-block-end: 1px solid var(--planner-border); }
  .task-row select { max-inline-size: 100%; }
  button, input, select {
    box-sizing: border-box;
    min-block-size: var(--planner-target);
    min-inline-size: 0;
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--planner-control-border);
    border-radius: var(--planner-radius);
    color: var(--planner-text);
    background: var(--planner-surface);
    font: inherit;
  }
  button:not(:disabled) { cursor: pointer; }
  button:disabled, input:disabled, select:disabled { opacity: 0.65; }
  button[aria-pressed='true'] { background: var(--planner-surface-active); }
  .item { border-color: transparent; background: transparent; color: var(--planner-accent); text-align: start; }
  .item:hover:not(:disabled) { text-decoration: underline; }
  .primary { background: var(--planner-accent); color: var(--planner-on-accent); border-color: var(--planner-accent); }
  .notice { margin-block: 0.75rem; border-inline-start: 0.2rem solid var(--planner-error); padding-inline-start: 0.75rem; }
  .notice p { margin-block: 0.25rem; }
  small, .muted { color: var(--planner-text-muted); }
</style>
