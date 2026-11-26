<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { onDestroy } from 'svelte';
  import { errorCode } from '../contracts';

  const scopeLabels = {
    'tasks:read': 'Read tasks',
    'tasks:write': 'Write tasks',
    'planning:read': 'Read planning',
  } as const;
  type Scope = keyof typeof scopeLabels;
  type OAuthPrincipal = { issuer: string; subject: string; clientId: string };
  type Credential = {
    publicId: string;
    label: string;
    scopes: Scope[];
    expiresAt: number;
    revokedAt?: number;
    oauthBindingAvailable?: boolean;
    oauthBound?: boolean;
    oauthCandidate?: OAuthPrincipal;
  };
  type CredentialPage = { page: Credential[]; isDone: boolean; continueCursor: string };
  type Issue = { workspaceId: string; label: string; scopes: Scope[]; expiresAt: number; tokenHash: string };
  const list = makeFunctionReference<'query',
    { workspaceId: string; paginationOpts: { cursor: string | null; numItems: number } }, CredentialPage>(
    'agentCredentials:list',
  );
  const issue = makeFunctionReference<'mutation', Issue, Credential>('agentCredentials:issue');
  const revoke = makeFunctionReference<'mutation', { workspaceId: string; publicId: string }, Credential>(
    'agentCredentials:revoke',
  );
  const enableOAuth = makeFunctionReference<'mutation',
    { workspaceId: string; publicId: string; expectedPrincipal: OAuthPrincipal }, { publicId: string; oauthBound: boolean }>(
      'agentCredentials:bindOAuth',
    );
  let { client, workspaceId, workspacePublicId, disabled, onDirtyChange, onUnauthenticated }: {
    client: ConvexClient;
    workspaceId: string;
    workspacePublicId: string;
    disabled: boolean;
    onDirtyChange: (dirty: boolean) => void;
    onUnauthenticated: () => void;
  } = $props();

  const hour = 3_600_000;
  const format = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let label = $state('');
  let lifespan = $state(168);
  let canRead = $state(true);
  let canWrite = $state(false);
  let canReadPlanning = $state(false);
  const hasScope = $derived(canRead || canWrite || canReadPlanning);
  let page = $state.raw<CredentialPage>();
  let cursors = $state<(string | null)[]>([null]);
  let pending = $state(false);
  let attempt = $state.raw<{ args: Issue; bearer: string }>();
  let disclosure = $state('');
  let selection = $state.raw<{ row: Credential } &
    ({ action: 'revoke' } | { action: 'oauth'; principal: OAuthPrincipal })>();
  let notice = $state('');
  let error = $state('');
  let loadError = $state(false);
  let refresh = $state(0);
  let alive = true;

  onDestroy(() => {
    alive = false;
    attempt = undefined;
    disclosure = '';
  });

  $effect(() => {
    const retry = refresh;
    let subscribed = true;
    page = undefined;
    loadError = false;
    const unsubscribe = client.onUpdate(list, { workspaceId, paginationOpts: { cursor: cursors.at(-1) ?? null, numItems: 25 } },
      value => {
        if (!subscribed || !alive || retry !== refresh) return;
        page = value;
        loadError = false;
      },
      reason => {
        if (!subscribed || !alive || retry !== refresh) return;
        loadError = true;
        if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
      });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  });
  $effect(() => onDirtyChange(Boolean(pending || attempt || disclosure)));

  function hex(bytes: Uint8Array) {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function issueCredential(event: SubmitEvent) {
    event.preventDefault();
    if (disabled || pending || disclosure || selection || (!attempt && (!label.trim() || !hasScope))) return;
    pending = true;
    notice = error = '';
    try {
      if (!attempt) {
        const scopes: Scope[] = [];
        if (canRead) scopes.push('tasks:read');
        if (canWrite) scopes.push('tasks:write');
        if (canReadPlanning) scopes.push('planning:read');
        const bearer = 'klx_' + hex(crypto.getRandomValues(new Uint8Array(32)));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer));
        if (!alive) return;
        attempt = { bearer, args: { workspaceId, label: label.trim(), scopes, expiresAt: Date.now() + lifespan * hour,
          tokenHash: hex(new Uint8Array(digest)) } };
      }
      const current = attempt;
      const result = await client.mutation(issue, current.args);
      if (!alive) return;
      if (result.revokedAt !== undefined || result.expiresAt <= Date.now()) {
        notice = 'This credential is no longer active. Issue a new credential for access.';
      } else disclosure = current.bearer;
      attempt = undefined;
      label = '';
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') onUnauthenticated();
      else if (code) {
        attempt = undefined;
        error = 'The workspace rejected this credential.';
      } else error = attempt ? 'Issuance could not be confirmed. Retry to check the same credential.'
        : 'Could not generate a token. Use this page over a secure connection and retry.';
    } finally {
      if (alive) pending = false;
    }
  }

  function discardAttempt() {
    attempt = undefined;
    error = '';
    notice = 'Issuance retry discarded. Check the credential list for a grant to revoke.';
  }

  async function copyToken() {
    const token = disclosure;
    try {
      await navigator.clipboard.writeText(token);
      if (alive && token === disclosure) notice = 'Token copied.';
    } catch {
      if (alive && token === disclosure) notice = 'Clipboard unavailable. Select and copy the token manually.';
    }
  }

  async function updateCredential() {
    if (!selection || disabled || pending) return;
    const { action, row } = selection;
    const isRevoke = action === 'revoke';
    pending = true;
    notice = error = '';
    try {
      const args = { workspaceId, publicId: row.publicId };
      if (action === 'revoke') await client.mutation(revoke, args);
      else await client.mutation(enableOAuth, { ...args, expectedPrincipal: selection.principal });
      if (!alive) return;
      selection = undefined;
      notice = isRevoke ? 'Credential revoked.' : 'OAuth access enabled.';
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') onUnauthenticated();
      else if (code) {
        selection = undefined;
        error = isRevoke ? 'The workspace rejected this revocation.' : 'The workspace rejected this OAuth binding.';
      } else error = 'The change could not be confirmed. Retry to check the result.';
    } finally {
      if (alive) pending = false;
    }
  }

