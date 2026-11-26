<script lang="ts">
  import type { ConvexClient } from 'convex/browser';
  import { makeFunctionReference } from 'convex/server';
  import { tick } from 'svelte';
  import { errorCode } from '../contracts';
  import { routeLabels, type PlannerDestination } from '../planner-shell/routes';

  type Matches = {tasks:{publicId:string;title:string;status:string}[];notes:{publicId:string;localDate:string;excerpt:string}[];partial:boolean};
  const search = makeFunctionReference<'query',{workspaceId:string;text:string},Matches>('organization:search');
  let {client,workspaceId,destinations,disabled,onNavigate,onOpenTask,onCreate,onUnauthenticated}: {
    client:ConvexClient;workspaceId:string;destinations:readonly PlannerDestination[];disabled:boolean;
    onNavigate:(href:string)=>void;onOpenTask:(publicId:string)=>void;onCreate:(kind:'task'|'capture')=>void;onUnauthenticated:()=>void;
  } = $props();
  let modal: HTMLDialogElement;
  let input: HTMLInputElement;
  let open = $state(false);
  let text = $state('');
  let result = $state.raw<Matches>();
  let error = $state('');
  const term = $derived(text.trim());
  const routes = $derived(destinations.filter(d => routeLabels[d.id].toLowerCase().includes(term.toLowerCase())));
  $effect(() => {
    result = undefined;
    error = '';
    if (!open || !term) return;
    const args = {workspaceId,text:term};
    const currentClient = client;
    let stop: (()=>void) | undefined;
    const timer = window.setTimeout(() => {
      stop = currentClient.onUpdate(search,args,value => { result = value; error = ''; }, reason => {
        if (errorCode(reason) === 'UNAUTHENTICATED') onUnauthenticated();
        else error = 'Could not search this workspace.';
      });
    },160);
    return () => { window.clearTimeout(timer); stop?.(); };
  });
  async function show() {
    if (disabled || modal.open) return;
    text = '';
    open = true;
    modal.showModal();
    await tick();
    input.focus();
  }
  function shortcut(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey
      || event.key.toLowerCase() !== 'k' || disabled || open || (event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable="true"]'))) return;
    event.preventDefault();
    void show();
  }
  function choose(action: () => void) {
    modal.close();
    action();
  }
</script>

<svelte:window onkeydown={shortcut}/>
<button {disabled} onclick={show} aria-label="Search and commands" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">Search</button>
<dialog bind:this={modal} aria-label="Search and commands" onclose={() => { open = false; text = ''; }}>
  <header><h2>Search and commands</h2><button onclick={() => modal.close()}>Close</button></header>
  <label>Search workspace<input bind:this={input} type="search" bind:value={text} maxlength="256" autocomplete="off" /></label>
  {#if !term}
    <section aria-label="Create"><button onclick={() => choose(() => onCreate('task'))}>New task</button>
      <button onclick={() => choose(() => onCreate('capture'))}>Quick capture</button></section>
  {/if}
  {#if routes.length}
    <nav aria-label="Go to">{#each routes as destination (destination.id)}
      <button onclick={() => choose(() => onNavigate(destination.href))}>{routeLabels[destination.id]}</button>
    {/each}</nav>
  {/if}
  {#if term}
    {#if error}<p role="alert">{error}</p>
    {:else if !result}<p role="status">Searching…</p>
    {:else}
      {#if result.tasks.length}<h3>Tasks</h3>
        <ul>{#each result.tasks as task (task.publicId)}
          <li><button onclick={() => choose(() => onOpenTask(task.publicId))}>{task.title}</button></li>
        {/each}</ul>{/if}
      {#if result.notes.length}<h3>Day notes</h3>
        <ul>{#each result.notes as note (note.publicId)}<li><strong>{note.localDate}</strong><p>{note.excerpt}</p></li>{/each}</ul>{/if}
      {#if !result.notes.length && !result.tasks.length}<p>No matching tasks or day notes.</p>{/if}
      {#if result.partial}<p>Refine your search to see more matches.</p>{/if}
    {/if}
  {/if}
</dialog>

<style>
  dialog {box-sizing:border-box;width:min(36rem, calc(100vw - 2rem));max-height:80svh;overflow:auto;
    color:var(--planner-text);background:var(--planner-surface);border:1px solid var(--planner-border);border-radius:.6rem;
    box-shadow:0 1rem 4rem #0004;padding:clamp(1rem,3vw,2rem)}
  dialog::backdrop {background:#15141288}
  header,nav,section {display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  header {justify-content:space-between} h2 {margin:0}
  label {display:grid;gap:.4rem;margin:1rem 0} input {font:inherit;min-height:44px}
  nav,section {margin:.75rem 0} button {min-height:44px;cursor:pointer}
  ul {list-style:none;padding:0} li {border-top:1px solid var(--planner-border);padding:.4rem 0}
  li button {font:inherit;text-align:left;width:100%;background:none;color:inherit;border:0}
</style>
