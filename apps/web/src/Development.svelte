<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { ConnectionState } from 'convex/browser';
  import {
    api, conflictRevision, editableStatuses, errorCode, pageSize, taskStatuses, titleLimit,
    type EditableStatus, type Task, type TaskCommand, type TaskOperation, type TaskPage,
    type TaskPatch, type TaskStatus, type Workspace,
  } from './contracts';
  import { signIn, SignInError, type Session } from './session';
  import './development.css';

  let { origin }: { origin: string } = $props();

  type Attempt<Command extends TaskCommand = TaskCommand> = {
    operation: TaskOperation & { command: Command };
    status: TaskStatus;
    cursor: string | null;
  };
  type Update = Extract<TaskCommand, { kind: 'task.update' }>;
  type Recovery =
    | { kind: 'unconfirmed'; attempt: Attempt }
    | { kind: 'conflict'; attempt: Attempt<Update>; code: 'REVISION_CONFLICT' | 'NOT_FOUND'; revision?: number };
  type SuspendedDraft = {
    recovery?: Recovery;
    editor?: { task: Task; title: string; status: EditableStatus };
    newTitle: string;
    filter: TaskStatus;
  };

  let session = $state.raw<Session>();
  let connection = $state.raw<ConnectionState>();
  let workspace = $state.raw<Workspace>();
  let page = $state.raw<TaskPage>();
  let workspaceLoading = $state(false);
  let workspaceError = $state('');
  let readError = $state('');
  let username = $state('');
  let password = $state('');
  let signInMessage = $state('');
  let signingIn = $state(false);
  let signingOut = $state(false);
  let confirmSignOut = $state(false);
  let signOutError = $state('');
  let browserOnline = $state(navigator.onLine);

  let filter = $state<TaskStatus>('inbox');
  let cursors = $state<(string | null)[]>([null]);
  let pageIndex = $state(0);
  let newTitle = $state('');
  let editing = $state.raw<Task>();
  let editTitle = $state('');
  let editStatus = $state<EditableStatus>('inbox');
  let editInput = $state<HTMLInputElement>();
  let taskHeading = $state<HTMLHeadingElement>();
  let taskList = $state<HTMLUListElement>();
  let pending = $state.raw<Attempt>();
  let recovery = $state.raw<Recovery>();
  let latestTask = $state.raw<Task | null | undefined>();
  let reviewingConflict = $state(false);
  let reviewError = $state('');
  // A session may expire mid-write. Keep drafts only in this page and scoped to the server-confirmed owner and workspace.
  const suspended = new SvelteMap<string, SuspendedDraft>();
  let changeError = $state('');
  let confirmation = $state('');
  let stopWatching: (() => void) | undefined;
  let watchGeneration = 0;
  let destroyed = false;

  const connected = $derived(browserOnline && connection?.isWebSocketConnected === true);
  const offline = $derived(!browserOnline || connection?.isWebSocketConnected === false
    && (connection.hasEverConnected || connection.connectionRetries > 0));
  const readyToEdit = $derived(Boolean(page && connected && !readError && !pending && !recovery
    && !signingOut && !confirmSignOut && !signOutError));
  const editDirty = $derived(Boolean(editing && (editTitle !== editing.title || editStatus !== editing.status)));
  const hasDraft = $derived(Boolean(pending || recovery || editDirty || newTitle));
  const uncertainWrite = $derived(Boolean(pending || recovery?.kind === 'unconfirmed'));
  const navigationLocked = $derived(!connected || Boolean(pending) || editDirty || confirmSignOut);
  const tasks = $derived.by(() => {
    const rows = page?.page ?? [];
    if (!pending || pending.status !== filter || pending.cursor !== cursors[pageIndex]) return rows;
    const { command } = pending.operation;
    if (command.kind === 'task.create') {
      if (rows.some(row => row.publicId === command.publicId)) return rows;
      const optimistic: Task = {
        publicId: command.publicId, title: command.title, status: command.status, revision: 0,
      };
      return [optimistic, ...rows];
    }
    return rows.flatMap(row => {
      if (row.publicId !== command.publicId) return [row];
      if (command.patch.status && command.patch.status !== filter) return [];
      return [{ ...row, ...command.patch }];
    });
  });

  onDestroy(() => {
    destroyed = true;
    watchGeneration++;
    stopWatching?.();
    session?.dispose();
  });

  function scopeKey(active: Session, personal: Workspace) {
    return JSON.stringify([active.userId, personal._id, personal.publicId]);
  }

  function clearSession(message = '', preserveDraft = false) {
    if (preserveDraft && session && workspace && hasDraft) {
      suspended.set(scopeKey(session, workspace), {
        recovery: pending ? { kind: 'unconfirmed', attempt: pending } : recovery,
        editor: editing && editDirty ? { task: editing, title: editTitle, status: editStatus } : undefined,
        newTitle,
        filter,
      });
    }
    watchGeneration++;
    stopWatching = undefined;
    session = undefined;
    connection = undefined;
    workspace = undefined;
    workspaceError = '';
    workspaceLoading = false;
    page = undefined;
    readError = '';
    filter = 'inbox';
    cursors = [null];
    pageIndex = 0;
    clearEdit();
    newTitle = '';
    pending = undefined;
    clearRecovery();
    changeError = '';
    confirmation = '';
    signOutError = '';
    confirmSignOut = false;
    signInMessage = message;
  }

  async function submitSignIn(event: SubmitEvent) {
    event.preventDefault();
    const login = username.trim();
    if (signingIn || signingOut || !browserOnline || !login || !password) return;
    const secret = password;
    password = '';
    signingIn = true;
    signInMessage = '';
    try {
      const opened = await signIn(origin, login, secret, {
        connection: state => { connection = state; },
        authenticated: () => {
          if (!workspace && !workspaceError) void loadWorkspace();
        },
        expired: message => { clearSession(message, true); },
      });
      if (destroyed) {
        opened.dispose();
        return;
      }
      session = opened;
      opened.start();
    } catch (error) {
      if (!destroyed) {
        session?.dispose();
        clearSession(error instanceof SignInError ? error.message : 'Could not start your session. Try again.');
      }
    } finally {
      signingIn = false;
    }
  }

  async function loadWorkspace() {
    const active = session;
    if (!active || workspaceLoading || signingOut) return;
    workspaceLoading = true;
    workspaceError = '';
    try {
      const personal = await active.client.mutation(api.ensurePersonal, {});
      if (active !== session || destroyed) return;
      if (personal.ownerId !== active.userId) throw new Error('Personal workspace owner did not match the session');
      const key = scopeKey(active, personal);
      const draft = suspended.get(key);
      if (draft) {
        suspended.delete(key);
        filter = draft.filter;
        newTitle = draft.newTitle;
        recovery = draft.recovery;
        if (draft.editor) {
          editing = draft.editor.task;
          editTitle = draft.editor.title;
          editStatus = draft.editor.status;
        }
      }
      workspace = personal;
      watchPage();
    } catch (error) {
      if (active !== session || destroyed) return;
      if (errorCode(error) === 'UNAUTHENTICATED') active.expire();
      else workspaceError = 'Could not open your workspace.';
    } finally {
      if (active === session) workspaceLoading = false;
    }
  }

  function watchPage() {
    const active = session;
    if (!active || !workspace) return;
    const generation = ++watchGeneration;
    stopWatching?.();
    page = undefined;
    readError = '';
    stopWatching = active.client.onUpdate(api.listTasks, {
      workspaceId: workspace._id,
      filter: { kind: 'status', status: filter },
      paginationOpts: { cursor: cursors[pageIndex], numItems: pageSize },
    }, result => {
      if (generation !== watchGeneration) return;
      page = result;
      readError = '';
    }, error => {
      if (generation !== watchGeneration) return;
      if (errorCode(error) === 'UNAUTHENTICATED') {
        active.expire();
        return;
      }
      page = undefined;
      readError = 'Could not load tasks.';
    });
  }

  function changeFilter(event: Event & { currentTarget: HTMLSelectElement }) {
    if (navigationLocked) {
      event.currentTarget.value = filter;
      return;
    }
    filter = event.currentTarget.value as TaskStatus;
    cursors = [null];
    pageIndex = 0;
    clearEdit();
    watchPage();
  }

  function goToPage(direction: -1 | 1) {
    if (navigationLocked || (direction === -1 && pageIndex === 0)) return;
    if (direction === 1) {
      if (!page || page.isDone) return;
      cursors = [...cursors.slice(0, pageIndex + 1), page.continueCursor];
    }
    pageIndex += direction;
    clearEdit();
    watchPage();
  }

  function requestSignOut() {
    if (hasDraft) confirmSignOut = true;
    else void submitSignOut();
  }

  async function submitSignOut() {
    const active = session;
    if (!active || signingOut) return;
    const key = workspace && scopeKey(active, workspace);
    confirmSignOut = false;
    signingOut = true;
    signOutError = '';
    try {
      await active.signOut();
      if (key) suspended.delete(key);
      if (active === session) clearSession();
    } catch {
      if (active === session) signOutError = 'Sign-out could not be confirmed. Reconnect and try again.';
    } finally {
      signingOut = false;
    }
  }

  function startChange(command: TaskCommand) {
    if (!workspace) return;
    void apply({
      operation: { workspaceId: workspace._id, operationId: crypto.randomUUID(), command },
      status: filter,
      cursor: cursors[pageIndex],
    });
  }

  async function apply(attempt: Attempt) {
    const active = session;
    if (!active || pending || !connected || signingOut || confirmSignOut
      || attempt.operation.workspaceId !== workspace?._id) return;
    pending = attempt;
    clearRecovery();
    changeError = '';
    confirmation = '';
    try {
      // The live client resolves successful mutations after applying their query transition.
      await active.client.mutation(api.applyTask, attempt.operation);
      if (active === session && !destroyed) {
        confirmation = attempt.operation.command.kind === 'task.create' ? 'Task added.' : 'Task updated.';
      }
    } catch (error) {
      if (active !== session || destroyed) return;
      const code = errorCode(error);
      if (code === 'UNAUTHENTICATED') {
        active.expire();
      } else if ((code === 'REVISION_CONFLICT' || code === 'NOT_FOUND') && attempt.operation.command.kind === 'task.update') {
        const { operation } = attempt;
        recovery = {
          kind: 'conflict', code, revision: conflictRevision(error),
          attempt: { ...attempt, operation: { ...operation, command: attempt.operation.command } },
        };
      } else if (code) {
        changeError = 'The workspace rejected this change.';
      } else {
        recovery = { kind: 'unconfirmed', attempt };
      }
    } finally {
      if (active === session) {
        pending = undefined;
        if (attempt.operation.command.kind === 'task.update') void restoreEditFocus(attempt.operation.command.publicId);
      }
    }
  }

  function clearRecovery() {
    recovery = undefined;
    latestTask = undefined;
    reviewingConflict = false;
    reviewError = '';
  }

  async function reviewLatest() {
    const active = session;
    const conflict = recovery;
    if (!active || !connected || conflict?.kind !== 'conflict' || reviewingConflict || confirmSignOut) return;
    const { workspaceId, command } = conflict.attempt.operation;
    reviewingConflict = true;
    latestTask = undefined;
    reviewError = '';
    try {
      const task = await active.client.query(api.getTask, { workspaceId, publicId: command.publicId });
      if (active !== session || conflict !== recovery || destroyed) return;
      if (task && conflict.revision !== undefined && task.revision < conflict.revision) {
        reviewError = 'The latest revision is not available yet. Try again.';
      } else {
        latestTask = task;
      }
    } catch (error) {
      if (active !== session || conflict !== recovery || destroyed) return;
      if (errorCode(error) === 'UNAUTHENTICATED') active.expire();
      else reviewError = 'Could not load the latest task. Try again.';
    } finally {
      if (active === session && conflict === recovery) reviewingConflict = false;
    }
  }

  function continueEditing() {
    if (recovery?.kind !== 'conflict' || !latestTask || latestTask.status === 'archived'
      || !page || !connected || confirmSignOut) return;
    const task = latestTask;
    const { patch } = recovery.attempt.operation.command;
    clearRecovery();
    void openEditor(task, patch);
  }

  function submitNewTask(event: SubmitEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!readyToEdit || !title || filter === 'archived') return;
    newTitle = '';
    startChange({ kind: 'task.create', publicId: crypto.randomUUID(), title, status: filter });
  }

  function startEdit(task: Task) {
    if (!readyToEdit || editDirty || task.publicId === editing?.publicId) return;
    void openEditor(task);
  }

  async function openEditor(task: Task, patch: TaskPatch = {}) {
    if (task.status === 'archived') return;
    editing = task;
    editTitle = patch.title ?? task.title;
    editStatus = patch.status ?? task.status;
    await tick();
    editInput?.focus();
  }

  function clearEdit() {
    editing = undefined;
    editTitle = '';
  }

  function cancelEdit() {
    const publicId = editing?.publicId;
    clearEdit();
    if (publicId) void restoreEditFocus(publicId);
  }

  async function restoreEditFocus(publicId: string) {
    const active = session;
    await tick();
    if (!active || active !== session || !taskHeading) return;
    const focused = document.activeElement;
    if (focused !== document.body && focused !== taskHeading) return;
    const button = taskList?.querySelector<HTMLButtonElement>(`button[data-task-id="${CSS.escape(publicId)}"]:enabled`);
    (button ?? taskHeading).focus();
  }

  function submitEdit(event: SubmitEvent) {
    event.preventDefault();
    const title = editTitle.trim();
    if (!readyToEdit || !editing || !title) return;
    const patch: TaskPatch = {};
    if (title !== editing.title) patch.title = title;
    if (editStatus !== editing.status) patch.status = editStatus;
    if (!Object.keys(patch).length) return;
    const { publicId, revision } = editing;
    clearEdit();
    startChange({ kind: 'task.update', publicId, expectedRevision: revision, patch });
    void restoreEditFocus(publicId);
  }
