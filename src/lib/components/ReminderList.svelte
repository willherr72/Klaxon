<script lang="ts">
  import { dayHeader, dayKey } from "../time";
  import type { Reminder } from "../types";
  import EmptyState from "./EmptyState.svelte";
  import ReminderItem from "./ReminderItem.svelte";

  let {
    reminders,
    selectedId,
    onSelect,
    onComplete,
    onDelete,
  }: {
    reminders: Reminder[];
    selectedId: string | null;
    onSelect: (r: Reminder) => void;
    onComplete: (r: Reminder) => void;
    onDelete: (r: Reminder) => void;
  } = $props();

  type Group = { key: string; header: string; items: Reminder[] };

  let groups = $derived.by<Group[]>(() => {
    const byDay = new Map<string, Group>();
    for (const r of reminders) {
      const k = dayKey(r.due_at);
      if (!byDay.has(k)) {
        byDay.set(k, { key: k, header: dayHeader(r.due_at), items: [] });
      }
      byDay.get(k)!.items.push(r);
    }
    return Array.from(byDay.values()).sort((a, b) =>
      a.key.localeCompare(b.key),
    );
  });
</script>

<section class="list">
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
</style>
