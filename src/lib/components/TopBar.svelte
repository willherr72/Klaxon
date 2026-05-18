<script lang="ts">
  import { countdown } from "../time";
  import type { Reminder, TimeFilter, ViewMode } from "../types";

  let {
    view,
    timeFilter,
    onTimeFilterChange,
    tagFilter = null,
    onTagFilterClear,
    nextReminder,
    now,
  }: {
    view: ViewMode;
    timeFilter: TimeFilter;
    onTimeFilterChange: (t: TimeFilter) => void;
    tagFilter?: string | null;
    onTagFilterClear?: () => void;
    nextReminder: Reminder | null;
    now: number;
  } = $props();

  const titles: Record<ViewMode, string> = {
    reminders: "REMINDERS",
    tasks: "TASKS",
    calendar: "CALENDAR",
    completed: "COMPLETED",
  };

  const filterChips: { key: TimeFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "today", label: "Today" },
    { key: "upcoming", label: "Upcoming" },
    { key: "recurring", label: "Recurring" },
  ];

  let showChips = $derived(view === "reminders" || view === "tasks");
  let label = $derived(titles[view]);
  let nextTarget = $derived(
    nextReminder ? (nextReminder.snooze_until ?? nextReminder.due_at) : null,
  );
  let countdownText = $derived(
    nextTarget ? countdown(nextTarget, now) : "—— : —— : ——",
  );
</script>

<header class="topbar">
  <div class="scan"></div>
  <div class="left">
    <div class="dot"></div>
    <h1 class="display title">{label}</h1>
  </div>

  {#if showChips}
    <div class="chips">
      {#each filterChips as chip (chip.key)}
        <button
          class="chip"
          class:active={timeFilter === chip.key}
          onclick={() => onTimeFilterChange(chip.key)}
        >
          {chip.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if tagFilter}
    <button class="tag-filter" onclick={() => onTagFilterClear?.()}>
      <span class="tag-filter-hash">#</span>
      <span class="tag-filter-name">{tagFilter}</span>
      <span class="tag-filter-x">×</span>
    </button>
  {/if}

  <div class="right">
    <span class="mono-caps-faint">Next In</span>
    <span class="countdown" class:active={!!nextTarget}>
      {countdownText}
    </span>
  </div>
</header>

<style>
  .topbar {
    grid-area: topbar;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 24px;
    padding: 0 24px;
    position: relative;
  }
  .scan {
    position: absolute;
    top: 0;
    left: 0;
    height: 1px;
    width: 100%;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--klaxon) 50%,
      transparent 100%
    );
    opacity: 0.35;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
  }
  .dot {
    width: 8px;
    height: 8px;
    background: var(--klaxon);
    box-shadow: 0 0 8px 1px var(--klaxon-glow-strong);
    border-radius: 50%;
  }
  .title {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 0.05em;
    line-height: 1;
  }

  .chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }
  .chip {
    padding: 6px 12px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    background: transparent;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .chip:hover {
    color: var(--text-2);
    border-color: var(--border-bright);
  }
  .chip.active {
    color: var(--klaxon);
    border-color: var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.05);
    box-shadow: inset 0 0 12px rgba(255, 157, 0, 0.08);
  }

  .tag-filter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--klaxon);
    background: rgba(255, 157, 0, 0.08);
    color: var(--klaxon);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .tag-filter:hover {
    background: var(--klaxon);
    color: var(--bg);
  }
  .tag-filter-hash { opacity: 0.7; }
  .tag-filter-x { margin-left: 4px; font-size: 12px; line-height: 1; }

  .right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
    margin-left: auto;
  }
  .countdown {
    font-family: var(--font-mono);
    font-size: 18px;
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    padding: 4px 10px;
    border: 1px solid var(--border);
    background: var(--bg-elev);
    min-width: 110px;
    text-align: center;
  }
  .countdown.active {
    color: var(--klaxon);
    border-color: var(--klaxon-dim);
    box-shadow: inset 0 0 12px var(--klaxon-glow);
  }
</style>
