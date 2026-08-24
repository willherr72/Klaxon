<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api } from "../api";
  import { localDayKey, dayBounds } from "../day";
  import { effectiveDueAt } from "../time";
  import type { Reminder } from "../types";
  import DayPanel from "./DayPanel.svelte";
  import SignalLight from "./SignalLight.svelte";

  let {
    reminders,
    allReminders,
    onSelect,
    onCreateForDate,
    panelOpen = $bindable(false),
  }: {
    // The grid's own filtered view — whatever the active view/search/tag
    // filter currently allows. Feeds `cells` below.
    reminders: Reminder[];
    // The complete, unfiltered reminder list, independent of `reminders`.
    // The day panel answers "what actually happened this day" (spec:
    // fired/dismissed/completed included), which is a different question
    // from "what does the current filter show" — so the grid and the panel
    // can legitimately disagree on count while a search or tag filter is
    // active. That is intended, not a bug: do not collapse this back to a
    // single prop.
    allReminders: Reminder[];
    onSelect: (r: Reminder) => void;
    onCreateForDate?: (ms: number, silent: boolean) => void;
    // Bindable so App.svelte can see whether the day panel is open and
    // fold it into its Android-back-button registry (App.svelte:135-167).
    // App.svelte only ever reads this and never writes it directly —
    // closing must go through `closePanel()` below so the note flushes.
    panelOpen?: boolean;
  } = $props();

  // Right-click context menu state. Position is in viewport coords; we
  // clamp to the window if the menu would overflow.
  let menuOpen = $state(false);
  let menuX = $state(0);
  let menuY = $state(0);
  let menuDate = $state<Date | null>(null);

  /** Build a timestamp on the given calendar date that defaults to the
   * current local time-of-day. Slightly more useful than always landing on
   * midnight — most reminders want a sensible hour. */
  function timestampForCell(cellDate: Date): number {
    const now = new Date();
    const target = new Date(cellDate);
    target.setHours(now.getHours(), now.getMinutes(), 0, 0);
    return target.getTime();
  }

  function handleCellContextMenu(cellDate: Date, e: MouseEvent) {
    if (!onCreateForDate) return;
    e.preventDefault();
    e.stopPropagation();
    // Clamp so the menu (≈220×96 px) doesn't fall off-screen.
    const menuW = 220;
    const menuH = 96;
    const pad = 8;
    menuX = Math.min(e.clientX, window.innerWidth - menuW - pad);
    menuY = Math.min(e.clientY, window.innerHeight - menuH - pad);
    menuDate = cellDate;
    menuOpen = true;
  }

  function closeMenu() {
    menuOpen = false;
    menuDate = null;
  }

  function chooseFromMenu(silent: boolean) {
    if (!menuDate || !onCreateForDate) {
      closeMenu();
      return;
    }
    onCreateForDate(timestampForCell(menuDate), silent);
    closeMenu();
  }

  function formatMenuHeader(d: Date | null): string {
    if (!d) return "";
    const months = [
      "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
      "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    return `${String(d.getDate()).padStart(2, "0")} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }

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

      // Real local midnight-to-midnight, not `+ 86_400_000` — a DST
      // transition day is 23 or 25 hours, and the naive form put a
      // boundary-adjacent reminder in the wrong cell (or two cells, or
      // none) on those days. Must match DayPanel's `dayBounds`, or the
      // grid and the panel disagree about which day an item belongs to.
      const { startMs: dayStart, endMs: dayEnd } = dayBounds(date);
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

  let selectedDate = $state<Date | null>(null);
  let daysWithNotes = $state<Set<string>>(new Set());
  let daysWithThoughts = $state<Set<string>>(new Set());
  // Instance ref to the DayPanel so closePanel() below can go through its
  // real close() (flush-then-close), not just flip `panelOpen` and skip
  // the flush.
  let dayPanelRef: DayPanel | undefined = $state();

  function openDay(d: Date) {
    selectedDate = d;
    panelOpen = true;
  }

  // Called by App.svelte's Android-back-button handler. Must go through
  // DayPanel's own close() — flush lives entirely in DayPanel's private
  // state (pending/saveChain), so there is no way to flush from out here
  // other than delegating to it.
  export function closePanel() {
    dayPanelRef?.close();
  }

  function onCellKeydown(d: Date, e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDay(d);
    }
  }

  // Markers for the visible range. The backend hands back raw thought
  // timestamps rather than per-day counts — bucketing needs the local
  // calendar, which only the frontend has. Factored out of the $effect so
  // the klaxon://day-notes-changed listener below can also trigger it —
  // reading `cells` here still tracks the effect's dependency as long as
  // the read happens synchronously inside the effect callback.
  function fetchDaySummaries() {
    const first = cells[0]?.date;
    const last = cells[cells.length - 1]?.date;
    if (!first || !last) return;
    const from = localDayKey(first);
    const to = localDayKey(last);
    const { startMs } = dayBounds(first);
    const { endMs } = dayBounds(last);
    api
      .daySummaries(from, to, startMs, endMs)
      .then((s) => {
        daysWithNotes = new Set(s.days_with_notes);
        daysWithThoughts = new Set(
          s.thought_times.map((ms) => localDayKey(new Date(ms))),
        );
      })
      .catch((e) => console.error("daySummaries failed", e));
  }

  $effect(() => {
    fetchDaySummaries();
  });

  // A note written and the panel closed, or one arriving by sync while the
  // calendar is on screen, must move the ▪ marker without the user
  // navigating away and back. `reminders-changed` doesn't cover this (the
  // App.svelte publish cache skips identical rows, and notes aren't
  // reminders anyway) — this is the only signal for it.
  let unlistenNotes: UnlistenFn | null = null;
  let destroyed = false;
  onMount(async () => {
    const un = await listen("klaxon://day-notes-changed", () => {
      fetchDaySummaries();
    });
    if (destroyed) {
      un();
    } else {
      unlistenNotes = un;
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (unlistenNotes) unlistenNotes();
  });

  const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const monthNames = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
  ];

  let label = $derived(`${monthNames[cursorDate.getMonth()]} ${cursorDate.getFullYear()}`);

  // The grid always renders 42 cells, so leading/trailing overflow from
  // adjacent months always repeats low day-of-month numbers within the same
  // grid (e.g. day "3" as both this month's 3rd and next month's overflow
  // 3rd) — a bare day number is not a unique accessible name. Match
  // DayPanel's heading shape ("23 August 2026") so the full date, which is
  // unique per cell by construction, is what gets announced.
  function cellLabel(d: Date): string {
    return `Open ${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
  }

  function prev() { cursorDate = addMonths(cursorDate, -1); }
  function next() { cursorDate = addMonths(cursorDate, 1); }
  function jumpToday() { cursorDate = startOfMonth(new Date()); }
</script>

<svelte:window
  onclick={() => menuOpen && closeMenu()}
  oncontextmenu={(e) => {
    // Close on right-click anywhere outside a calendar cell.
    if (menuOpen) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest?.(".cell")) closeMenu();
    }
  }}
  onkeydown={(e) => { if (menuOpen && e.key === "Escape") closeMenu(); }}
/>

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
        class:selected={selectedDate !== null &&
          localDayKey(selectedDate) === localDayKey(cell.date)}
        role="gridcell"
        tabindex="0"
        aria-label={cellLabel(cell.date)}
        onclick={() => openDay(cell.date)}
        onkeydown={(e) => onCellKeydown(cell.date, e)}
        oncontextmenu={(e) => handleCellContextMenu(cell.date, e)}
      >
        <div class="day-num">{cell.date.getDate()}</div>
        <div class="day-items">
          {#each cell.reminders.slice(0, 4) as r (r.id)}
            <button
              class="item"
              class:silent={r.silent}
              onclick={(e) => { e.stopPropagation(); onSelect(r); }}
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
        <div class="markers" aria-hidden="true">
          {#each cell.reminders.slice(0, 3) as r (r.id)}
            <span class="dot" class:done={r.state === "completed" || r.state === "dismissed" || r.state === "fired"}></span>
          {/each}
          {#if daysWithNotes.has(localDayKey(cell.date))}
            <span class="glyph note-glyph">▪</span>
          {/if}
          {#if daysWithThoughts.has(localDayKey(cell.date))}
            <span class="glyph thought-glyph">•</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <DayPanel
    bind:this={dayPanelRef}
    open={panelOpen}
    date={selectedDate}
    reminders={allReminders}
    onClose={() => (panelOpen = false)}
    onSelect={(r) => { panelOpen = false; onSelect(r); }}
    onCreateForDate={(ms, silent) => { panelOpen = false; onCreateForDate?.(ms, silent); }}
  />
</section>

{#if menuOpen && menuDate}
  <div
    class="ctx-menu"
    style:left="{menuX}px"
    style:top="{menuY}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { if (e.key === "Escape") closeMenu(); }}
    role="menu"
    tabindex="-1"
  >
    <div class="ctx-header mono-caps-faint">{formatMenuHeader(menuDate)}</div>
    <button class="ctx-item" onclick={() => chooseFromMenu(false)} role="menuitem">
      <span class="ctx-glyph dot"></span>
      <span class="ctx-label">Make Reminder</span>
    </button>
    <button class="ctx-item" onclick={() => chooseFromMenu(true)} role="menuitem">
      <span class="ctx-glyph ring">○</span>
      <span class="ctx-label">Make Task</span>
    </button>
  </div>
{/if}

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
    /* Was a plain div with no handlers; it now owns click/keyboard
       activation, so it needs the interactive-affordance treatment. */
    font-family: inherit;
    text-align: left;
    cursor: pointer;
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
  .cell.selected {
    box-shadow: inset 0 0 0 1px var(--klaxon-dim);
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

  /* Right-click context menu */
  .ctx-menu {
    position: fixed;
    z-index: 200;
    width: 220px;
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    box-shadow:
      0 14px 38px rgba(0, 0, 0, 0.7),
      0 0 0 1px rgba(255, 157, 0, 0.08);
    display: flex;
    flex-direction: column;
    padding: 4px 0;
    animation: ctxIn 110ms var(--ease);
  }
  @keyframes ctxIn {
    from { opacity: 0; transform: translateY(-3px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .ctx-header {
    padding: 8px 14px 6px;
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .ctx-item {
    display: grid;
    grid-template-columns: 22px 1fr;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    background: transparent;
    border: none;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-align: left;
    cursor: pointer;
    transition: all 100ms var(--ease);
  }
  .ctx-item:hover {
    background: var(--bg-active);
    color: var(--klaxon);
  }
  .ctx-glyph.dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--klaxon);
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
    justify-self: center;
  }
  .ctx-glyph.ring {
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1;
    text-align: center;
  }
  .ctx-item:hover .ctx-glyph.ring { color: var(--klaxon); }
  .more {
    font-size: 9px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    padding: 1px 6px;
  }

  .markers { display: none; gap: 3px; align-items: center; padding: 0 4px 4px; }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--klaxon);
  }
  .dot.done { background: var(--text-faint); }
  .glyph { font-size: 8px; line-height: 1; color: var(--text-muted); }
  .note-glyph { color: var(--klaxon-dim); }

  /* This component's first mobile rules. A 45px cell cannot render a title,
     so stop trying: show the day number and density markers, and let the
     panel carry the detail. */
  @media (max-width: 1024px) {
    .day-items { display: none; }
    .markers { display: flex; }
    .cell { min-height: 44px; }
  }
</style>
