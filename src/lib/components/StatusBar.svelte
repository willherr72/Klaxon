<script lang="ts">
  import { countdown } from "../time";
  import type { Reminder } from "../types";

  let {
    pendingCount,
    nextReminder,
    now,
  }: {
    pendingCount: number;
    nextReminder: Reminder | null;
    now: number;
  } = $props();

  let nextTarget = $derived(
    nextReminder ? (nextReminder.snooze_until ?? nextReminder.due_at) : null,
  );
  let nextText = $derived(
    nextTarget ? countdown(nextTarget, now) : "——",
  );
</script>

<footer class="status">
  <div class="bar"></div>
  <div class="cell">
    <span class="led ok"></span>
    <span class="mono-caps">Scheduler Active</span>
  </div>
  <div class="sep">·</div>
  <div class="cell">
    <span class="mono-caps-faint">Pending</span>
    <span class="num">{pendingCount}</span>
  </div>
  <div class="sep">·</div>
  <div class="cell">
    <span class="mono-caps-faint">Next In</span>
    <span class="num accent">{nextText}</span>
  </div>
  <div class="spacer"></div>
  <div class="cell tail">
    <span class="mono-caps-faint">Klaxon · v0.1</span>
  </div>
</footer>

<style>
  .status {
    grid-area: status;
    background: var(--bg-elev);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    padding: 0 18px;
    gap: 12px;
    font-size: 10px;
    position: relative;
  }
  .bar {
    position: absolute;
    top: -1px;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--border-strong) 8%,
      var(--border-strong) 92%,
      transparent 100%
    );
  }

  .cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .led {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 6px 1px var(--ok-glow);
    animation: blink 2.4s var(--ease) infinite;
  }
  @keyframes blink {
    0%, 92%, 100% { opacity: 1; }
    94% { opacity: 0.3; }
  }
  .num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text-2);
    letter-spacing: 0.06em;
  }
  .accent { color: var(--klaxon); }
  .sep { color: var(--text-faint); }
  .spacer { flex: 1; }
  .tail { opacity: 0.7; }
</style>