</script>

<svelte:window ononline={() => { browserOnline = true; }} onoffline={() => { browserOnline = false; }} />

<main class="development" class:account={!session}>
  {#if !session}
    <section class="sign-in" aria-labelledby="klaxon-title">
      <h1 id="klaxon-title">Klaxon</h1>
      <h2>Sign in</h2>
      {#if !browserOnline}<p class="notice" role="status">Offline. Reconnect to sign in.</p>{/if}
      {#if signInMessage}<div class="notice error" role="alert"><p>{signInMessage}</p></div>{/if}
      <form onsubmit={submitSignIn}>
        <label for="username">Username</label>
        <input id="username" autocomplete="username" bind:value={username} required disabled={signingIn || signingOut} />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" bind:value={password} required disabled={signingIn || signingOut} />
        <button class="primary" disabled={signingIn || signingOut || !browserOnline}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  {:else}
    <header class="app-header">
      <h1>Klaxon</h1>
      <button onclick={requestSignOut} disabled={signingOut || confirmSignOut || !browserOnline}>Sign out</button>
    </header>
    <div class="workspace">
      {#if offline}<p class="notice" role="status">Offline. Task changes are paused.</p>{/if}
      {#if confirmSignOut}
        <div class="notice error">
          <p role="alert">
            {#if uncertainWrite}
              The save may already have been applied. Signing out discards your ability to retry this change.
            {:else if hasDraft}
              Signing out discards your draft.
            {:else}
              Sign out of this workspace?
            {/if}
          </p>
          <div class="actions">
            <button onclick={() => { confirmSignOut = false; }}>Stay signed in</button>
            <button onclick={submitSignOut} disabled={!browserOnline}>{hasDraft ? 'Sign out and discard' : 'Sign out'}</button>
          </div>
        </div>
      {/if}
      {#if signingOut}
        <p role="status">Signing out…</p>
      {:else if signOutError}
        <div class="notice error" role="alert"><p>{signOutError}</p></div>
      {:else if workspaceError}
        <div class="notice error" role="alert">
          <p>{workspaceError}</p>
          <button onclick={loadWorkspace} disabled={!connected}>Retry opening workspace</button>
        </div>
      {:else if !workspace}
        {#if !offline}<p role="status">Loading workspace…</p>{/if}
      {:else}
        <p class="workspace-name">{workspace.name}</p>
        <div class="task-header">
          <h2 tabindex="-1" bind:this={taskHeading}>Tasks</h2>
          <label>
            <span class="sr-only">Task status filter</span>
            <select value={filter} onchange={changeFilter} disabled={navigationLocked}>
              {#each Object.entries(taskStatuses) as [status, label] (status)}
                <option value={status}>{label}</option>
              {/each}
            </select>
          </label>
        </div>

        {#if readError}
          <div class="notice error" role="alert">
            <p>{readError}</p>
            <button onclick={watchPage} disabled={!connected}>Retry loading tasks</button>
          </div>
        {/if}

        {#if recovery?.kind === 'unconfirmed'}
          {@const attempt = recovery.attempt}
          <div class="notice error" role="alert">
            <p>Could not confirm the change. It may already have been applied. You can safely retry.</p>
            <div class="actions">
              <button onclick={() => apply(attempt)} disabled={!connected || confirmSignOut}>Retry change</button>
              <button onclick={clearRecovery} disabled={confirmSignOut}>Discard retry</button>
            </div>
          </div>
        {:else if recovery?.kind === 'conflict'}
          {@const { patch } = recovery.attempt.operation.command}
          <div class="notice error" role="alert">
            <p>{recovery.code === 'NOT_FOUND' ? 'This task could not be found.' : 'This task changed elsewhere.'}</p>
            <dl class="change-review">
              {#if patch.title !== undefined}<dt>Your draft title</dt><dd>{patch.title}</dd>{/if}
              {#if patch.status !== undefined}<dt>Your draft status</dt><dd>{taskStatuses[patch.status]}</dd>{/if}
              {#if latestTask}
                <dt>Latest title</dt><dd>{latestTask.title}</dd>
                <dt>Latest status</dt><dd>{taskStatuses[latestTask.status]}</dd>
                <dt>Latest revision</dt><dd>{latestTask.revision}</dd>
              {/if}
            </dl>
            {#if reviewError}
              <p>{reviewError}</p>
            {:else if latestTask === null}
              <p>This task is no longer available.</p>
            {:else if latestTask?.status === 'archived'}
              <p>This task is archived.</p>
            {/if}
            <div class="actions">
              {#if latestTask && latestTask.status !== 'archived'}
                <button onclick={continueEditing} disabled={!page || !connected || confirmSignOut}>Continue editing</button>
              {:else}
                <button onclick={reviewLatest} disabled={!connected || reviewingConflict || confirmSignOut}>
                  {reviewingConflict ? 'Loading latest task…' : 'Review latest task'}
                </button>
              {/if}
              <button onclick={() => {
                if (recovery?.kind !== 'conflict') return;
                const { publicId } = recovery.attempt.operation.command;
                clearRecovery();
                void restoreEditFocus(publicId);
              }} disabled={confirmSignOut}>Discard draft</button>
            </div>
          </div>
        {:else if changeError}
          <div class="notice error" role="alert"><p>{changeError}</p></div>
        {/if}
        {#if pending || confirmation}
          <p class="confirmation" role="status">{pending ? 'Saving…' : confirmation}</p>
        {/if}

        {#if editing}
          <form class="task-form edit" onsubmit={submitEdit}>
            <label for="edit-title">Task title</label>
            <input id="edit-title" bind:this={editInput} bind:value={editTitle} maxlength={titleLimit} required disabled={!readyToEdit} />
            <label for="edit-status">Task status</label>
            <select id="edit-status" bind:value={editStatus} disabled={!readyToEdit}>
              {#each editableStatuses as status (status)}
                <option value={status}>{taskStatuses[status]}</option>
              {/each}
            </select>
            <div class="actions">
              <button class="primary" disabled={!readyToEdit || !editTitle.trim()
                || (editTitle.trim() === editing.title && editStatus === editing.status)}>Save</button>
              <button type="button" onclick={cancelEdit}>Cancel</button>
            </div>
            {#if editDirty}<p class="list-message">Save or cancel your edit to switch tasks or pages.</p>{/if}
          </form>
        {:else if filter !== 'archived'}
          <form class="task-form capture" onsubmit={submitNewTask}>
            <label class="sr-only" for="new-title">New task title</label>
            <input id="new-title" placeholder="New task title" bind:value={newTitle} maxlength={titleLimit} required disabled={!readyToEdit} />
            <button class="primary" disabled={!readyToEdit || !newTitle.trim()}>Add task</button>
          </form>
        {/if}

        {#if !page}
          {#if !readError && !offline}<p class="list-message" role="status">Loading tasks…</p>{/if}
        {:else if tasks.length === 0}
          <p class="list-message" role="status">
            {offline ? 'No cached tasks on this page.' : `No ${taskStatuses[filter].toLowerCase()} tasks.`}
          </p>
        {:else}
          <ul aria-label={taskStatuses[filter] + ' tasks'} bind:this={taskList}>
            {#each tasks as task (task.publicId)}
              <li>
                <span class="task-title">{task.title}</span>
                {#if task.status !== 'archived'}
                  <button data-task-id={task.publicId} aria-label={'Edit ' + task.title}
                    onclick={() => startEdit(task)} disabled={!readyToEdit || editDirty || task.publicId === editing?.publicId}>Edit</button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        {#if pageIndex > 0 || (page && !page.isDone)}
          <nav class="pager" aria-label="Task pages">
            <button onclick={() => goToPage(-1)} disabled={pageIndex === 0 || navigationLocked}>Previous page</button>
            <button onclick={() => goToPage(1)} disabled={!page || page.isDone || navigationLocked}>Next page</button>
          </nav>
        {/if}
      {/if}
    </div>
  {/if}
</main>
