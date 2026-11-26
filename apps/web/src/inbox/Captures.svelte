<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { ConvexClient } from 'convex/browser';
  import { errorCode, pageSize, titleLimit } from '../contracts';
  import { taskHref } from '../planner-route';
  import {
    captureApi, captureBodyLimit, captureSearchLimit, hasCaptureDraft, sourceLabel, tagsText,
    type Capture, type CaptureCommand, type CaptureDraft, type CaptureEditor, type CaptureOperation, type CapturePage,
  } from './capture-contract';

  interface Props {
    mode: 'inbox' | 'capture';
    client: ConvexClient;
    workspaceId: string;
    connected: boolean;
    disabled: boolean;
    draft: CaptureDraft | undefined;
    onUnauthenticated: () => void;
    onOpenTask: (event: MouseEvent, publicId: string) => void;
  }

  let {
    mode, client, workspaceId, connected, disabled, draft = $bindable(), onUnauthenticated, onOpenTask,
  }: Props = $props();
  const id = $props.id();

  let searchInput = $state('');
  let searchText = $state('');
  let cursors = $state<(string | null)[]>([null]);
  let pageIndex = $state(0);
  let page = $state.raw<CapturePage>();
  let readError = $state(false);
  let unsubscribe: (() => void) | undefined;
  let pending = $state(false);
  let writeError = $state('');
  let conflict = $state(false);
  let confirmation = $state('');
  let promotedPublicId = $state<string>();
  let editorInput = $state<HTMLTextAreaElement | HTMLInputElement>();
  let createInput = $state<HTMLTextAreaElement>();
  let heading = $state<HTMLHeadingElement>();
  let list = $state<HTMLUListElement>();
  let destroyed = false;

  const editor = $derived(draft?.editor);
  const canChange = $derived(connected && !disabled && !pending && !draft?.attempt);
  const lockPages = $derived(!connected || disabled || Boolean(editor || draft?.attempt));
  const latestCapture = $derived(editor && page?.page.find(item => item.publicId === editor.capture.publicId
    && item.revision > editor.capture.revision && canTriage(item)));

  onDestroy(() => { destroyed = true; });

  $effect(() => {
    if (mode !== 'inbox') return;
    watchPage();
    return stopWatching;
  });

  function stopWatching() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function watchPage() {
    stopWatching();
    const args = { workspaceId, paginationOpts: { cursor: cursors[pageIndex], numItems: pageSize } };
    page = undefined;
    readError = false;
    let watching = true;
    const success = (result: CapturePage) => {
      if (!watching) return;
      page = result;
      readError = false;
    };
    const failure = (error: Error) => {
      if (!watching) return;
      if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated();
      else {
        page = undefined;
        readError = true;
      }
    };
    const stop = searchText
      ? client.onUpdate(captureApi.search, { ...args, text: searchText }, success, failure)
      : client.onUpdate(captureApi.list, args, success, failure);

    unsubscribe = () => {
      watching = false;
      stop();
    };
  }

  function updateDraft(patch: Partial<CaptureDraft>) {
    draft = { ...draft, ...patch };
  }

  function changeSearch(text: string) {
    if (lockPages) return;
    searchText = text.trim();
    cursors = [null];
    pageIndex = 0;
  }

  function goToPage(direction: -1 | 1) {
    if (lockPages || (direction === -1 && pageIndex === 0)) return;
    if (direction === 1) {
      if (!page || page.isDone) return;
      cursors = [...cursors.slice(0, pageIndex + 1), page.continueCursor];
    }
    pageIndex += direction;
  }

  function canTriage(capture: Capture) {
    return !capture.promotedTaskId && capture.archivedAt === undefined;
  }

  function openEditor(capture: Capture, kind: CaptureEditor['kind']) {
    if (!canChange || editor || !canTriage(capture)) return;
    writeError = '';
    confirmation = '';
    promotedPublicId = undefined;
    updateDraft({ editor: kind === 'edit'
      ? { kind, capture, body: capture.body, tags: tagsText(capture) }
      : { kind, capture, title: capture.body.trim().split(/\r?\n/, 1)[0].slice(0, titleLimit) } });
    void tick().then(() => editorInput?.focus());
  }

  async function restoreFocus(publicId: string | undefined) {
    await tick();
    if (destroyed || document.activeElement !== document.body) return;
    const editButton = publicId && list?.querySelector<HTMLButtonElement>(
      `button[data-capture-edit="${CSS.escape(publicId)}"]:enabled`,
    );
    (editButton || createInput || heading)?.focus();
  }

  function discard() {
    const publicId = editor?.capture.publicId ?? draft?.attempt?.command.publicId;
    draft = undefined;
    writeError = '';
    conflict = false;
    void restoreFocus(publicId);
  }

  function startChange(command: CaptureCommand) {
    if (!canChange) return;
    void apply({ workspaceId, operationId: crypto.randomUUID(), command });
  }

  async function apply(attempt: CaptureOperation) {
    if (!connected || disabled || pending || attempt.workspaceId !== workspaceId) return;
    pending = true;
    updateDraft({ attempt });
    writeError = '';
    conflict = false;
    confirmation = '';
    promotedPublicId = undefined;
    const messages = {
      'capture.create': 'Capture saved.',
      'capture.update': 'Capture updated.',
      'capture.promote': 'Task created.',
      'capture.archive': 'Capture archived.',
    };
    try {
      await client.mutation(captureApi.apply, attempt);
      if (destroyed) return;
      draft = undefined;
      confirmation = messages[attempt.command.kind];
      if (attempt.command.kind === 'capture.promote') promotedPublicId = attempt.command.taskPublicId;
    } catch (error) {
      if (destroyed) return;
      const code = errorCode(error);
      if (code === 'UNAUTHENTICATED') {
        onUnauthenticated();
      } else if (code) {
        updateDraft({ attempt: undefined });
        conflict = code === 'REVISION_CONFLICT' || code === 'NOT_FOUND' || code === 'INVALID_STATE';
        writeError = conflict ? 'This capture changed elsewhere.' : 'The workspace rejected this capture change.';
      }
    } finally {
      if (!destroyed) {
        pending = false;
        if (!draft?.editor && !draft?.attempt) void restoreFocus(attempt.command.publicId);
      }
    }
  }

  function submitCreate() {
    const body = draft?.body?.trim();
    if (body) startChange({ kind: 'capture.create', publicId: crypto.randomUUID(), body });
  }

  function submitEditor(event: SubmitEvent) {
    event.preventDefault();
    if (!editor || conflict) return;
    const { publicId, revision: expectedRevision } = editor.capture;
    if (editor.kind === 'promote') {
      const title = editor.title.trim();
      if (title) startChange({ kind: 'capture.promote', publicId, expectedRevision, taskPublicId: crypto.randomUUID(), title });
    } else {
      const body = editor.body.trim();
      const tags = editor.tags === tagsText(editor.capture) ? undefined : editor.tags.split('\n').map(tag => tag.trim()).filter(Boolean);
      if (!body || !hasCaptureDraft(draft)) return;
      if (tags && (tags.length > 32 || tags.some(tag => tag.length > 128))) {
        writeError = 'Use up to 32 tags with 128 characters each.';
        return;
      }
      startChange({ kind: 'capture.update', publicId, expectedRevision, body, ...(tags && { tags }) });
    }
  }

  function useLatest() {
    if (!editor || !latestCapture || !canChange) return;
    const updated = editor.kind === 'edit'
      ? { ...editor, capture: latestCapture, tags: editor.tags === tagsText(editor.capture) ? tagsText(latestCapture) : editor.tags }
      : { ...editor, capture: latestCapture };
    updateDraft({ editor: updated });
    conflict = false;
    writeError = '';
  }
