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
  <div class="steps-head">
    <h3 class="mono-caps-faint">Steps</h3>
    <span class="step-count">{steps.filter(s => s.completed).length}/{steps.length}</span>
  </div>
  <p class="hint">Step changes save immediately.</p>
  <ol>
    {#each steps as step, i (step.id)}
      <li>
        <input class="step-check" type="checkbox" checked={step.completed} disabled={busy} aria-label="Complete {step.title}"
          onchange={() => act(() => api.updateStep(step.id, null, !step.completed))} />
        <div class="step-content">
          {#if editing === step.id}
            <input class="step-input" aria-label="Step title" bind:value={editTitle} maxlength="500" />
            <div class="edit-actions">
              <button class="step-btn" disabled={busy || !editTitle.trim()} onclick={() => act(async () => {
                await api.updateStep(step.id, editTitle, null); editing = null;
              })}>Save step</button>
              <button class="step-btn" onclick={() => editing = null}>Cancel</button>
            </div>
          {:else}
            <button class="title" class:done={step.completed} onclick={() => { editing = step.id; editTitle = step.title; }}>{step.title}</button>
          {/if}
        </div>
        <div class="step-actions">
          <button class="icon-btn" disabled={busy || i === 0} aria-label="Move {step.title} up" title="Move up" onclick={() => act(() => api.moveStep(step.id, steps[i-1].id))}>↑</button>
          <button class="icon-btn" disabled={busy || i === steps.length-1} aria-label="Move {step.title} down" title="Move down" onclick={() => act(() => api.moveStep(step.id, steps[i+2]?.id ?? null))}>↓</button>
          <button class="icon-btn danger" disabled={busy} aria-label="Delete {step.title}" title="Delete step" onclick={() => act(() => api.deleteStep(step.id))}>×</button>
        </div>
      </li>
    {/each}
  </ol>
  <form onsubmit={e => { e.preventDefault(); add(); }}>
    <input class="step-input" aria-label="New step" placeholder="Add a step…" bind:value={draft} maxlength="500" />
    <button class="step-btn" disabled={busy || !draft.trim()}>Add step</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .steps { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .steps-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .step-count { font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .hint { font-size: 10px; color: var(--text-muted); }
  ol { list-style: none; }
  li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .step-content { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .step-check {
    appearance: none; width: 18px; height: 18px; margin-top: 5px;
    position: relative; background: var(--bg-surface); border: 1px solid var(--border-strong);
    border-radius: 0; cursor: pointer; transition: border-color 120ms var(--ease);
  }
  .step-check:checked { border-color: var(--klaxon); background: var(--klaxon-glow); }
  .step-check:checked::after { content: ""; position: absolute; left: 5px; top: 2px; width: 5px; height: 9px; border: solid var(--klaxon); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  .step-check:focus-visible { outline: 1px solid var(--klaxon); outline-offset: 2px; }
  .title { width: 100%; min-height: 28px; padding: 4px 2px; text-align: left; font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; color: var(--text-2); }
  .title:hover { color: var(--text); background: var(--bg-hover); }
  .title.done { text-decoration: line-through; color: var(--text-muted); }
  .step-actions, .edit-actions { display: flex; gap: 4px; }
  .edit-actions { flex-wrap: wrap; }
  .icon-btn { width: 28px; height: 28px; border: 1px solid var(--border-strong); color: var(--text-muted); transition: all 120ms var(--ease); }
  .icon-btn:hover:not(:disabled) { color: var(--klaxon); border-color: var(--klaxon-dim); }
  .icon-btn.danger:hover:not(:disabled) { color: var(--signal-high); border-color: var(--signal-high); }
  .step-input { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 0; background: var(--bg-surface); color: var(--text); font-family: var(--font-mono); font-size: 11px; transition: border-color 120ms var(--ease); }
  .step-input:focus { border-color: var(--klaxon); }
  .step-input::placeholder { color: var(--text-muted); }
  form { display: flex; gap: 6px; margin-top: 4px; }
  form .step-input { flex: 1; }
  .step-btn { padding: 8px 10px; border: 1px solid var(--border-strong); color: var(--text-2); font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; letter-spacing: 0.14em; transition: all 120ms var(--ease); }
  .step-btn:hover:not(:disabled) { color: var(--klaxon); border-color: var(--klaxon-dim); }
  button:disabled, .step-check:disabled { opacity: 0.4; cursor: not-allowed; }
  .error { padding: 8px 10px; border: 1px solid var(--signal-high); color: var(--signal-high); font-size: 11px; overflow-wrap: anywhere; }
</style>