</script>

<section class="settings">
  <h1>Settings</h1>
  <h2>Agent credentials</h2>
  <p>Grant an agent limited access to this workspace.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if disclosure}
    <section class="disclosure" aria-label="New agent credential">
      <p>Copy this token now. It will only be shown this once.</p>
      <label>Bearer token <input type="text" value={disclosure} readonly autocomplete="off" spellcheck="false" /></label>
      <button type="button" onclick={copyToken}>Copy token</button>
      <button type="button" onclick={() => { disclosure = ''; notice = ''; }}>Hide token</button>
    </section>
  {:else}
    <form onsubmit={issueCredential}>
      <fieldset disabled={disabled || pending || Boolean(attempt) || Boolean(selection)}>
        <label>Credential label <input type="text" bind:value={label} required maxlength="100" /></label>
        <label>Expires in
          <select bind:value={lifespan}>
            <option value={1}>1 hour</option>
            <option value={24}>1 day</option>
            <option value={168}>7 days</option>
            <option value={336}>14 days</option>
          </select>
        </label>
        <div class="scopes">
          <label><input type="checkbox" bind:checked={canRead} /> Read tasks</label>
          <label><input type="checkbox" bind:checked={canWrite} /> Write tasks</label>
          <label><input type="checkbox" bind:checked={canReadPlanning} aria-describedby="planning-access" /> Read planning</label>
        </div>
        <small id="planning-access">Read planning includes calendar events, time blocks, reminders, and planning preferences.</small>
      </fieldset>
      <button disabled={disabled || pending || Boolean(selection) || !label.trim() || !hasScope}>
        {attempt ? 'Retry issuance' : 'Issue credential'}
      </button>
      {#if attempt && !pending}<button type="button" onclick={discardAttempt}>Discard issuance retry</button>{/if}
    </form>
  {/if}
  <h3>Issued credentials</h3>
  {#if selection}
    <section aria-label="Credential access confirmation">
      {#if selection.action === 'revoke'}
        <p>Revoke access for {selection.row.label}?</p>
        <button disabled={disabled || pending} onclick={updateCredential}>Confirm revocation</button>
      {:else}
        <p>Enable OAuth access for {selection.row.label}? OAuth access uses this credential’s scopes and expiry.</p>
        <dl>
          <dt>Issuer</dt><dd>{selection.principal.issuer}</dd>
          <dt>Subject</dt><dd>{selection.principal.subject}</dd>
          <dt>Client ID</dt><dd>{selection.principal.clientId}</dd>
        </dl>
        <button disabled={disabled || pending} onclick={updateCredential}>Confirm OAuth access</button>
      {/if}
      <button disabled={pending} onclick={() => selection = undefined}>Cancel</button>
    </section>
  {/if}
  {#if loadError}
    <p role="alert">Could not load agent credentials.</p>
    <button disabled={disabled} onclick={() => refresh++}>Retry loading credentials</button>
  {:else if !page}
    <p role="status">Loading agent credentials…</p>
  {:else}
    {#if !page.page.length}<p>No credentials on this page.</p>{/if}
    <ul>
      {#each page.page as row (row.publicId)}
        {@const expired = row.expiresAt <= Date.now()}
        <li>
          <strong>{row.label}</strong>
          <small>{row.scopes.map(scope => scopeLabels[scope]).join(' · ')}</small>
          {#if row.revokedAt !== undefined}<small>Revoked</small>
          {:else}
            <small>{expired ? 'Expired' : 'Expires'} <time datetime={new Date(row.expiresAt).toISOString()}>{format.format(row.expiresAt)}</time></small>
            {#if !expired}
              {#if row.oauthBound}<small>OAuth enabled</small>
              {:else if row.oauthBindingAvailable && row.oauthCandidate}
                {@const principal = row.oauthCandidate}
                <button disabled={disabled || pending || Boolean(selection) || Boolean(attempt) || Boolean(disclosure)}
                  aria-label={'Enable OAuth for ' + row.label}
                  onclick={() => selection = { row, action: 'oauth', principal }}>Enable OAuth</button>
              {/if}
              <button disabled={disabled || pending || Boolean(selection) || Boolean(attempt) || Boolean(disclosure)}
                aria-label={'Revoke ' + row.label} onclick={() => selection = { row, action: 'revoke' }}>Revoke</button>
            {/if}
          {/if}
          <details>
            <summary>OAuth setup identifiers</summary>
            <dl>
              <dt>Workspace public ID</dt><dd><code>{workspacePublicId}</code></dd>
              <dt>Credential public ID</dt><dd><code>{row.publicId}</code></dd>
            </dl>
          </details>
        </li>
      {/each}
    </ul>
    {#if cursors.length > 1 || !page.isDone}
      <nav aria-label="Credential pages">
        <button disabled={Boolean(selection) || cursors.length === 1} onclick={() => cursors = cursors.slice(0, -1)}>Previous page</button>
        <button disabled={Boolean(selection) || page.isDone} onclick={() => page && (cursors = [...cursors, page.continueCursor])}>Next page</button>
      </nav>
    {/if}
  {/if}
</section>

<style>
  .settings { padding: var(--planner-gutter); max-width: 48rem; }
  h3 { margin-top: 1.5rem; }
  fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: .7rem; }
  label { display: grid; gap: .25rem; }
  .scopes { display: flex; gap: 1rem; flex-wrap: wrap; }
  .scopes label { display: flex; align-items: center; }
  input, select { font: inherit; }
  input[type="text"], select { min-height: 44px; width: 100%; padding: .4rem; }
  .disclosure { padding: 1rem; border: 1px solid var(--planner-border); border-radius: .5rem; }
  .disclosure p { margin-top: 0; }
  button { min-height: 44px; margin: .4rem .45rem .1rem 0; }
  ul { list-style: none; padding: 0; }
  li { padding: .75rem 0; border-bottom: 1px solid var(--planner-border); overflow-wrap: anywhere; }
  small { display: block; color: var(--planner-text-muted); }
  dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
  summary { cursor: pointer; padding: .5rem 0; }
</style>
