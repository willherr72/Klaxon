<script lang="ts">
  import { dayHeader, dayKey, effectiveDueAt } from "../time";
  import type { Reminder } from "../types";
  import EmptyState from "./EmptyState.svelte";
  import ReminderItem from "./ReminderItem.svelte";

  let {
    reminders,
    selectedId,
    onSelect,
    onComplete,
    onDelete,
    onTagClick,
    searchOpen = false,
    searchQuery = $bindable(""),
    onSearchClose,
    sortOrder = "date_asc",
  }: {
    reminders: Reminder[];
    selectedId: string | null;
    onSelect: (r: Reminder) => void;
    onComplete: (r: Reminder) => void;
    onDelete: (r: Reminder) => void;
    onTagClick?: (tag: string) => void;
    searchOpen?: boolean;
    searchQuery?: string;
    onSearchClose?: () => void;
    sortOrder?: "date_asc" | "date_desc";
  } = $props();

  let searchInput: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (searchOpen && searchInput) {
      // Defer focus so the slide-in animation has begun.
      const t = setTimeout(() => searchInput?.focus(), 60);
      return () => clearTimeout(t);
    }
  });

  type Group = { key: string; header: string; items: Reminder[] };

  let groups = $derived.by<Group[]>(() => {
    const byDay = new Map<string, Group>();
    for (const r of reminders) {
      const t = effectiveDueAt(r);
      const k = dayKey(t);
      if (!byDay.has(k)) {
        byDay.set(k, { key: k, header: dayHeader(t), items: [] });
      }
      byDay.get(k)!.items.push(r);
    }
    const arr = Array.from(byDay.values());
    arr.sort((a, b) =>
      sortOrder === "date_desc"
        ? b.key.localeCompare(a.key)
        : a.key.localeCompare(b.key),
    );
    return arr;
  });
</script>

<section class="list">
  {#if searchOpen}
    <div class="search-row">
      <span class="search-icon mono-caps-faint">⌕</span>
      <input
        bind:this={searchInput}
        bind:value={searchQuery}
        type="text"
        class="search-input"
        placeholder="Search reminders…"
        onkeydown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onSearchClose?.();
          }
        }}
      />
      {#if searchQuery}
        <span class="search-count mono-caps-faint">{reminders.length}</span>
      {/if}
      <button
        class="search-close"
        onclick={() => onSearchClose?.()}
        aria-label="Close search"
      >×</button>
    </div>
  {/if}

  {#if reminders.length === 0}
    <EmptyState />
  {:else}
    {#each groups as g (g.key)}
      <div class="group">
        <div class="group-header">
          <span class="group-tick"></span>
          <span class="mono-caps">{g.header}</span>
          <span class="group-line"></span>
          <span class="mono-caps-faint">{g.items.length}</span>
        </div>
        <div class="group-items">
          {#each g.items as r (r.id)}
            <ReminderItem
              reminder={r}
              selected={selectedId === r.id}
              onClick={onSelect}
              onComplete={onComplete}
              onDelete={onDelete}
              onTagClick={onTagClick}
            />
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</section>

<style>
  .list {
    grid-area: main;
    overflow-y: auto;
    background: var(--bg);
    padding: 8px 0 32px;
  }

  .group + .group { margin-top: 28px; }

  .group-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 24px 10px;
    color: var(--text-2);
  }
  .group-tick {
    width: 8px;
    height: 1px;
    background: var(--klaxon);
  }
  .group-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  /* Search bar */
  .search-row {
    position: sticky;
    top: 0;
    z-index: 5;
    display: grid;
    grid-template-columns: 24px 1fr auto auto;
    align-items: center;
    gap: 10px;
    padding: 12px 24px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    animation: searchSlideIn 180ms var(--ease);
  }
  @keyframes searchSlideIn {
    from { transform: translateY(-100%); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }
  .search-icon {
    font-size: 14px;
    color: var(--klaxon);
    text-align: center;
  }
  .search-input {
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border-strong);
    transition: border-color 120ms var(--ease);
  }
  .search-input:focus {
    outline: none;
    border-bottom-color: var(--klaxon);
  }
  .search-input::placeholder { color: var(--text-faint); }
  .search-count {
    padding: 2px 8px;
    border: 1px solid var(--border-strong);
    font-size: 10px;
    color: var(--text-2);
  }
  .search-close {
    width: 26px;
    height: 26px;
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 120ms var(--ease);
  }
  .search-close:hover { color: var(--text); }
</style>
