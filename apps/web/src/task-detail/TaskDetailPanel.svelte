<script lang="ts">
  import { recoverDraft } from '../draft-recovery';
  import { onMount, tick, untrack } from 'svelte';
  import { conflictRevision, errorCode, taskStatuses, titleLimit } from '../contracts';
  import {
    detailApi, detailPageSize, sourceLabel, type DetailCommand, type DetailOperation,
    type DetailProps, type Lifecycle, type Project, type Step, type TaskDetail,
  } from './detail-contract';
  import { isTaskDirty, rebaseTaskDraft, reviewTaskChanges, stepMoveRank, taskDraft, taskPatch, type TaskDraft } from './draft';
  import ExternalLinks from './ExternalLinks.svelte';
  import TaskFields from './TaskFields.svelte';
  import './task-detail.css';

  let { client, workspaceId, publicId, disabled = false, onClose, onDirtyChange, onUnauthenticated }: DetailProps = $props();

  type Attempt = { operation: DetailOperation; success: string };
  type Conflict = { command: DetailCommand; revision?: number; missing: boolean };
  type Confirmation = { kind: 'close' } | { kind: 'delete'; step: Step };
  const confirmationId = $props.id();

  let serverTask = $state.raw<TaskDetail | null>();
  let base = $state.raw<TaskDetail>();
  let draft = $state<TaskDraft>();
  let taskError = $state('');
  let waitingRevision = $state<number>();
  let confirmedMessage = $state('');
  let problem = $state('');
  let retry = $state.raw<Attempt>();
  let pending = $state(false);
  let inFlight: Attempt | undefined;
  let conflict = $state.raw<Conflict>();
  let reviewing = $state(false);
  let reviewed = $state(false);
  let reviewError = $state('');
  let latestTask = $state.raw<TaskDetail | null>();
  let confirmation = $state.raw<Confirmation>();
  let dialog = $state<HTMLDialogElement>();
  let cancelConfirmation = $state<HTMLButtonElement>();

  let projects = $state.raw<Project[]>([]);
  let projectsCursor = $state<string | null>(null);
  let projectsLoading = $state(false);
  let projectError = $state('');
  let steps = $state.raw<Step[]>([]);
  let stepsCursor = $state<string | null>(null);
  let stepsLoading = $state(false);
  let stepError = $state('');
  let stepPages = 1;
  let newStep = $state('');
  let stepEdit = $state.raw<Step>();
  let stepTitle = $state('');
  let stepInput = $state<HTMLInputElement>();
  let linksDirty = $state(false);
  let linksBusy = $state(false);
  let linksUnconfirmed = $state(false);
  let stopWatching: (() => void) | undefined;
  let active = false;

  const taskDirty = $derived(Boolean(base && draft && isTaskDirty(base, draft)));
  const stepDirty = $derived(Boolean(newStep.trim() || (stepEdit && stepTitle !== stepEdit.title)));
  const dirty = $derived(taskDirty || stepDirty || linksDirty || pending || Boolean(retry || conflict));
  const busy = $derived(pending || linksBusy);
  const lockWrites = $derived(disabled || busy || Boolean(retry || conflict || waitingRevision) || linksUnconfirmed
    || Boolean(taskError) || serverTask === null);
  const lockSteps = $derived(lockWrites || base?.status === 'archived' || stepsLoading || Boolean(stepError));
  const taskConflict = $derived(conflict?.command.kind.startsWith('task.') === true);
  const conflictStep = $derived(reviewed && conflict && !taskConflict
    ? steps.find(step => step.publicId === conflict?.command.publicId && step.revision >= (conflict.revision ?? 0))
    : undefined);
  const taskComparison = $derived(base && draft && latestTask
    ? reviewTaskChanges(base, draft, latestTask, projectName) : []);
  const stepMovement = $derived(steps.map((_, index) => ({
    up: stepMoveRank(steps, index, -1, Boolean(stepsCursor)),
    down: stepMoveRank(steps, index, 1, Boolean(stepsCursor)),
  })));

  const restored = recoverDraft('task-detail', () => dirty || busy ? {
    base, newStep, stepEdit, stepTitle, conflict, draft: $state.snapshot(draft), retry: retry ?? inFlight,
  } : undefined);
  if (restored) {
    base = restored.base;
    newStep = restored.newStep;
    stepEdit = restored.stepEdit;
    stepTitle = restored.stepTitle;
    conflict = restored.conflict;
    draft = restored.draft;
    retry = restored.retry;
  }

  $effect(() => {
    const report = onDirtyChange;
    const value = dirty || busy;
    untrack(() => report?.(value));
  });

  $effect(() => {
    const latest = serverTask;
    if (latest === undefined || !base || taskDirty || pending || retry || taskConflict || waitingRevision) return;
    if (latest === null && (stepDirty || linksDirty)) return;
    if (latest !== base) untrack(() => adoptTask(latest));
  });

  onMount(() => {
    active = true;
    watchTask();
    if (restored?.base) void readSteps(restored.base._id);
    void loadProjects();
    return () => {
      active = false;
      stopWatching?.();
      onDirtyChange?.(false);
    };
  });

  function projectName(id: string) {
    return projects.find(project => project._id === id)?.name ?? 'Project outside the loaded list';
  }

  function reportAuth(error: unknown) {
    if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated?.();
  }

  function adoptTask(task: TaskDetail | null) {
    base = task ?? undefined;
    draft = task ? taskDraft(task) : undefined;
  }

  function receiveTask(task: TaskDetail | null) {
    if (!active) return;
    const firstLoad = !base;
    serverTask = task;
    taskError = '';
    if (waitingRevision !== undefined && (!task || task.revision >= waitingRevision)) {
      waitingRevision = undefined;
      adoptTask(task);
    } else if (firstLoad) {
      adoptTask(task);
    }
    if (firstLoad && task) void readSteps(task._id);
  }

  function watchTask() {
    stopWatching?.();
    taskError = '';
    stopWatching = client.onUpdate(detailApi.task, { workspaceId, publicId }, receiveTask, error => {
      if (!active) return;
      taskError = 'Could not load task details.';
      reportAuth(error);
    });
  }

  async function loadProjects() {
    if (projectsLoading) return;
    projectsLoading = true;
    projectError = '';
    try {
      const page = await client.query(detailApi.projects, {
        workspaceId, paginationOpts: { cursor: projectsCursor, numItems: detailPageSize },
      });
      if (!active) return;
      const unique = new Map([...projects, ...page.page].map(project => [project._id, project]));
      projects = [...unique.values()];
      projectsCursor = page.isDone ? null : page.continueCursor;
    } catch (error) {
      if (!active) return;
      projectError = 'Could not load projects.';
      reportAuth(error);
    } finally {
      if (active) projectsLoading = false;
    }
  }

  async function readSteps(taskId: string, append = false) {
    if (stepsLoading) return false;
    stepsLoading = true;
    stepError = '';
    try {
      let cursor = append ? stepsCursor : null;
      const rows = append ? [...steps] : [];
      for (let pageIndex = 0; pageIndex < (append ? 1 : stepPages); pageIndex++) {
        const page = await client.query(detailApi.steps, {
          workspaceId, taskId, paginationOpts: { cursor, numItems: detailPageSize },
        });
        if (!active || base?._id !== taskId) return false;
        rows.push(...page.page);
        cursor = page.isDone ? null : page.continueCursor;
        if (cursor === null) break;
      }
      steps = [...new Map(rows.map(step => [step.publicId, step])).values()].sort((a, b) => a.rank - b.rank);
      stepsCursor = cursor;
      if (append) stepPages++;
      return true;
    } catch (error) {
      if (active) {
        stepError = 'Could not load steps.';
        reportAuth(error);
      }
      return false;
    } finally {
      if (active) stepsLoading = false;
    }
  }

  function resetTask() {
    adoptTask(serverTask ?? null);
    problem = '';
  }

  function saveTask(event: SubmitEvent) {
    event.preventDefault();
    if (!base || !draft || lockWrites || base.status === 'archived') return;
    try {
      const patch = taskPatch(base, draft);
      if (Object.keys(patch).length === 0) return resetTask();
      change({ kind: 'task.update', publicId, expectedRevision: base.revision, patch }, 'Task saved.');
    } catch (error) {
      problem = error instanceof Error ? error.message : 'Check the task fields.';
    }
  }

  function lifecycle(kind: Lifecycle | 'complete') {
    if (!base || lockWrites || taskDirty || stepDirty || linksDirty) return;
    const target = { publicId, expectedRevision: base.revision };
    if (kind === 'complete') {
      change({ ...target, kind: 'task.update', patch: { status: 'done' } }, 'Task completed.');
    } else {
      change({ ...target, kind }, { 'task.reopen': 'Task reopened.', 'task.archive': 'Task archived.', 'task.restore': 'Task restored.' }[kind]);
    }
  }

  function change(command: DetailCommand, success: string) {
    void apply({ operation: { workspaceId, operationId: crypto.randomUUID(), command }, success });
  }

  async function apply(attempt: Attempt) {
    if (!active || disabled || pending || linksBusy) return;
    const { command } = attempt.operation;
    pending = true;
    inFlight = attempt;
    confirmedMessage = '';
    problem = '';
    retry = undefined;
    try {
      const result = await client.mutation(detailApi.apply, attempt.operation);
      if (!active) return;
      if (command.kind.startsWith('task.')) {
        // The SDK delivers live-query transitions before acknowledging the mutation.
        if (serverTask === null || (serverTask && serverTask.revision >= result.revision)) adoptTask(serverTask);
        else waitingRevision = result.revision;
      } else {
        if (command.kind === 'step.create') newStep = '';
        if (command.kind === 'step.update' && command.patch.title !== undefined) clearStepEdit();
        if (base) await readSteps(base._id);
      }
      if (active) confirmedMessage = attempt.success;
    } catch (error) {
      if (!active) return;
      const code = errorCode(error);
      if (code === 'REVISION_CONFLICT' || code === 'NOT_FOUND') {
        conflict = { command, revision: conflictRevision(error), missing: code === 'NOT_FOUND' };
      } else if (code) {
        problem = code === 'UNAUTHENTICATED' ? 'Sign in again to save your changes.' : 'The workspace rejected this change.';
        reportAuth(error);
      } else {
        retry = attempt;
      }
    } finally {
      inFlight = undefined;
      if (active) pending = false;
    }
  }

  async function reviewLatest() {
    if (!conflict || reviewing || disabled) return;
    const current = conflict;
    reviewing = true;
    reviewError = '';
    try {
      if (taskConflict) {
        const fetched = await client.query(detailApi.task, { workspaceId, publicId });
        if (!active) return;
        const latest = fetched && serverTask && serverTask.revision > fetched.revision ? serverTask : fetched;
        if (latest && latest.revision < (current.revision ?? 0)) {
          reviewError = 'The latest revision is still syncing. Try again.';
          return;
        }
        serverTask = latest;
        latestTask = latest;
        reviewed = true;
      } else if (base && await readSteps(base._id)) {
        reviewed = true;
      }
    } catch (error) {
      if (active) {
        reviewError = 'Could not load the latest task.';
        reportAuth(error);
      }
    } finally {
      if (active) reviewing = false;
    }
  }

  function finishReview(keepEdits: boolean) {
    if (taskConflict) {
      if (!reviewed || latestTask === undefined) {
        if (keepEdits) return;
        resetTask();
      } else if (keepEdits && base && draft && latestTask && latestTask.status !== 'archived') {
        draft = rebaseTaskDraft(base, draft, latestTask);
        base = latestTask;
      } else {
        adoptTask(latestTask);
      }
    } else if (stepEdit) {
      if (keepEdits && conflictStep) stepEdit = conflictStep;
      else clearStepEdit();
    }
    conflict = undefined;
    latestTask = undefined;
    reviewed = false;
    reviewError = '';
  }

  async function editStep(step: Step) {
    stepEdit = step;
    stepTitle = step.title;
    await tick();
    stepInput?.focus();
  }

  function clearStepEdit() {
    stepEdit = undefined;
    stepTitle = '';
  }

  function saveStep(event: SubmitEvent) {
    event.preventDefault();
    if (lockSteps || !stepTitle.trim() || !stepEdit) return;
    const { publicId, revision, title } = stepEdit;
    if (title === stepTitle.trim()) return clearStepEdit();
    change({ kind: 'step.update', publicId, expectedRevision: revision, patch: { title: stepTitle.trim() } }, 'Step saved.');
  }

  function addStep(event: SubmitEvent) {
    event.preventDefault();
    if (!base || lockedStepActions || !newStep.trim()) return;
    change({ kind: 'step.create', taskId: base._id, publicId: crypto.randomUUID(), title: newStep.trim() }, 'Step added.');
  }

  function updateStep(step: Step, patch: { rank: number } | { completed: boolean }, message: string) {
    if (lockedStepActions) return;
    change({ kind: 'step.update', publicId: step.publicId, expectedRevision: step.revision, patch }, message);
  }

  const lockedStepActions = $derived(lockSteps || Boolean(stepEdit));

  async function ask(action: Confirmation) {
    confirmation = action;
    await tick();
    if (active && dialog && !dialog.open) {
      dialog.showModal();
      cancelConfirmation?.focus();
    }
  }

  function requestClose() {
    if (busy) return;
    if (dirty) void ask({ kind: 'close' });
    else onClose();
  }

  function confirmAction() {
    const action = confirmation;
    dialog?.close();
    if (action?.kind === 'close') onClose();
    else if (action?.kind === 'delete' && !lockedStepActions) {
      change({ kind: 'step.delete', publicId: action.step.publicId, expectedRevision: action.step.revision }, 'Step deleted.');
    }
  }
