<script lang="ts">
  import { recoverDraft } from '../draft-recovery';
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { onMount, tick, untrack } from 'svelte';
  import { conflictRevision, errorCode } from '../contracts';
  import { detailPageSize, type Page } from './detail-contract';

  type Link = {
    publicId: string;
    revision: number;
    relationship: 'reference' | 'managed_mirror';
    editable: boolean;
    provider: string;
    canonicalUrl?: string;
    label?: string;
    externalObjectId?: string;
  };
  type Reference = { url: string; label?: string };
  type LinkTarget = { publicId: string; expectedRevision: number };
  type Command =
    | ({ kind: 'link.add'; publicId: string } & Reference)
    | ({ kind: 'link.edit' } & LinkTarget & Reference)
    | ({ kind: 'link.remove' } & LinkTarget);
  type Scope = { workspaceId: string; taskId: string };
  type Operation = Scope & { operationId: string; command: Command };
  type LinkState = { dirty: boolean; busy: boolean; unconfirmed: boolean };
  type Conflict = { command: Command; revision?: number };
  const list = makeFunctionReference<'query', Scope & {
    paginationOpts: { cursor: string | null; numItems: number };
  }, Page<Link>>('links:list');
  const apply = makeFunctionReference<'mutation', Operation, {
    workspacePublicId: string; targetPublicId: string; revision: number; activityEventId: string;
  }>('links:apply');

  let {
    client, workspaceId, taskId, disabled, readOnly, onStateChange, onUnauthenticated,
  }: Scope & {
    client: ConvexClient;
    disabled: boolean;
    readOnly: boolean;
    onStateChange: (state: LinkState) => void;
    onUnauthenticated?: () => void;
  } = $props();

  const headingId = $props.id();
  let rows = $state.raw<Link[]>([]);
  let cursor = $state<string | null>(null);
  let loading = $state(false);
  let readError = $state('');
  let problem = $state('');
  let feedback = $state('');
  let url = $state('');
  let label = $state('');
  let input = $state<HTMLInputElement>();
  let editing = $state.raw<Link>();
  let pending = $state(false);
  let inFlight: Operation | undefined;
  let unconfirmed = $state.raw<Operation>();
  let conflict = $state.raw<Conflict>();
  let reviewed = $state(false);
  let pages = 1;
  let active = false;

  const formDirty = $derived(url !== (editing?.canonicalUrl ?? '') || label !== (editing?.label ?? ''));
  const locked = $derived(disabled || readOnly || pending || Boolean(unconfirmed || conflict || readError));
  const latest = $derived(reviewed && conflict ? rows.find(row => row.publicId === conflict?.command.publicId
    && row.revision >= (conflict.revision ?? 0)) : undefined);

  const restored = recoverDraft('external-links', () => formDirty || Boolean(inFlight || unconfirmed || conflict) ? {
    url, label, editing, conflict, unconfirmed: unconfirmed ?? inFlight,
  } : undefined);
  if (restored) {
    url = restored.url;
    label = restored.label;
    editing = restored.editing;
    conflict = restored.conflict;
    unconfirmed = restored.unconfirmed;
  }

  $effect(() => {
    const state = { dirty: formDirty || pending || Boolean(unconfirmed || conflict), busy: pending, unconfirmed: Boolean(unconfirmed) };
    untrack(() => onStateChange(state));
  });

  onMount(() => {
    active = true;
    void load();
    return () => { active = false; };
  });

  function editable(link: Link) {
    return link.editable === true;
  }

  function httpsUrl(value: string | undefined) {
    if (!value || Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })) return undefined;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.href;
    } catch {
      return undefined;
    }
  }

  function readableLink(link: Link) {
    return link.label || link.canonicalUrl || link.externalObjectId || link.provider;
  }

  async function load(append = false) {
    if (loading) return false;
    loading = true;
    readError = '';
    try {
      let next = append ? cursor : null;
      const links = append ? [...rows] : [];
      for (let index = 0; index < (append ? 1 : pages); index++) {
        const page = await client.query(list, { workspaceId, taskId, paginationOpts: { cursor: next, numItems: detailPageSize } });
        if (!active) return false;
        links.push(...page.page);
        next = page.isDone ? null : page.continueCursor;
        if (next === null) break;
      }
      rows = [...new Map(links.map(link => [link.publicId, link])).values()];
      cursor = next;
      if (append) pages++;
      return true;
    } catch (error) {
      if (active) {
        readError = 'Could not load external links.';
        if (errorCode(error) === 'UNAUTHENTICATED') onUnauthenticated?.();
      }
      return false;
    } finally {
      if (active) loading = false;
    }
  }

  function reset() {
    editing = undefined;
    url = '';
    label = '';
    problem = '';
  }

  async function edit(link: Link) {
    editing = link;
    url = link.canonicalUrl ?? '';
    label = link.label ?? '';
    problem = '';
    feedback = '';
    await tick();
    input?.focus();
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (locked || loading || !formDirty) return;
    const address = url.trim();
    if (!httpsUrl(address)) {
      problem = 'Enter an HTTPS URL without credentials.';
      return;
    }
    const fields = { url: address, ...(label.trim() ? { label: label.trim() } : {}) };
    start(editing
      ? { kind: 'link.edit', publicId: editing.publicId, expectedRevision: editing.revision, ...fields }
      : { kind: 'link.add', publicId: crypto.randomUUID(), ...fields });
  }

  function remove(link: Link) {
    if (locked || loading || formDirty || !window.confirm(`Remove “${readableLink(link)}” from this task?`)) return;
    start({ kind: 'link.remove', publicId: link.publicId, expectedRevision: link.revision });
  }

  function start(command: Command) {
    void send({ workspaceId, taskId, operationId: crypto.randomUUID(), command });
  }

  async function send(operation: Operation) {
    if (!active || disabled || pending) return;
    pending = true;
    inFlight = operation;
    unconfirmed = undefined;
    problem = '';
    feedback = '';
    try {
      await client.mutation(apply, operation);
      if (!active) return;
      reset();
      await load();
      if (active) feedback = operation.command.kind === 'link.remove' ? 'Link removed.' : 'Link saved.';
    } catch (error) {
      if (!active) return;
      const code = errorCode(error);
      if (code === 'REVISION_CONFLICT' || code === 'NOT_FOUND') {
        conflict = { command: operation.command, revision: conflictRevision(error) };
      } else if (code) {
        problem = code === 'MANAGED_LINK' ? 'This link is managed by an integration.'
          : code === 'INVALID_ARGUMENT' ? 'Check the link URL and label.' : 'The workspace rejected this link change.';
        if (code === 'UNAUTHENTICATED') onUnauthenticated?.();
      } else {
        unconfirmed = operation;
      }
    } finally {
      inFlight = undefined;
      if (active) pending = false;
    }
  }

  async function review() {
    if (await load()) reviewed = true;
  }

  function resolve(keep: boolean) {
    if (keep && editing && latest && editable(latest)) {
      if (url === (editing.canonicalUrl ?? '')) url = latest.canonicalUrl ?? '';
      if (label === (editing.label ?? '')) label = latest.label ?? '';
      editing = latest;
    } else {
      reset();
    }
    conflict = undefined;
    reviewed = false;
  }
