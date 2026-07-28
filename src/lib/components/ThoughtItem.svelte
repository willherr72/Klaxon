<script lang="ts">
  import { relativeTime } from "../time";
  import type { Thought } from "../types";

  let {
    thought,
    snippet,
    onEdit,
    onDelete,
    onMakeTask,
    onMakeReminder,
    onTagClick,
  }: {
    thought: Thought;
    snippet?: string;
    onEdit: (id: string, body: string) => Promise<void> | void;
    onDelete: (t: Thought) => void;
    onMakeTask: (t: Thought) => void;
    onMakeReminder: (t: Thought) => void;
    onTagClick?: (tag: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let expanded = $state(false);
  let editEl: HTMLTextAreaElement | null = $state(null);

  // Tapping outside a live edit commits it. Mobile has no Esc key, so
  // otherwise Enter would be the only way out of edit mode. Saving rather
  // than discarding means a stray tap never throws typing away — the
  // thought is still there to re-edit. Esc still cancels on desktop.
  $effect(() => {
    if (!editing) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      if (editEl && target && editEl.contains(target)) return;
      void commit();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  });

  let lines = $derived(thought.body.split("\n"));
  let heading = $derived(lines[0]);
  let rest = $derived(lines.slice(1).join("\n"));
  let isLong = $derived(lines.length > 6 || thought.body.length > 400);

  function startEdit() {
    draft = thought.body;
    editing = true;
  }

  async function commit() {
    const text = draft.trim();
    if (!text) {
      // Refuse to blank a thought via edit. Leaving edit mode here would
      // silently discard whatever the user cleared, so stay put.
      return;
    }
    if (text === thought.body) {
      // Nothing changed — close without a pointless write and sync push.
      editing = false;
      return;
    }
    await onEdit(thought.id, text);
    editing = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      editing = false;
    }
  }
</script>

<div class="thought">
  <div class="body" class:expanded>
    {#if editing}
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        bind:this={editEl}
        bind:value={draft}
        onkeydown={onKeydown}
        autofocus
      ></textarea>
      <div class="hint mono-caps-faint">Enter or tap away saves · Esc cancels</div>
    {:else if snippet}
      <!-- The <mark> tags come from SQLite's FTS5 snippet() function, not
           from user input — SQLite escapes the stored text before
           inserting the markers. -->
      <div class="snippet">{@html snippet}</div>
    {:else}
      <div class="heading">{heading}</div>
      {#if rest}
        <div class="rest">{rest}</div>
      {/if}
      {#if isLong && !expanded}
        <button class="more" type="button" onclick={() => (expanded = true)}>
          Show more
        </button>
      {/if}
    {/if}
  </div>

  <div class="meta">
    {#each thought.tags as t (t)}
      <button
        class="tag-pill"
        type="button"
        title="Filter by #{t}"
        onclick={() => onTagClick?.(t)}
      >
        #{t}
      </button>
    {/each}
    <span class="time">{relativeTime(thought.created_at)}</span>
  </div>

  <div class="actions">
    <button class="action" title="Edit" onclick={startEdit}>✎</button>
    <button class="action" title="Make a task" onclick={() => onMakeTask(thought)}>
      ○
    </button>
    <button
      class="action"
      title="Make a reminder"
      onclick={() => onMakeReminder(thought)}
    >
      ◎
    </button>
    <button class="action danger" title="Delete" onclick={() => onDelete(thought)}>
      ×
    </button>
  </div>
</div>

<style>
  .thought {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: start;
    gap: 14px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    transition: background 120ms var(--ease);
    animation: fadeUp 220ms var(--ease) both;
  }
  .thought:hover {
    background: var(--bg-hover);
  }

  .body {
    min-width: 0;
    max-height: 8.4em;
    overflow: hidden;
  }
  .body.expanded {
    max-height: none;
  }
  .heading {
    font-size: 13px;
    font-weight: 500;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .rest,
  .snippet {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 3px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .snippet :global(mark) {
    background: rgba(255, 157, 0, 0.22);
    color: var(--text);
  }
  .more {
    margin-top: 4px;
    border: none;
    background: none;
    padding: 0;
    color: var(--klaxon);
    font-size: 10px;
    cursor: pointer;
  }

  textarea {
    width: 100%;
    min-height: 70px;
    resize: vertical;
    border: 1px solid var(--klaxon);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    padding: 8px 10px;
  }
  textarea:focus {
    outline: none;
  }
  .hint {
    margin-top: 4px;
    font-size: 9px;
    letter-spacing: 0.12em;
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 2px;
  }
  /* Matches the reminder tag pill exactly — one tag vocabulary, one look. */
  .tag-pill {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    padding: 2px 7px;
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.05);
    color: var(--klaxon);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .tag-pill:hover {
    background: var(--klaxon);
    color: var(--bg);
  }
  .time {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .actions {
    display: flex;
    gap: 4px;
  }
  /* Always visible, muted by default — same reasoning as ReminderItem:
   * reveal-on-hover leaks clicks on touch. */
  .action {
    width: 26px;
    height: 26px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-muted);
    font-size: 13px;
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
