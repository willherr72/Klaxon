<script lang="ts">
  import { countdown } from "../time";
  import type { FilterKey, Reminder } from "../types";

  let {
    filter,
    nextReminder,
    now,
  }: {
    filter: FilterKey;
    nextReminder: Reminder | null;
    now: number;
  } = $props();

  const titles: Record<FilterKey, string> = {
    all: "ALL REMINDERS",
    today: "TODAY",
    upcoming: "UPCOMING",
    recurring: "RECURRING",
    completed: "COMPLETED",
  };

  let label = $derived(titles[filter]);
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
    justify-content: space-between;
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

  .right {
    display: flex;
    align-items: center;
    gap: 14px;
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
