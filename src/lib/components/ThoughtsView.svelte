<script lang="ts">
  import { untrack } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { api } from "../api";
  import type { TagCount, Thought, ThoughtHit } from "../types";
  import EmptyState from "./EmptyState.svelte";
  import ThoughtComposer from "./ThoughtComposer.svelte";
  import ThoughtItem from "./ThoughtItem.svelte";

  let {
    onMakeTask,
    onMakeReminder,
  }: {
    onMakeTask: (body: string) => void;
    onMakeReminder: (body: string) => void;
  } = $props();

  const PAGE = 50;

  let rows = $state<Thought[]>([]);
  let hits = $state<ThoughtHit[]>([]);
  let tags = $state<TagCount[]>([]);
  let query = $state("");
  let activeTag = $state<string | null>(null);
  let offset = $state(0);
  let hasMore = $state(true);
  let loading = $state(false);
  let sentinel: HTMLDivElement | null = $state(null);
  // Which thought is open for editing. A single value here is what makes
  // "only one editor at a time" structural — opening one necessarily
  // closes the last, with nothing to keep in step.
  let editingId = $state<string | null>(null);

  let searching = $derived(query.trim().length > 0);

  async function loadFirstPage() {
    loading = true;
    offset = 0;
    try {
      if (query.trim().length > 0) {
        hits = await api.searchThoughts(query, activeTag, PAGE, 0);
        rows = [];
        hasMore = hits.length === PAGE;
      } else {
        rows = await api.listThoughts(activeTag, PAGE, 0);
        hits = [];
        hasMore = rows.length === PAGE;
      }
      tags = await api.thoughtTagCounts();
    } catch (e) {
      console.error("load thoughts failed", e);
    } finally {
      loading = false;
    }
  }

  async function loadNextPage() {
    if (loading || !hasMore) return;
    loading = true;
    const next = offset + PAGE;
    try {
      if (query.trim().length > 0) {
        const more = await api.searchThoughts(query, activeTag, PAGE, next);
        hits = [...hits, ...more];
        hasMore = more.length === PAGE;
      } else {
        const more = await api.listThoughts(activeTag, PAGE, next);
        rows = [...rows, ...more];
        hasMore = more.length === PAGE;
      }
      offset = next;
    } catch (e) {
      console.error("load more thoughts failed", e);
    } finally {
      loading = false;
    }
  }

  // Debounce so a fast typist doesn't fire a query per keystroke. 150ms is
  // below the threshold where search stops feeling live.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  function onQueryInput() {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void loadFirstPage(), 150);
  }

  function toggleTag(tag: string) {
    activeTag = activeTag === tag ? null : tag;
    void loadFirstPage();
  }

  async function create(body: string) {
    await api.createThought({ body, tags: [] });
    await loadFirstPage();
  }

  async function edit(id: string, body: string) {
    await api.updateThought(id, { body });
    await loadFirstPage();
  }

  function startEdit(t: Thought) {
    editingId = t.id;
  }

  /// Only clear if this item is still the open one. A tap on another
  /// thought's edit button commits the first *and* opens the second, and
  /// the commit finishes last — without this guard it would close the
  /// editor the user just opened.
  function endEdit(id: string) {
    if (editingId === id) editingId = null;
  }

  async function remove(t: Thought) {
    await api.deleteThought(t.id);
    await loadFirstPage();
  }

  $effect(() => {
    // untrack matters here: loadFirstPage reads `query` and `activeTag`
    // synchronously, so without it this effect would re-run on every
    // keystroke — firing a query per character and defeating the debounce
    // entirely. This effect is meant to run once, on mount.
    untrack(() => void loadFirstPage());
    // Sync applies land in the backend, which emits this — mirrors how the
    // app already reacts to klaxon://reminders-changed.
    const stop = listen("klaxon://thoughts-changed", () => {
      untrack(() => void loadFirstPage());
    });
    return () => {
      void stop.then((un) => un());
    };
  });

  // Infinite scroll: fetch the next page when the bottom sentinel appears.
  $effect(() => {
    if (!sentinel) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadNextPage();
    });
    io.observe(sentinel);
    return () => io.disconnect();
  });
</script>

<div class="thoughts">
  <ThoughtComposer onCreate={create} />

  <div class="toolbar">
    <input
      class="search"
      type="search"
      placeholder="Search thoughts…"
      bind:value={query}
      oninput={onQueryInput}
    />
    {#if activeTag}
      <button
        class="active-tag"
        type="button"
        title="Clear tag filter"
        onclick={() => toggleTag(activeTag ?? "")}
      >
        #{activeTag} ×
      </button>
    {/if}
  </div>

  {#if tags.length > 0}
    <div class="tagbar">
      {#each tags as t (t.tag)}
        <button
          class="tag-pill"
          class:on={activeTag === t.tag}
          type="button"
          onclick={() => toggleTag(t.tag)}
        >
          #{t.tag} <span class="count">{t.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="feed">
    {#if searching}
      {#each hits as hit (hit.thought.id)}
        <ThoughtItem
          thought={hit.thought}
          snippet={hit.snippet}
          editing={editingId === hit.thought.id}
          onEdit={edit}
          onStartEdit={startEdit}
          onEndEdit={endEdit}
          onDelete={remove}
          onMakeTask={(t) => onMakeTask(t.body)}
          onMakeReminder={(t) => onMakeReminder(t.body)}
          onTagClick={toggleTag}
        />
      {:else}
        <EmptyState
          primary="No Matches"
          secondary="Nothing found · Try another term"
        />
      {/each}
    {:else}
      {#each rows as t (t.id)}
        <ThoughtItem
          thought={t}
          editing={editingId === t.id}
          onEdit={edit}
          onStartEdit={startEdit}
          onEndEdit={endEdit}
          onDelete={remove}
          onMakeTask={(x) => onMakeTask(x.body)}
          onMakeReminder={(x) => onMakeReminder(x.body)}
          onTagClick={toggleTag}
        />
      {:else}
        <EmptyState
          primary="No Thoughts"
          secondary="Capture one above · Nothing filed"
        />
      {/each}
    {/if}
    <div bind:this={sentinel} class="sentinel"></div>
  </div>
</div>

<style>
  .thoughts {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
  }
  .search {
    flex: 1;
    border: 1px solid var(--border-strong);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    padding: 7px 10px;
  }
  .search:focus {
    outline: none;
    border-color: var(--klaxon);
  }
  .active-tag {
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 4px 8px;
    border: 1px solid var(--klaxon);
    background: var(--klaxon);
    color: var(--bg);
    cursor: pointer;
  }
  .tagbar {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
  }
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
  .tag-pill.on,
  .tag-pill:hover {
    background: var(--klaxon);
    color: var(--bg);
  }
  .count {
    opacity: 0.7;
  }
  .feed {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .sentinel {
    height: 1px;
  }
</style>