</script>

<div class="task-detail-editor">
  <header class="task-detail-heading">
    <h2>Task details</h2>
    <button type="button" onclick={requestClose} disabled={busy}>Close task</button>
  </header>

  {#if taskError}
    <div class="task-detail-notice">
      <p role="alert">{taskError}</p>
      <button type="button" onclick={watchTask} {disabled}>Retry loading task</button>
    </div>
  {:else if serverTask === null}
    <p role="status">This task is no longer available.</p>
  {:else if serverTask === undefined}
    <p role="status">Loading task…</p>
  {/if}

  {#if retry}
    <div class="task-detail-notice">
      <p role="alert">Could not confirm the change. It may already have been saved.</p>
      <button type="button" onclick={() => retry && apply(retry)} {disabled}>Retry change</button>
    </div>
  {:else if conflict}
    <div class="task-detail-notice">
      <p role="alert">{conflict.missing ? 'This item could not be found.' : 'This item changed elsewhere.'}
        {taskDirty || stepDirty ? ' Your draft is still here.' : ''}</p>
      {#if reviewError}<p role="alert">{reviewError}</p>{/if}
      {#if reviewed && taskConflict}
        {#if latestTask}
          {#if !taskComparison.some(comparison => comparison.field === 'Title')}
            <p>Latest task <strong>{latestTask.title}</strong> · {taskStatuses[latestTask.status]}</p>
          {/if}
          {#each taskComparison as comparison (comparison.field)}
            <dl class="task-detail-comparison">
              <dt>{comparison.field} in latest task</dt><dd>{comparison.latest || 'Empty'}</dd>
              <dt>Your {comparison.field.toLowerCase()}</dt><dd>{comparison.mine || 'Empty'}</dd>
            </dl>
          {/each}
          {#if latestTask.status !== 'archived' && taskDirty}
            <button type="button" onclick={() => finishReview(true)} {disabled}>Keep my edits</button>
          {/if}
        {:else}
          <p>The latest task is unavailable.</p>
        {/if}
      {:else if reviewed && conflictStep}
        <p>Latest step <strong>{conflictStep.title}</strong> · {conflictStep.completed ? 'Complete' : 'Open'}</p>
        {#if stepEdit && stepDirty}
          <button type="button" onclick={() => finishReview(true)} {disabled}>Keep my edits</button>
        {/if}
      {:else if reviewed && !taskConflict && !conflictStep}
        <p>{stepsCursor ? 'Load more steps to find the current step.' : 'The latest step is unavailable.'}</p>
      {/if}
      {#if !reviewed || (!taskConflict && !conflictStep)}
        <button type="button" onclick={reviewLatest} disabled={disabled || reviewing}>Review latest</button>
      {/if}
      <button type="button" onclick={() => finishReview(false)} disabled={reviewing}>
        {taskConflict && taskDirty || !taskConflict && stepEdit ? 'Discard conflicting edits' : 'Close conflict review'}
      </button>
    </div>
  {/if}
  {#if problem}<p class="task-detail-notice" role="alert">{problem}</p>{/if}
  <p class="task-detail-feedback" role="status">{pending || waitingRevision ? 'Saving…' : confirmedMessage}</p>

  {#if base && draft}
    {@const locked = lockWrites || taskDirty || stepDirty || linksDirty}
    <p class="task-detail-source">Source <strong>{sourceLabel(base.source)}</strong></p>
    <div class="task-detail-actions">
      {#if base.status === 'archived'}
        <button type="button" onclick={() => lifecycle('task.restore')} disabled={locked}>Restore task</button>
      {:else}
        {#if base.status === 'done'}
          <button type="button" onclick={() => lifecycle('task.reopen')} disabled={locked}>Reopen task</button>
        {:else}
          <button type="button" onclick={() => lifecycle('complete')} disabled={locked}>Complete task</button>
        {/if}
        <button type="button" onclick={() => lifecycle('task.archive')} disabled={locked}>Archive task</button>
      {/if}
    </div>

    <TaskFields task={base} bind:draft {projects} {projectError} {projectsLoading} moreProjects={Boolean(projectsCursor)}
      {loadProjects} locked={lockWrites || base.status === 'archived'} discardDisabled={pending || Boolean(retry || conflict || waitingRevision)}
      dirty={taskDirty} onSave={saveTask} onReset={resetTask} />

    <section class="task-detail-section">
      <h3>Steps</h3>
      {#if stepsLoading}<p role="status">Loading steps…</p>{/if}
      {#if stepError}
        <p role="alert">{stepError}</p>
        <button type="button" onclick={() => base && readSteps(base._id)} disabled={disabled || stepsLoading}>Retry loading steps</button>
      {/if}
      {#if steps.length > 0}
        <ol class="task-detail-steps" aria-label="Task steps">
          {#each steps as step, index (step.publicId)}
            {@const { up, down } = stepMovement[index]}
            <li>
              <label class="task-detail-check">
                <input type="checkbox" checked={step.completed} disabled={lockedStepActions}
                  onchange={event => {
                    const completed = event.currentTarget.checked;
                    event.currentTarget.checked = step.completed;
                    updateStep(step, { completed }, completed ? 'Step completed.' : 'Step reopened.');
                  }} />
                <span>{step.title}</span>
              </label>
              <div class="task-detail-actions" role="group" aria-label={'Actions for ' + step.title}>
                <button type="button" aria-label="Move up" onclick={() => up !== undefined && updateStep(step, { rank: up }, 'Step moved.')}
                  disabled={lockedStepActions || up === undefined}>↑</button>
                <button type="button" aria-label="Move down" onclick={() => down !== undefined && updateStep(step, { rank: down }, 'Step moved.')}
                  disabled={lockedStepActions || down === undefined}>↓</button>
                <button type="button" aria-label="Edit step" onclick={() => editStep(step)} disabled={lockedStepActions}>Edit</button>
                <button type="button" aria-label="Delete step" onclick={() => ask({ kind: 'delete', step })} disabled={lockedStepActions}>Delete</button>
              </div>
            </li>
          {/each}
        </ol>
      {:else if !stepsLoading && !stepError}
        <p>No steps yet.</p>
      {/if}
      {#if stepsCursor}
        <button type="button" onclick={() => base && readSteps(base._id, true)} disabled={disabled || pending || stepsLoading}>Load more steps</button>
      {/if}
      {#if stepEdit}
        <form onsubmit={saveStep}>
          <label>Step title <input bind:this={stepInput} bind:value={stepTitle} maxlength={titleLimit} required disabled={lockSteps} /></label>
          <div class="task-detail-actions">
            <button class="task-detail-primary" disabled={lockSteps || !stepTitle.trim() || stepTitle.trim() === stepEdit.title}>Save step</button>
            <button type="button" onclick={clearStepEdit} disabled={pending || Boolean(retry || conflict)}>Cancel edit</button>
          </div>
        </form>
      {/if}
      {#if base.status !== 'archived' || newStep}
        <form onsubmit={addStep}>
          <label>New step <input bind:value={newStep} maxlength={titleLimit} required disabled={lockedStepActions} /></label>
          <div class="task-detail-actions">
            <button disabled={lockedStepActions || !newStep.trim()}>Add step</button>
            {#if newStep}
              <button type="button" onclick={() => { newStep = ''; }}
                disabled={pending || Boolean(retry || conflict)}>Clear new step</button>
            {/if}
          </div>
        </form>
      {/if}
    </section>

    <ExternalLinks {client} {workspaceId} taskId={base._id}
      disabled={disabled || pending || Boolean(retry || conflict || taskError) || serverTask === null}
      readOnly={base.status === 'archived'} {onUnauthenticated}
      onStateChange={(state) => {
        linksDirty = state.dirty;
        linksBusy = state.busy;
        linksUnconfirmed = state.unconfirmed;
      }} />
  {/if}

  <dialog bind:this={dialog} onclose={() => { confirmation = undefined; }} aria-labelledby={confirmationId}>
    {#if confirmation}
      <h3 id={confirmationId}>{confirmation.kind === 'delete' ? 'Delete step?' : 'Close task details?'}</h3>
      <p>{confirmation.kind === 'delete'
        ? `“${confirmation.step.title}” will be permanently deleted.`
        : retry || linksUnconfirmed
          ? 'A change may already have been saved. Closing discards your ability to retry it from this panel.'
          : 'Closing discards your unsaved edits.'}</p>
      <div class="task-detail-actions">
        <button type="button" bind:this={cancelConfirmation} onclick={() => dialog?.close()}>Cancel</button>
        <button type="button" class="task-detail-destructive" onclick={confirmAction}>
          {confirmation.kind === 'delete' ? 'Delete permanently' : 'Discard and close'}
        </button>
      </div>
    {/if}
  </dialog>
</div>