</script>

<section class="captures" aria-labelledby={`${id}-heading`}>
  {#if mode === 'capture'}
    <h1 id={`${id}-heading`} tabindex="-1" bind:this={heading}>Capture</h1>
  {:else}
    <h2 id={`${id}-heading`} tabindex="-1" bind:this={heading}>Captures</h2>
    <form class="search" onsubmit={event => { event.preventDefault(); changeSearch(searchInput); }}>
      <label for={`${id}-search`}>Search captures</label>
      <div class="controls">
        <input id={`${id}-search`} type="search" bind:value={searchInput} maxlength={captureSearchLimit} disabled={lockPages} />
        <button disabled={lockPages}>Search</button>
        {#if searchText}
          <button type="button" disabled={lockPages} onclick={() => { searchInput = ''; changeSearch(''); }}>Clear search</button>
        {/if}
      </div>
    </form>
  {/if}

  {#if draft?.attempt && !pending}
    {@const attempt = draft.attempt}
    <div class="notice">
      <p role="alert">Could not confirm the capture change. You can safely retry it.</p>
      <div class="controls">
        <button onclick={() => apply(attempt)} disabled={!connected || disabled}>Retry capture change</button>
        <button onclick={discard} {disabled}>Discard capture draft</button>
      </div>
    </div>
  {:else if writeError}
    <div class="notice">
      <p role="alert">{writeError}</p>
      {#if conflict && latestCapture}
        <p class="capture-body">{latestCapture.body}</p>
        <button onclick={useLatest} disabled={!canChange}>Use latest revision</button>
      {/if}
    </div>
  {/if}

  {#if pending || confirmation}
    <p role="status">{pending ? 'Saving capture…' : confirmation}</p>
    {#if promotedPublicId}
      {@const publicId = promotedPublicId}
      <a href={taskHref(publicId)} onclick={event => onOpenTask(event, publicId)}>Open created task</a>
    {/if}
  {/if}

  {#if mode === 'capture'}
    <form class="editor" onsubmit={event => { event.preventDefault(); submitCreate(); }}>
      <label for={`${id}-body`}>Capture text</label>
      <textarea id={`${id}-body`} data-quick-capture bind:this={createInput} rows="5" maxlength={captureBodyLimit} required
        value={draft?.body ?? ''} disabled={!canChange}
        oninput={event => updateDraft({ body: event.currentTarget.value })}
        onkeydown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            submitCreate();
          }
        }}></textarea>
      <div class="controls">
        <button class="primary" disabled={!canChange || !draft?.body?.trim()}>Save capture</button>
        {#if draft?.body && !draft.attempt}
          <button type="button" onclick={discard}>Discard capture draft</button>
        {/if}
      </div>
    </form>
  {:else}
    {#if editor}
      <form class="editor" onsubmit={submitEditor}>
        {#if editor.kind === 'edit'}
          <label for={`${id}-body`}>Capture text</label>
          <textarea id={`${id}-body`} bind:this={editorInput} rows="4" maxlength={captureBodyLimit} required
            value={editor.body} disabled={!canChange}
            oninput={event => updateDraft({ editor: { ...editor, body: event.currentTarget.value } })}></textarea>
          <label for={`${id}-tags`}>Tags</label>
          <textarea id={`${id}-tags`} rows="2" placeholder="One tag per line" value={editor.tags} disabled={!canChange}
            oninput={event => updateDraft({ editor: { ...editor, tags: event.currentTarget.value } })}></textarea>
        {:else}
          <label for={`${id}-title`}>Promoted task title</label>
          <input id={`${id}-title`} bind:this={editorInput} maxlength={titleLimit} required value={editor.title}
            disabled={!canChange} oninput={event => updateDraft({ editor: { ...editor, title: event.currentTarget.value } })} />
        {/if}
        <div class="controls">
          <button class="primary" disabled={!canChange || conflict || !hasCaptureDraft(draft)
            || !(editor.kind === 'edit' ? editor.body.trim() : editor.title.trim())}>
            {editor.kind === 'edit' ? 'Save changes' : 'Create task'}
          </button>
          {#if !draft?.attempt}<button type="button" onclick={discard}>Cancel capture edit</button>{/if}
        </div>
      </form>
    {/if}

    {#if readError}
      <div class="notice">
        <p role="alert">Could not load captures.</p>
        <button onclick={watchPage} disabled={!connected}>Retry loading captures</button>
      </div>
    {:else if !page}
      {#if connected}<p role="status">Loading captures…</p>{/if}
    {:else if !page.page.length}
      <p role="status">{searchText ? 'No matching captures.' : 'No captures to triage.'}</p>
    {:else}
      <ul aria-label="Captures" bind:this={list}>
        {#each page.page as capture (capture.publicId)}
          <li>
            <p class="capture-body">{capture.body}</p>
            <div class="metadata">
              <span>{sourceLabel(capture.source)}</span>
              {#each capture.tags as tag, index (index)}<span>{tag}</span>{/each}
              {#if capture.promotedTaskId}<span>Promoted to task</span>{/if}
              {#if capture.archivedAt !== undefined}<span>Archived</span>{/if}
            </div>
            {#if canTriage(capture)}
              <div class="controls">
                <button data-capture-edit={capture.publicId} onclick={() => openEditor(capture, 'edit')} disabled={!canChange || Boolean(editor)}>Edit capture</button>
                <button onclick={() => openEditor(capture, 'promote')} disabled={!canChange || Boolean(editor)}>Promote to task</button>
                <button onclick={() => startChange({ kind: 'capture.archive', publicId: capture.publicId, expectedRevision: capture.revision })}
                  disabled={!canChange || Boolean(editor)}>Archive capture</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if pageIndex > 0 || (page && !page.isDone)}
      <nav class="controls" aria-label="Capture pages">
        <button onclick={() => goToPage(-1)} disabled={lockPages || pageIndex === 0}>Previous capture page</button>
        <button onclick={() => goToPage(1)} disabled={lockPages || !page || page.isDone}>Next capture page</button>
      </nav>
    {/if}
  {/if}
</section>

<style>
  .captures { min-inline-size: 0; }
  h1, h2 { margin: 0; line-height: 1.15; }
  h1 { font-size: clamp(1.55rem, 5vw, 2rem); }
  h2 { font-size: 1.25rem; }
  .editor, .search, li { display: grid; gap: 0.5rem; }
  .editor, .search, .notice { margin-block: 1rem; }
  .controls, .metadata { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .metadata { color: var(--planner-text-muted); font-size: 0.875rem; overflow-wrap: anywhere; }
  label { font-size: 0.9rem; font-weight: 600; }
  input, textarea, button {
    box-sizing: border-box;
    min-block-size: var(--planner-target);
    min-inline-size: 0;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--planner-control-border);
    border-radius: var(--planner-radius);
    background: var(--planner-surface);
    color: var(--planner-text);
    font: inherit;
  }
  input[type='search'] { flex: 1 1 9rem; }
  textarea { max-inline-size: 100%; resize: vertical; }
  button:not(:disabled) { cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .primary { border-color: var(--planner-accent); background: var(--planner-accent); color: var(--planner-on-accent); }
  a { color: var(--planner-accent); }
  ul { list-style: none; margin-block: 1rem; padding: 0; }
  li { padding-block: 0.75rem; border-block-start: 1px solid var(--planner-border); }
  li:last-child { border-block-end: 1px solid var(--planner-border); }
  .capture-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .notice { border-inline-start: 0.2rem solid var(--planner-error); padding-inline-start: 0.75rem; }
  .notice p { margin: 0 0 0.5rem; }
</style>
