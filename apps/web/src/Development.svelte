<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import type { ConnectionState } from 'convex/browser';
  import {
    api, conflictRevision, editableStatuses, errorCode, pageSize, taskStatuses, titleLimit,
    type EditableStatus, type Task, type TaskCommand, type TaskOperation, type TaskPage,
    type TaskPatch, type TaskStatus, type Workspace,
  } from './contracts';
  import Captures from './inbox/Captures.svelte';
  import { hasCaptureDraft, type CaptureDraft } from './inbox/capture-contract';
  import PlannerOverview from './overview/PlannerOverview.svelte';
  import CommandPalette from './organization/CommandPalette.svelte';
  import ProjectsView from './projects/ProjectsView.svelte';
  import CalendarView from './calendar/CalendarView.svelte';
  import ActivityView from './activity/ActivityView.svelte';
  import PwaControls from './pwa/PwaControls.svelte';
  import RemindersView from './reminders/RemindersView.svelte';
  import { clearReminderPushDevice, reconcileReminderPushBinding } from './reminders/push-device';
  import { destinations, readRoute, routeHref, taskHref, type Route } from './planner-route';
  import PlannerShell from './planner-shell/PlannerShell.svelte';
  import { signIn, SignInError, type Session } from './session';
  import TaskDetail from './task-detail/TaskDetail.svelte';
  import { createDraftRecovery } from './draft-recovery';
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
    capture?: CaptureDraft;
    children: Map<string, unknown>;
    route: Route;
    newTitle: string;
    filter: TaskStatus;
  };
  type HistoryPosition = { index: number; parentIndex?: number; taskView?: Route['view']['id'] };
  type PlannerHistory = HistoryPosition & { key: number };

  let session = $state.raw<Session>();
  let connection = $state.raw<ConnectionState>();
  let workspace = $state.raw<Workspace>();
  let page = $state.raw<TaskPage>();
  let workspaceLoading = $state(false);
  let workspaceError = $state('');
  let createFocus = $state<'task'|'capture'>();
  let readError = $state('');
  let username = $state('');
  let password = $state('');
  let signInMessage = $state('');
  let signingIn = $state(false);
  let signingOut = $state(false);
  let confirmSignOut = $state(false);
  let signOutError = $state('');
  let browserOnline = $state(navigator.onLine);
  const savedPosition: PlannerHistory | undefined = history.state?.klaxonPlanner;
  const historyKey = savedPosition?.key ?? performance.timeOrigin;
  let routePosition: HistoryPosition = savedPosition ?? { index: 0 };
  let route = $state.raw(readRoute(location.hash, routePosition.taskView));
  const childRecovery = createDraftRecovery(() => routeHref(route));
  let routeWarning = $state('');
  let detailDirty = $state(false);
  let pageDirty = $state(false);
  let captureDraft = $state.raw<CaptureDraft>();
  let restoringHistory = false;
  let taskOpener: { publicId: string; element: HTMLElement } | undefined;

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
  const primaryView = $derived(route.view);
  const detailId = $derived(route.publicId);
  const accountBusy = $derived(signingOut || confirmSignOut || Boolean(signOutError));
  const captureDirty = $derived(hasCaptureDraft(captureDraft));
  const readyToEdit = $derived(Boolean(page && connected && !readError && !pending && !recovery
    && !accountBusy && !detailId && !captureDirty));
  const editDirty = $derived(Boolean(editing && (editTitle !== editing.title || editStatus !== editing.status)));
  const hasTaskDraft = $derived(Boolean(pending || recovery || editDirty || newTitle));
  const hasDraft = $derived(hasTaskDraft || captureDirty || detailDirty || pageDirty);
  const uncertainWrite = $derived(Boolean(pending || recovery?.kind === 'unconfirmed' || captureDraft?.attempt));
  const navigationLocked = $derived(!connected || Boolean(pending || detailId) || editDirty || captureDirty || confirmSignOut);
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

  onMount(() => {
    routePosition = { ...routePosition, taskView: detailId ? route.view.id : undefined };
    writeHistory(route, routePosition, true);
    const workers = navigator.serviceWorker;
    if (!workers) return;
    function openReminder(event: MessageEvent) {
      if (workers.controller && event.source === workers.controller &&
          event.data?.type === 'KLAXON_OPEN_REMINDERS' && event.data.route === '#/reminders') {
        navigate('#/reminders');
      }
    }
    workers.addEventListener('message', openReminder);
    return () => workers.removeEventListener('message', openReminder);
  });

  $effect(() => {
    if (!hasDraft) return;
    function preventUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  });

  $effect(() => {
    if (!hasDraft && !accountBusy) routeWarning = '';
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

  function reminderPushScope(active: Session, personal: Workspace) {
    return { userId: active.userId, workspaceId: personal._id, workspacePublicId: personal.publicId };
  }

  function writeHistory(next: Route, position: HistoryPosition, replace: boolean) {
    const state = { ...history.state, klaxonPlanner: { key: historyKey, ...position } };
    if (replace) history.replaceState(state, '', routeHref(next));
    else history.pushState(state, '', routeHref(next));
  }

  function canNavigate() {
    if (restoringHistory) return false;
    if (!hasDraft && !accountBusy) return true;
    routeWarning = hasDraft ? 'Save or discard your draft before leaving this view.' : 'Finish signing out before leaving this view.';
    return false;
  }

  function commitRoute(next: Route, position: HistoryPosition) {
    const previous = route;
    routePosition = position;
    if (routeHref(next) === routeHref(previous) && next.view.id === previous.view.id) return;
    routeWarning = '';
    childRecovery.restore();
    route = next;
    if (previous.view.id !== next.view.id) {
      if (next.view.id === 'inbox') {
        // Let Waiting release its task subscription before opening the Inbox page.
        void tick().then(() => { if (!destroyed && !stopWatching) watchPage(); });
      } else stopTaskPage();
    }
    clearEdit();
    captureDraft = undefined;
    detailDirty = false;
    pageDirty = false;
    if (previous.publicId && previous.view.id === next.view.id && !next.publicId) {
      void restoreTaskFocus(previous.publicId);
    } else if (previous.view.id !== next.view.id) {
      taskOpener = undefined;
    }
  }

  function positionFor(next: Route): HistoryPosition {
    return {
      index: routePosition.index + 1,
      taskView: next.publicId ? next.view.id : undefined,
      parentIndex: next.publicId ? (route.publicId ? routePosition.parentIndex : routePosition.index) : undefined,
    };
  }

  function navigate(href: string) {
    const next = readRoute(href, route.view.id);
    if (routeHref(next) === routeHref(route) || !canNavigate()) return;
    const position = positionFor(next);
    writeHistory(next, position, false);
    commitRoute(next, position);
  }

  function quickCreate(kind: 'task'|'capture') {
    if (!canNavigate()) return;
    const href = kind === 'task' ? '#/inbox' : '#/capture';
    navigate(href);
    if (routeHref(route) !== href) return;
    if (kind === 'task') {
      clearEdit();
      if (filter !== 'inbox') {
        filter = 'inbox';
        cursors = [null];
        pageIndex = 0;
        watchPage();
      }
    }
    createFocus = kind;
  }

  $effect(() => {
    const kind = createFocus;
    if (!kind || (kind === 'task' ? !readyToEdit : !connected)) return;
    createFocus = undefined;
    void tick().then(() => {
      document.querySelector<HTMLElement>(kind === 'task' ? '#new-title' : 'textarea[data-quick-capture]')?.focus();
    });
  });

  function historyChanged() {
    const hash = location.hash;
    const state: PlannerHistory | undefined = history.state?.klaxonPlanner;
    const position: HistoryPosition | undefined = state?.key === historyKey ? state : undefined;
    if (restoringHistory) {
      if (position?.index === routePosition.index && hash === routeHref(route)) restoringHistory = false;
      return;
    }
    const next = readRoute(hash, position?.taskView ?? route.view.id);
    if (hash === routeHref(route) && next.view.id === route.view.id) {
      if (position) routePosition = position;
      return;
    }
    if (!canNavigate()) {
      if (position && position.index !== routePosition.index) {
        restoringHistory = true;
        history.go(routePosition.index - position.index);
      } else {
        // Restore the URL after an address-bar edit, which has no app history state.
        if (!position) routePosition = { ...routePosition, index: routePosition.index + 1 };
        writeHistory(route, routePosition, true);
      }
      return;
    }
    const nextPosition = position ?? positionFor(next);
    if (!position || hash !== routeHref(next)) writeHistory(next, nextPosition, true);
    commitRoute(next, nextPosition);
  }

  function openTask(event: MouseEvent, publicId: string) {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    openTaskFrom(publicId, event.currentTarget);
  }

  function openTaskFrom(publicId: string, opener: EventTarget | null = document.activeElement) {
    const previous = route;
    navigate(taskHref(publicId));
    if (route !== previous && route.publicId === publicId && opener instanceof HTMLElement) {
      taskOpener = { publicId, element: opener };
    }
  }

  function closeTask() {
    if (hasTaskDraft || captureDirty || accountBusy || restoringHistory) return;
    // TaskDetail completes its discard confirmation before calling onClose.
    detailDirty = false;
    if (routePosition.parentIndex !== undefined) {
      history.go(routePosition.parentIndex - routePosition.index);
      return;
    }
    const next = { view: route.view };
    const position = { index: routePosition.index };
    writeHistory(next, position, true);
    commitRoute(next, position);
  }

  function reportDetailDirty(dirty: boolean) {
    detailDirty = dirty;
  }

  async function restoreTaskFocus(publicId: string) {
    await tick();
    await new Promise(requestAnimationFrame);
    if (destroyed || detailId || !session) return;
    const focused = document.activeElement;
    if (focused !== document.body && !focused?.classList.contains('planner-main')) return;
    const opener = taskOpener?.publicId === publicId ? taskOpener.element : undefined;
    taskOpener = undefined;
    const link = taskList?.querySelector<HTMLAnchorElement>(`a[data-task-link="${CSS.escape(publicId)}"]`);
    const returnTarget = opener?.getClientRects().length ? opener : link ?? taskHeading;
    returnTarget?.focus();
  }

  function clearSession(message = '', preserveDraft = false) {
    if (preserveDraft && session && workspace) {
      void clearReminderPushDevice(session.client, reminderPushScope(session, workspace), false);
    }
    const children = preserveDraft ? childRecovery.capture() : new Map();
    if (preserveDraft && session && workspace && (hasDraft || children.size)) {
      suspended.set(scopeKey(session, workspace), {
        recovery: pending ? { kind: 'unconfirmed', attempt: pending } : recovery,
        editor: editing && editDirty ? { task: editing, title: editTitle, status: editStatus } : undefined,
        capture: captureDirty ? captureDraft : undefined,
        children,
        route,
        newTitle,
        filter,
      });
    }
    childRecovery.restore();
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
    captureDraft = undefined;
    pageDirty = false;
    detailDirty = false;
    taskOpener = undefined;
    routeWarning = '';
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
        if (routeHref(draft.route) !== routeHref(route)) {
          const position = { index: routePosition.index, taskView: draft.route.publicId ? draft.route.view.id : undefined };
          writeHistory(draft.route, position, true);
          commitRoute(draft.route, position);
        }
        filter = draft.filter;
        newTitle = draft.newTitle;
        recovery = draft.recovery;
        captureDraft = draft.capture;
        if (draft.editor) {
          editing = draft.editor.task;
          editTitle = draft.editor.title;
          editStatus = draft.editor.status;
        }
      }
      childRecovery.restore(draft?.children);
      workspace = personal;
      void reconcileReminderPushBinding(active.client, reminderPushScope(active, personal));
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
    if (!active || !workspace || route.view.id !== 'inbox') return;
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

  function stopTaskPage() {
    watchGeneration++;
    stopWatching?.();
    stopWatching = undefined;
    page = undefined;
    readError = '';
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
      const cleared = !workspace || await clearReminderPushDevice(active.client, reminderPushScope(active, workspace));
      await active.signOut();
      if (key) suspended.delete(key);
      if (active === session) clearSession(cleared ? '' :
        'Signed out. Reminder delivery cleanup could not be confirmed. You can turn off notifications for this site in browser settings.');
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

<svelte:window ononline={() => { browserOnline = true; }} onoffline={() => { browserOnline = false; }}
  onpopstate={historyChanged} onhashchange={historyChanged} />

{#snippet tasksView()}
  <section class="development workspace" aria-labelledby="tasks-heading">
    <div class="task-header">
      <h2 id="tasks-heading" tabindex="-1" bind:this={taskHeading}>Tasks</h2>
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
            <a class="task-title" data-task-link={task.publicId} href={taskHref(task.publicId)}
              onclick={event => openTask(event, task.publicId)}>{task.title}</a>
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
  </section>
{/snippet}

{#snippet signInView()}
  <main class="development account">
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
  </main>
{/snippet}

{#snippet captureView(mode: 'inbox' | 'capture', active: Session, personal: Workspace)}
  <Captures {mode} client={active.client} workspaceId={personal._id} {connected}
    disabled={accountBusy || Boolean(detailId) || hasTaskDraft} bind:draft={captureDraft}
    onUnauthenticated={active.expire} onOpenTask={openTask} />
{/snippet}

{#snippet inboxView(active: Session, personal: Workspace)}
  <div class="inbox">
    <h1>Inbox</h1>
    <div class="inbox-columns">
      {@render tasksView()}
      {@render captureView('inbox', active, personal)}
    </div>
  </div>
{/snippet}

{#snippet capturePage(active: Session, personal: Workspace)}
  <div class="capture-page">{@render captureView('capture', active, personal)}</div>
{/snippet}

{#snippet projectsPage(active: Session, personal: Workspace)}
  <ProjectsView client={active.client} workspaceId={personal._id} disabled={!connected || accountBusy || Boolean(detailId)}
    onDirtyChange={dirty => pageDirty = dirty} onOpenTask={openTaskFrom} onUnauthenticated={active.expire} />
{/snippet}

{#snippet calendarPage(active: Session, personal: Workspace)}
  <CalendarView client={active.client} workspaceId={personal._id} disabled={!connected || accountBusy || Boolean(detailId)}
    onDirtyChange={dirty => pageDirty = dirty} onOpenTask={openTask} onUnauthenticated={active.expire} />
{/snippet}

{#snippet activityPage(active: Session, personal: Workspace)}
  <ActivityView client={active.client} workspaceId={personal._id} disabled={!connected || accountBusy || Boolean(detailId)}
    onDirtyChange={dirty => pageDirty = dirty} onOpenTask={openTaskFrom} onUnauthenticated={active.expire} />
{/snippet}

{#snippet remindersPage(active: Session, personal: Workspace)}
  <RemindersView client={active.client} userId={active.userId} workspaceId={personal._id} workspacePublicId={personal.publicId}
    disabled={!connected || accountBusy || Boolean(detailId)} onOpenTask={openTaskFrom}
    onDirtyChange={dirty => pageDirty = dirty} onUnauthenticated={active.expire} />
{/snippet}

{#snippet taskDetail()}
  {#if session && workspace && detailId}
    <div hidden={signingOut || Boolean(signOutError)}>
      <TaskDetail client={session.client} workspaceId={workspace._id} publicId={detailId}
        disabled={!connected || accountBusy} onClose={closeTask}
        onDirtyChange={reportDetailDirty} onUnauthenticated={session.expire} />
    </div>
  {/if}
{/snippet}

<PwaControls blocked={hasDraft || suspended.size > 0 || signingIn || accountBusy} />
{#if !session}
  {@render signInView()}
{:else}
  {@const active = session}
  {@const views = { inbox: inboxView, capture: capturePage, projects: projectsPage, calendar: calendarPage, reminders: remindersPage, activity: activityPage }}
  <PlannerShell destinations={workspace ? destinations : []} active={primaryView.id} routeKey={routeHref(route)}
    onNavigate={destination => navigate(destination.href)} detail={workspace && detailId ? taskDetail : undefined}>
    {#snippet status()}
      {#if workspace}<span>{workspace.name}</span>{/if}
      {#if offline}<p class="connection" role="status">Offline. Task changes are paused.</p>{/if}
      {#if routeWarning}<p class="route-warning" role="alert">{routeWarning}</p>{/if}
      {#if signingOut}
        <p role="status">Signing out…</p>
      {:else if signOutError}
        <p class="route-warning" role="alert">{signOutError}</p>
      {:else if confirmSignOut}
        <div class="account-confirm">
          <p role="alert">
            {#if uncertainWrite}
              The save may already have been applied. Signing out discards your ability to retry this change.
            {:else if hasDraft}
              Signing out discards your draft.
            {:else}
              Sign out of this workspace?
            {/if}
          </p>
          <div class="account-actions">
            <button onclick={() => { confirmSignOut = false; }}>Stay signed in</button>
            <button onclick={submitSignOut} disabled={!browserOnline}>{hasDraft ? 'Sign out and discard' : 'Sign out'}</button>
          </div>
        </div>
      {/if}
    {/snippet}
    {#snippet actions()}
      {#if workspace}
        <CommandPalette client={active.client} workspaceId={workspace._id} {destinations} disabled={accountBusy}
          onNavigate={navigate} onOpenTask={openTaskFrom} onCreate={quickCreate} onUnauthenticated={active.expire}/>
      {/if}
      <button onclick={requestSignOut} disabled={signingOut || confirmSignOut || !browserOnline}>Sign out</button>
    {/snippet}
    {#if workspaceError}
      <div class="route-warning" role="alert">
        <p>{workspaceError}</p>
        <button onclick={loadWorkspace} disabled={!connected}>Retry opening workspace</button>
      </div>
    {:else if workspace}
      <div hidden={signingOut || Boolean(signOutError)}>
        {#if primaryView.kind === 'overview'}
          <PlannerOverview client={active.client} workspaceId={workspace._id} view={primaryView.id}
            onOpenTask={openTaskFrom} onUnauthenticated={active.expire} />
        {:else}
          {@render views[primaryView.id](active, workspace)}
        {/if}
      </div>
    {:else if !offline}
      <p role="status">Loading workspace…</p>
    {/if}
  </PlannerShell>
{/if}

<style>
  :global(body) { margin: 0; }
  .workspace {
    min-block-size: 0;
    --surface: var(--planner-surface);
    --text: var(--planner-text);
    --muted: var(--planner-text-muted);
    --line: var(--planner-control-border);
    --accent: var(--planner-accent);
    --action: var(--planner-accent);
    --action-text: var(--planner-on-accent);
    --warning: var(--planner-warning);
    --error: var(--planner-error);
  }
  .workspace h2 { font-size: 1.25rem; }
  .task-title {
    display: inline-flex;
    min-block-size: var(--planner-target);
    flex: 1;
    align-items: center;
    color: var(--planner-accent);
    text-underline-offset: 0.15em;
  }
  .inbox { container-type: inline-size; }
  .inbox h1 { margin: 0 0 1rem; font-size: clamp(1.55rem, 5vw, 2rem); line-height: 1.15; }
  .inbox-columns { display: grid; gap: 1.75rem; }
  .capture-page { max-inline-size: 46rem; }
  .connection, .route-warning { margin-block: 0.25rem; }
  .connection { color: var(--planner-warning); }
  .route-warning, .account-confirm p { color: var(--planner-error); }
  .account-confirm p { margin-block: 0.5rem; }
  .account-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  button {
    min-block-size: var(--planner-target);
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--planner-control-border);
    border-radius: var(--planner-radius);
    background: var(--planner-surface);
    color: var(--planner-text);
    font: inherit;
  }
  button:not(:disabled) { cursor: pointer; }
  button:disabled { opacity: 0.6; }

  @container (min-width: 48rem) {
    .inbox-columns { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  }
</style>
