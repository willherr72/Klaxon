<script lang="ts">
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { api, type TaskStep } from "../api";
  let { taskId }: { taskId: string } = $props();
  let steps = $state<TaskStep[]>([]);
  let draft = $state("");
  let error = $state("");
  let busy = $state(false);
  let editing = $state<string | null>(null);
  let editTitle = $state("");
  async function refresh() { steps = await api.listSteps(taskId); }
  onMount(() => {
    let closed = false;
    let stop: (() => void) | undefined;
    refresh().catch(e => error = String(e));
    listen("klaxon://reminders-changed", () => {
      if (!closed) refresh().catch(e => error = String(e));
    }).then(unlisten => { if (closed) unlisten(); else stop = unlisten; });
    return () => { closed = true; stop?.(); };
  });
  async function act(action: () => Promise<unknown>) {
    busy = true; error = "";
    try { await action(); await refresh(); } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function add() {
    const title = draft.trim();
    if (title) await act(async () => { await api.addStep(taskId, title); draft = ""; });
  }
</script>
<section class="steps" aria-label="Task steps">
  <h3>Steps <span>{steps.filter(s => s.completed).length}/{steps.length}</span></h3>
  <p class="hint">Step changes save immediately.</p>
  <ol>
    {#each steps as step, i (step.id)}
      <li>
        <input type="checkbox" checked={step.completed} disabled={busy} aria-label="Complete {step.title}"
          onchange={() => act(() => api.updateStep(step.id, null, !step.completed))} />
        {#if editing === step.id}
          <input aria-label="Step title" bind:value={editTitle} maxlength="500" />
          <button disabled={busy || !editTitle.trim()} onclick={() => act(async () => {
            await api.updateStep(step.id, editTitle, null); editing = null;
          })}>Save step</button>
          <button onclick={() => editing = null}>Cancel</button>
        {:else}
          <button class="title" class:done={step.completed} onclick={() => { editing = step.id; editTitle = step.title; }}>{step.title}</button>
        {/if}
        <button disabled={busy || i === 0} aria-label="Move {step.title} up" onclick={() => act(() => api.moveStep(step.id, steps[i-1].id))}>↑</button>
        <button disabled={busy || i === steps.length-1} aria-label="Move {step.title} down" onclick={() => act(() => api.moveStep(step.id, steps[i+2]?.id ?? null))}>↓</button>
        <button disabled={busy} aria-label="Delete {step.title}" onclick={() => act(() => api.deleteStep(step.id))}>×</button>
      </li>
    {/each}
  </ol>
  <form onsubmit={e => { e.preventDefault(); add(); }}>
    <input aria-label="New step" placeholder="Add a step…" bind:value={draft} maxlength="500" />
    <button disabled={busy || !draft.trim()}>Add step</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
</section>
<style>
  .steps { margin: 18px 0; } h3 { font-size: 13px; } h3 span, .hint { opacity: .6; font-size: 11px; }
  ol { list-style: none; padding: 0; } li, form { display: flex; gap: 6px; margin: 6px 0; align-items: center; }
  button, input { color: inherit; background: transparent; border: 1px solid #444; border-radius: 4px; padding: 6px; }
  .title { flex: 1; text-align: left; overflow-wrap: anywhere; } .done { text-decoration: line-through; opacity: .6; }
  input:not([type=checkbox]) { flex: 1; min-width: 0; } button:disabled { opacity: .35; }
  [role=alert] { color: #f88; }
</style>
