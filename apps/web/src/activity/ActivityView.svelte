<script lang="ts">
  import { recoverDraft } from '../draft-recovery';
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { onDestroy } from 'svelte';
  import { errorCode } from '../contracts';
  type Entry = {eventId:string;actor:string;origin:string;action:string;createdAt:number;reason?:string;
    targetKind:string;targetPublicId:string;revision?:number;undoEligible:boolean};
  type HistoryPage = {page:Entry[];isDone:boolean;continueCursor:string};
  type Undo = {workspaceId:string;eventId:string;expectedRevision:number;operationId:string};
  const list = makeFunctionReference<'query',{workspaceId:string;paginationOpts:{cursor:string|null;numItems:number}},HistoryPage>('activity:list');
  const undo = makeFunctionReference<'mutation',Undo,{revision:number}>('activity:undo');
  let {client,workspaceId,disabled,onOpenTask,onDirtyChange,onUnauthenticated}: {
    client:ConvexClient;workspaceId:string;disabled:boolean;onOpenTask:(id:string)=>void;
    onDirtyChange:(dirty:boolean)=>void;onUnauthenticated:()=>void;
  } = $props();
  let page = $state.raw<HistoryPage>();
  let cursors = $state<(string|null)[]>([null]);
  let selected = $state.raw<Entry>();
  let attempt = $state.raw<Undo>();
  let pending = $state(false);
  let notice = $state('');
  let error = $state('');
  let loadError = $state(false);
  let alive = true;
  onDestroy(() => { alive = false; });
  const format = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'});
  const restored = recoverDraft('activity', () => selected || attempt ? {
    selected, attempt,
  } : undefined);
  if (restored) {
    selected = restored.selected;
    attempt = restored.attempt;
  }

  $effect(() => {
    page = undefined;
    loadError = false;
    return client.onUpdate(list,{workspaceId,paginationOpts:{cursor:cursors.at(-1) ?? null,numItems:25}},value => {
      page = value; loadError = false;
    },reason => { loadError = true; if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated(); });
  });
  $effect(() => { onDirtyChange(Boolean(selected || attempt || pending)); });
  function review(row: Entry) { selected = row; notice = ''; error = ''; }
  async function confirm() {
    if (!selected || selected.revision === undefined || pending || disabled) return;
    attempt ??= {workspaceId,eventId:selected.eventId,expectedRevision:selected.revision,operationId:crypto.randomUUID()};
    pending = true;
    try {
      const result = await client.mutation(undo,attempt);
      if (!alive) return;
      notice = 'Change undone at revision ' + result.revision + '.';
      error = '';
      selected = attempt = undefined;
    } catch (reason) {
      if (!alive) return;
      const code = errorCode(reason);
      if (code === 'UNAUTHENTICATED') onUnauthenticated();
      else if (code) {
        selected = attempt = undefined;
        error = code === 'REVISION_CONFLICT' ? 'A newer edit prevented this undo. The latest task was preserved.'
          : 'This change cannot be undone.';
      } else error = 'The undo was not confirmed. Retry to check the same request.';
    } finally { if (alive) pending = false; }
  }
</script>

<section class="activity"><h1>Activity</h1>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if selected}
    <section class="review" aria-label="Undo review"><h2>Review change</h2>
      <p>{selected.action} · {selected.targetPublicId} · Revision {selected.revision}</p>
      <p>Restore the task fields changed by this operation?</p>
      <button disabled={disabled || pending} onclick={confirm}>{attempt ? 'Retry undo' : 'Confirm undo'}</button>
      {#if !attempt}<button onclick={() => selected = undefined}>Cancel</button>{/if}
    </section>
  {/if}
  {#if loadError}<p role="alert">Could not load activity.</p>
  {:else if !page}<p role="status">Loading activity…</p>
  {:else}
    {#if !page.page.length}<p>No activity on this page.</p>{/if}
    <ol>{#each page.page as row (row.eventId)}
      <li><strong>{row.action.replaceAll('.', ' · ')}</strong>
        <small>{row.actor} · {row.origin} · <time datetime={new Date(row.createdAt).toISOString()}>{format.format(row.createdAt)}</time></small>
        {#if row.reason}<p>{row.reason}</p>{/if}
        {#if row.targetKind === 'task'}<button disabled={!!selected} onclick={() => onOpenTask(row.targetPublicId)}>Open task</button>{/if}
        {#if row.undoEligible}<button disabled={disabled || !!selected} onclick={() => review(row)}>Review undo</button>{/if}
      </li>
    {/each}</ol>
    {#if cursors.length > 1 || !page.isDone}
      <nav aria-label="Activity pages"><button disabled={!!selected || cursors.length === 1} onclick={() => cursors = cursors.slice(0,-1)}>Previous page</button>
        <button disabled={!!selected || page.isDone} onclick={() => page && (cursors = [...cursors,page.continueCursor])}>Next page</button></nav>
    {/if}
  {/if}
</section>
<style>
  .activity {padding:var(--planner-gutter);max-width:56rem} ol {list-style:none;padding:0}
  li, .review {padding:1rem 0;border-bottom:1px solid var(--planner-border)} small {display:block;color:var(--planner-text-muted)}
  button {min-height:44px;margin:.4rem .45rem .1rem 0}
</style>
