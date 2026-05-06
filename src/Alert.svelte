<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { api } from "./lib/api";
  import type { Reminder } from "./lib/types";
  import SignalLight from "./lib/components/SignalLight.svelte";

  let reminder = $state<Reminder | null>(null);
  let timeLabel = $state("");
  let elapsed = $state(0); // ms since fire
  let busy = $state(false);
  let customMode = $state(false);
  let customMinutes = $state(30);
  let customInput: HTMLInputElement | null = $state(null);
  let isFullscreen = $derived(typeof window !== "undefined" && window.innerWidth > 800);

  let firedAt = Date.now();
  let tickHandle: number | null = null;

  function formatTime(ms: number) {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())} · ${d.toLocaleDateString("en", { weekday: "short", month: "short", day: "2-digit" }).toUpperCase()}`;
  }

  function formatElapsed(ms: number) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  async function loadReminder() {
    const win = getCurrentWindow();
    const id = win.label.replace(/^alert-/, "");
    if (!id) return;
    try {
      reminder = await api.getReminder(id);
      timeLabel = formatTime(reminder.due_at);
    } catch (e) {
      console.error("could not load reminder", e);
    }
  }

  async function dismiss() {
    if (!reminder || busy) return;
    busy = true;
    try {
      await api.dismissReminder(reminder.id);
    } catch (e) {
      console.error(e);
    }
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error(e);
    }
  }

  async function complete() {
    if (!reminder || busy) return;
    busy = true;
    try {
      await api.completeReminder(reminder.id);
    } catch (e) {
      console.error(e);
    }
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error(e);
    }
  }

  async function snooze(mins: number) {
    if (!reminder || busy) return;
    busy = true;
    const until = Date.now() + mins * 60_000;
    try {
      await api.snoozeReminder(reminder.id, until);
    } catch (e) {
      console.error(e);
    }
    try {
      await getCurrentWindow().close();
    } catch (e) {
      console.error(e);
    }
  }

  function startCustom() {
    customMode = true;
    setTimeout(() => {
      customInput?.focus();
      customInput?.select();
    }, 30);
  }

  function applyCustom() {
    const n = Math.floor(Number(customMinutes));
    if (Number.isFinite(n) && n > 0) snooze(n);
  }

  function cancelCustom() {
    customMode = false;
  }

  function onKey(e: KeyboardEvent) {
    if (customMode) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelCustom();
      }
      return; // let typing flow into the number input
    }
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      dismiss();
    } else if (e.key === " ") {
      e.preventDefault();
      snooze(5);
    }
  }

  onMount(() => {
    loadReminder();
    tickHandle = window.setInterval(() => {
      elapsed = Date.now() - firedAt;
    }, 500);
    window.addEventListener("keydown", onKey);
  });

  onDestroy(() => {
    if (tickHandle !== null) window.clearInterval(tickHandle);
    window.removeEventListener("keydown", onKey);
  });
</script>

<div
  class="alert"
  class:fullscreen={isFullscreen}
  class:high={reminder?.priority === "high"}
  class:normal={reminder?.priority === "normal"}
  class:low={reminder?.priority === "low"}
>
  <!-- Decorative top bar: amber sweep line + hazard stripes for high priority -->
  <div class="top-bar">
    <div class="sweep"></div>
    {#if reminder?.priority === "high"}
      <div class="hazard hazard-line"></div>
    {/if}
  </div>

  <header class="head" data-tauri-drag-region>
    <div class="head-left" data-tauri-drag-region>
      {#if reminder}
        <SignalLight
          priority={reminder.priority}
          size={isFullscreen ? 18 : 12}
          pulse
        />
      {/if}
      <span class="mono-caps tag">
        {#if reminder?.priority === "high"}
          URGENT REMINDER
        {:else}
          REMINDER · {reminder?.priority?.toUpperCase() ?? ""}
        {/if}
      </span>
    </div>
    <div class="head-right">
      <span class="mono-caps-faint">RUN {formatElapsed(elapsed)}</span>
    </div>
  </header>

  <div class="body">
    {#if reminder}
      <h1 class="title display">{reminder.title}</h1>
      {#if reminder.description}
        <p class="desc">{reminder.description}</p>
      {/if}
      <div class="meta">
        <span class="meta-piece mono-caps-faint">SET FOR</span>
        <span class="meta-time">{timeLabel}</span>
      </div>
    {:else}
      <h1 class="title display">…</h1>
    {/if}
  </div>

  <footer class="actions">
    <div class="snooze-row">
      <span class="mono-caps-faint snooze-label">Snooze</span>
      {#if customMode}
        <input
          bind:this={customInput}
          bind:value={customMinutes}
          type="number"
          min="1"
          max="9999"
          class="custom-input"
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyCustom();
            }
          }}
        />
        <span class="custom-unit mono-caps-faint">MIN</span>
        <button
          class="btn snooze"
          onclick={applyCustom}
          disabled={busy || !(customMinutes > 0)}
        >
          Set
        </button>
        <button class="btn ghost" onclick={cancelCustom} disabled={busy}>
          Cancel
        </button>
      {:else}
        <button class="btn snooze" onclick={() => snooze(5)} disabled={busy}>5m</button>
        <button class="btn snooze" onclick={() => snooze(15)} disabled={busy}>15m</button>
        <button class="btn snooze" onclick={() => snooze(60)} disabled={busy}>1h</button>
        <button class="btn snooze" onclick={startCustom} disabled={busy}>Custom…</button>
      {/if}
    </div>
    <div class="primary-row">
      {#if reminder?.repeat_rule}
        <button class="btn ghost" onclick={complete} disabled={busy}>Done</button>
      {/if}
      <button class="btn dismiss" onclick={dismiss} disabled={busy}>Dismiss</button>
    </div>
  </footer>

  {#if reminder?.priority === "high"}
    <div class="hazard hazard-line bottom-hazard"></div>
  {/if}
</div>

<style>
  :global(html, body) {
    background: var(--bg);
    overflow: hidden;
  }

  .alert {
    width: 100vw;
    height: 100vh;
    background: var(--bg);
    color: var(--text);
    display: grid;
    grid-template-rows: auto auto 1fr auto;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    box-sizing: border-box;
  }
  .alert.high {
    border-color: var(--signal-high);
    box-shadow: inset 0 0 60px rgba(255, 59, 48, 0.06);
  }
  .alert.normal {
    border-color: var(--klaxon-dim);
    box-shadow: inset 0 0 40px rgba(255, 157, 0, 0.05);
  }

  /* ── Top bar ── */
  .top-bar {
    height: 4px;
    position: relative;
    overflow: hidden;
    background: var(--bg-elev);
  }
  .sweep {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--klaxon) 50%,
      transparent 100%
    );
    animation: sweep 2.4s linear infinite;
  }
  .alert.high .sweep {
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--signal-high) 50%,
      transparent 100%
    );
    animation-duration: 1.2s;
  }
  @keyframes sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(100%);  }
  }

  .hazard-line {
    height: 8px;
    width: 100%;
  }
  .bottom-hazard { height: 8px; }

  /* ── Head ── */
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 22px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .head-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .tag {
    color: var(--text-2);
    letter-spacing: 0.22em;
    font-size: 10px;
    font-weight: 600;
  }
  .alert.high .tag { color: var(--signal-high); }
  .head-right { display: flex; gap: 8px; }

  /* ── Body ── */
  .body {
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
    min-height: 0;
  }
  .title {
    font-size: 32px;
    font-weight: 800;
    letter-spacing: 0.02em;
    line-height: 1.05;
    color: var(--text);
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .desc {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.5;
    max-width: 60ch;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
  }
  .meta-piece { letter-spacing: 0.18em; font-size: 9px; }
  .meta-time {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
    letter-spacing: 0.06em;
  }

  /* ── Actions ── */
  .actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 22px 18px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    gap: 16px;
  }
  .snooze-row, .primary-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .snooze-label {
    margin-right: 4px;
    letter-spacing: 0.22em;
    font-size: 9px;
  }

  .btn {
    padding: 9px 14px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .btn:hover { color: var(--text); border-color: var(--border-bright); }
  .btn:disabled { opacity: 0.4; cursor: wait; }

  .btn.snooze { min-width: 46px; padding: 9px 10px; }

  .custom-input {
    width: 64px;
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--klaxon-dim);
    color: var(--text);
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    font-size: 12px;
    transition: border-color 120ms var(--ease);
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .custom-input::-webkit-outer-spin-button,
  .custom-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .custom-input:focus { border-color: var(--klaxon); outline: none; }
  .custom-unit {
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
    margin-right: 2px;
  }
  .btn.ghost { color: var(--text-muted); }
  .btn.ghost:hover { color: var(--text-2); border-color: var(--border-bright); }

  .btn.dismiss {
    background: var(--klaxon);
    color: var(--bg);
    border-color: var(--klaxon);
    padding: 9px 22px;
  }
  .btn.dismiss:hover {
    background: transparent;
    color: var(--klaxon);
    box-shadow: 0 0 18px var(--klaxon-glow);
  }

  .alert.high .btn.dismiss {
    background: var(--signal-high);
    border-color: var(--signal-high);
    color: var(--bg);
  }
  .alert.high .btn.dismiss:hover {
    background: transparent;
    color: var(--signal-high);
    box-shadow: 0 0 22px var(--signal-high-glow);
  }

  /* ── Fullscreen variant (high priority) ── */
  .alert.fullscreen .head { padding: 22px 48px; }
  .alert.fullscreen .body {
    padding: 60px 80px;
    align-items: flex-start;
    justify-content: center;
    gap: 24px;
  }
  .alert.fullscreen .title {
    font-size: 96px;
    line-height: 0.95;
  }
  .alert.fullscreen .desc {
    font-size: 18px;
    max-width: 70ch;
  }
  .alert.fullscreen .meta-time { font-size: 14px; }
  .alert.fullscreen .actions { padding: 22px 48px 28px; }
  .alert.fullscreen .btn {
    padding: 14px 22px;
    font-size: 12px;
  }
  .alert.fullscreen .btn.dismiss {
    padding: 14px 36px;
    font-size: 14px;
  }
</style>