</script>

<section class="task-detail-section" aria-labelledby={headingId}>
  <h3 id={headingId}>External links</h3>
  {#if loading}<p role="status">Loading links…</p>{/if}
  {#if readError}
    <p role="alert">{readError}</p>
    <button type="button" onclick={() => load()} disabled={disabled || loading || pending}>Retry loading links</button>
  {/if}
  {#if unconfirmed}
    <div class="task-detail-notice">
      <p role="alert">Could not confirm the link change. It may already have been saved.</p>
      <button type="button" onclick={() => unconfirmed && send(unconfirmed)} disabled={disabled || loading}>Retry link change</button>
    </div>
  {:else if conflict}
    <div class="task-detail-notice">
      <p role="alert">This link changed elsewhere. Review the latest details before saving again.</p>
      {#if latest}
        <p>Latest link <strong>{readableLink(latest)}</strong></p>
        {#if latest.canonicalUrl && latest.canonicalUrl !== readableLink(latest)}<p>{latest.canonicalUrl}</p>{/if}
        {#if editing && formDirty && editable(latest)}
          <button type="button" onclick={() => resolve(true)} disabled={disabled || readOnly}>Keep my link edits</button>
        {/if}
      {:else}
        {#if reviewed}<p>{cursor ? 'Load more links to find the current link.' : 'The latest link is unavailable.'}</p>{/if}
        <button type="button" onclick={review} disabled={disabled || loading}>Review latest link</button>
      {/if}
      <button type="button" onclick={() => resolve(false)} disabled={loading}>
        {formDirty ? 'Discard link edits' : 'Close link review'}
      </button>
    </div>
  {/if}
  {#if problem}<p role="alert">{problem}</p>{/if}
  <p class="task-detail-feedback" role="status">{pending ? 'Saving link…' : feedback}</p>

  {#if rows.length > 0}
    <ul class="task-detail-links">
      {#each rows as link (link.publicId)}
        {@const href = httpsUrl(link.canonicalUrl)}
        {@const text = readableLink(link)}
        <li>
          {#if href}
            <a {href} target="_blank" rel="noopener noreferrer">{text}</a>
          {:else}
            <p>{text}</p>
            {#if link.canonicalUrl && link.canonicalUrl !== text}<p>{link.canonicalUrl}</p>{/if}
          {/if}
          {#if link.relationship === 'managed_mirror'}<p>Managed by {link.provider}</p>{/if}
          {#if !readOnly && editable(link)}
            <div class="task-detail-actions">
              <button type="button" aria-label={'Edit link ' + text} onclick={() => edit(link)} disabled={locked || loading || formDirty}>Edit</button>
              <button type="button" aria-label={'Remove link ' + text} onclick={() => remove(link)} disabled={locked || loading || formDirty}>Remove</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !loading && !readError}
    <p>No links yet.</p>
  {/if}
  {#if cursor}
    <button type="button" onclick={() => load(true)} disabled={disabled || loading || pending || Boolean(unconfirmed)}>Load more links</button>
  {/if}
  {#if !readOnly || formDirty}
    <form onsubmit={submit}>
      <fieldset disabled={locked || loading} aria-label={editing ? 'Edit external link' : 'Add external link'}>
        <label>HTTPS URL <input type="url" bind:this={input} bind:value={url} maxlength="4096" required /></label>
        <label>Label (optional) <input bind:value={label} maxlength="512" /></label>
      </fieldset>
      <div class="task-detail-actions">
        <button disabled={locked || loading || !formDirty || !url.trim()}>{editing ? 'Save link' : 'Add link'}</button>
        {#if editing || formDirty}
          <button type="button" onclick={reset} disabled={pending || Boolean(unconfirmed || conflict)}>Cancel link edits</button>
        {/if}
      </div>
    </form>
  {/if}
</section>
