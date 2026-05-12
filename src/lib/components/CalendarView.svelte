<script lang="ts">
  import { effectiveDueAt } from "../time";
  import type { Reminder } from "../types";
  import SignalLight from "./SignalLight.svelte";

  let {
    reminders,
    onSelect,
  }: {
    reminders: Reminder[];
    onSelect: (r: Reminder) => void;
  } = $props();

  let cursorDate = $state(startOfMonth(new Date()));

  function startOfMonth(d: Date): Date {
    const c = new Date(d.getFullYear(), d.getMonth(), 1);
    c.setHours(0, 0, 0, 0);
    return c;
  }

  function addMonths(d: Date, n: number): Date {
    return startOfMonth(new Date(d.getFullYear(), d.getMonth() + n, 1));
  }

  function formatTime(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // 42 cells = 6 weeks * 7 days starting at the Sunday before the 1st of
  // cursorDate's month. Cells outside the cursor month are dimmed.
  let cells = $derived.by(() => {
    const first = cursorDate;
    const startDayOfWeek = first.getDay();
    const start = new Date(first);
    start.setDate(first.getDate() - startDayOfWeek);

    const todayMs = (() => {
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      return t.getTime();
    })();

    const result: {
      date: Date;
      inMonth: boolean;
      isToday: boolean;
      isPast: boolean;
      reminders: Reminder[];
    }[] = [];

    for (let i = 0; i < 42; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      date.setHours(0, 0, 0, 0);

      const inMonth = date.getMonth() === first.getMonth();
      const isToday = date.getTime() === todayMs;
      const isPast = date.getTime() < todayMs;

      const dayStart = date.getTime();
      const dayEnd = dayStart + 86_400_000;
      const dayReminders = reminders
        .filter((r) => {
          const t = effectiveDueAt(r);
          return t >= dayStart && t < dayEnd;
        })
        .sort((a, b) => effectiveDueAt(a) - effectiveDueAt(b));

      result.push({ date, inMonth, isToday, isPast, reminders: dayReminders });
    }
    return result;
  });

  const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const monthNames = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
  ];

  let label = $derived(`${monthNames[cursorDate.getMonth()]} ${cursorDate.getFullYear()}`);

  function prev() { cursorDate = addMonths(cursorDate, -1); }
  function next() { cursorDate = addMonths(cursorDate, 1); }
  function jumpToday() { cursorDate = startOfMonth(new Date()); }
</script>

<section class="cal">
  <header class="cal-head">
    <button class="nav-btn" onclick={prev} aria-label="Previous month">‹</button>
    <h2 class="display cal-title">{label}</h2>
    <button class="nav-btn" onclick={next} aria-label="Next month">›</button>
    <span class="spacer"></span>
    <button class="today-btn mono-caps" onclick={jumpToday}>Today</button>
  </header>

  <div class="weekdays">
    {#each dayNames as d (d)}
      <div class="weekday mono-caps-faint">{d}</div>
    {/each}
  </div>

  <div class="grid">
    {#each cells as cell (cell.date.toISOString())}
      <div
        class="cell"
        class:out={!cell.inMonth}
        class:today={cell.isToday}
        class:past={cell.isPast && !cell.isToday}
      >
        <div class="day-num">{cell.date.getDate()}</div>
        <div class="day-items">
          {#each cell.reminders.slice(0, 4) as r (r.id)}
            <button
              class="item"
              class:silent={r.silent}
              onclick={() => onSelect(r)}
              title="{r.title} · {formatTime(r.due_at)}"
            >
              <span class="item-glyph">
                {#if r.silent}
                  <span class="task-dot">○</span>
                {:else}
                  <SignalLight priority={r.priority} size={7} />
                {/if}
              </span>
              <span class="item-time">{formatTime(effectiveDueAt(r))}</span>
              <span class="item-title">{r.title}</span>
            </button>
          {/each}
          {#if cell.reminders.length > 4}
            <div class="more mono-caps-faint">
              +{cell.reminders.length - 4} more
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</section>

<style>
  .cal {
    grid-area: main;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    overflow: hidden;
  }

  .cal-head {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .nav-btn {
    width: 32px;
    height: 32px;
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .nav-btn:hover {
    color: var(--klaxon);
    border-color: var(--klaxon);
  }
  .cal-title {
    font-size: 26px;
    font-weight: 800;
    letter-spacing: 0.06em;
    color: var(--text);
    min-width: 240px;
    text-align: center;
  }
  .spacer { flex: 1; }
  .today-btn {
    padding: 7px 14px;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 10px;
    letter-spacing: 0.22em;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .today-btn:hover {
    color: var(--klaxon);
    border-color: var(--klaxon);
  }

  .weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .weekday {
    padding: 8px 12px;
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }

  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    grid-template-rows: repeat(6, 1fr);
    overflow: auto;
  }
  .cell {
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 4px 6px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-height: 88px;
    overflow: hidden;
    position: relative;
    background: var(--bg);
  }
  .cell.out {
    background: rgba(0, 0, 0, 0.25);
  }
  .cell.out .day-num { color: var(--text-faint); }
  .cell.past .day-num { color: var(--text-muted); }
  .cell.today {
    background: rgba(255, 157, 0, 0.05);
    box-shadow: inset 0 0 0 1px var(--klaxon);
  }
  .day-num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    color: var(--text-2);
    font-weight: 500;
    line-height: 1;
    padding: 2px 0 4px;
  }
  .cell.today .day-num {
    color: var(--klaxon);
    font-weight: 700;
    text-shadow: 0 0 8px var(--klaxon-glow-strong);
  }

  .day-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }
  .item {
    display: grid;
    grid-template-columns: 12px auto 1fr;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text);
    cursor: pointer;
    transition: all 120ms var(--ease);
    text-align: left;
    width: 100%;
    overflow: hidden;
  }
  .item:hover {
    border-color: var(--klaxon);
    background: var(--bg-active);
  }
  .item-glyph {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .task-dot {
    font-size: 9px;
    color: var(--text-muted);
    line-height: 1;
  }
  .item-time {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 9px;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }
  .item-title {
    font-size: 10px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item.silent .item-title {
    color: var(--text-2);
  }
  .more {
    font-size: 9px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    padding: 1px 6px;
  }
</style>
