<script lang="ts">
  import { effectiveDueAt, shortTime } from "../time";
  import type { Reminder } from "../types";
  import SignalLight from "./SignalLight.svelte";

  let {
    reminder,
    selected = false,
    onClick,
    onComplete,
    onDelete,
  }: {
    reminder: Reminder;
    selected?: boolean;
    onClick: (r: Reminder) => void;
    onComplete: (r: Reminder) => void;
    onDelete: (r: Reminder) => void;
  } = $props();

  let isHigh = $derived(reminder.priority === "high");
  let isCompleted = $derived(reminder.state === "completed");
  let isSilent = $derived(reminder.silent);
  let isSnoozed = $derived(reminder.state === "snoozed");
  let isRang = $derived(
    reminder.state === "fired" || reminder.state === "dismissed",
  );
</script>

<div
  class="item"
  class:high={isHigh}
  class:selected
  class:completed={isCompleted}
  role="button"
  tabindex="0"
  onclick={() => onClick(reminder)}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick(reminder);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDelete(reminder);
    }
  }}
>
  {#if isHigh}
    <div class="hazard-rail hazard"></div>
  {:else}
    <div class="rail"></div>
  {/if}

  <div class="signal">
    {#if isSilent}
      <span class="task-mark" class:done={isCompleted}>{isCompleted ? "✓" : "○"}</span>
    {:else}
      <SignalLight priority={reminder.priority} size={10} />
    {/if}
  </div>

  <div class="body">
    <div class="title">{reminder.title}</div>
    {#if reminder.description}
      <div class="desc">{reminder.description}</div>
    {/if}
  </div>

  <div class="meta">
    {#if isSnoozed}
      <span class="badge mono-caps-faint snoozed-badge">⏱ snoozed</span>
    {/if}
    {#if isRang}
      <span class="badge mono-caps-faint rang-badge">● rang</span>
    {/if}
    {#if isSilent}
      <span class="badge mono-caps-faint task-badge">Task</span>
    {/if}
    {#if reminder.repeat_rule}
      <span class="badge mono-caps-faint">↻ {reminder.repeat_rule.kind}</span>
    {/if}
    <span class="time">{shortTime(effectiveDueAt(reminder))}</span>
  </div>

  <div class="actions">
    <button
      class="action"
      title="Complete"
      onclick={(e) => { e.stopPropagation(); onComplete(reminder); }}
    >✓</button>
    <button
      class="action danger"
      title="Delete"
      onclick={(e) => { e.stopPropagation(); onDelete(reminder); }}
    >×</button>
  </div>
</div>

<style>
  .item {
    display: grid;
    grid-template-columns: 6px 24px 1fr auto auto;
    align-items: center;
    gap: 14px;
    padding: 14px 16px 14px 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 120ms var(--ease), border-color 120ms var(--ease);
    animation: fadeUp 220ms var(--ease) both;
    position: relative;
  }
  .item:hover {
    background: var(--bg-hover);
  }
  .item.selected {
    background: var(--bg-surface);
  }
  .item.completed {
    opacity: 0.42;
  }
  .item.completed .title {
    text-decoration: line-through;
    text-decoration-color: var(--text-muted);
  }

  .rail {
    width: 2px;
    height: 28px;
    background: var(--border);
    margin-left: 14px;
  }
  .hazard-rail {
    width: 6px;
    height: 100%;
    align-self: stretch;
  }
  .item.high {
    grid-template-columns: 6px 24px 1fr auto auto;
  }

  .signal { display: flex; align-items: center; justify-content: center; }
  .task-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--text-muted);
    color: var(--text-muted);
    font-size: 9px;
    line-height: 1;
    transition: all 120ms var(--ease);
  }
  .task-mark.done {
    border-color: var(--ok);
    color: var(--ok);
    background: rgba(34, 197, 94, 0.08);
  }
  .task-badge {
    color: var(--text-2);
    border-color: var(--border-bright);
  }
  .snoozed-badge {
    color: var(--klaxon);
    border-color: var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.06);
  }
  .rang-badge {
    color: var(--text-muted);
    border-color: var(--border-strong);
    background: rgba(255, 255, 255, 0.02);
  }

  .body { min-width: 0; }
  .title {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .desc {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .badge {
    padding: 2px 6px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-size: 9px;
  }
  .time {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
  }

  .actions {
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 120ms var(--ease);
  }
  .item:hover .actions { opacity: 1; }
  .action {
    width: 26px;
    height: 26px;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 14px;
    line-height: 1;
    transition: all 100ms var(--ease);
  }
  .action:hover {
    border-color: var(--klaxon);
    color: var(--klaxon);
  }
  .action.danger:hover {
    border-color: var(--signal-high);
    color: var(--signal-high);
  }
</style>
