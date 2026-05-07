<script lang="ts">
  import { api } from "../api";
  import {
    enable as enableAutostart,
    disable as disableAutostart,
    isEnabled as autostartIsEnabled,
  } from "@tauri-apps/plugin-autostart";
  import { openPath } from "@tauri-apps/plugin-opener";
  import SignalLight from "./SignalLight.svelte";
  import SyncSection from "./SyncSection.svelte";
  import type { Priority } from "../types";
  import { keyEventToCombo, prettyShortcut } from "../shortcut";

  let { open, onClose }: { open: boolean; onClose: () => void } = $props();

  type PrioConfig = { count: number; intervalSecs: number };

  let lowCfg = $state<PrioConfig>({ count: 1, intervalSecs: 0 });
  let normalCfg = $state<PrioConfig>({ count: 5, intervalSecs: 8 });
  let highCfg = $state<PrioConfig>({ count: 30, intervalSecs: 4 });
  let autostart = $state(false);
  let dataDirPath = $state("");
  let globalHotkey = $state("Ctrl+Alt+KeyN");
  let recordingHotkey = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let savedFlash = $state(false);

  $effect(() => {
    if (open) loadAll();
  });

  async function loadAll() {
    error = null;
    try {
      const settings = await api.listSettings();
      const num = (k: string, fallback: number) => {
        const v = settings[k];
        const n = v != null ? Number.parseInt(v, 10) : NaN;
        return Number.isFinite(n) ? n : fallback;
      };
      lowCfg = {
        count: num("repeat_count_low", 1),
        intervalSecs: num("repeat_interval_secs_low", 0),
      };
      normalCfg = {
        count: num("repeat_count_normal", 5),
        intervalSecs: num("repeat_interval_secs_normal", 8),
      };
      highCfg = {
        count: num("repeat_count_high", 30),
        intervalSecs: num("repeat_interval_secs_high", 4),
      };
      globalHotkey = settings["global_hotkey_new"] ?? "Ctrl+Alt+KeyN";
      recordingHotkey = false;
      try {
        autostart = await autostartIsEnabled();
      } catch (e) {
        console.warn("autostart status check failed", e);
        autostart = false;
      }
      try {
        dataDirPath = await api.dataDir();
      } catch (e) {
        dataDirPath = "—";
      }
    } catch (e) {
      console.error("load settings failed", e);
      error = String(e);
    }
  }

  async function save() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      await Promise.all([
        api.setSetting("repeat_count_low", String(lowCfg.count)),
        api.setSetting("repeat_interval_secs_low", String(lowCfg.intervalSecs)),
        api.setSetting("repeat_count_normal", String(normalCfg.count)),
        api.setSetting("repeat_interval_secs_normal", String(normalCfg.intervalSecs)),
        api.setSetting("repeat_count_high", String(highCfg.count)),
        api.setSetting("repeat_interval_secs_high", String(highCfg.intervalSecs)),
      ]);
      try {
        if (autostart) await enableAutostart();
        else await disableAutostart();
      } catch (e) {
        console.warn("autostart toggle failed", e);
      }
      try {
        await api.setGlobalHotkey(globalHotkey ?? "");
      } catch (e) {
        console.error("hotkey save failed", e);
        error = `Could not register hotkey: ${e}`;
      }
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
    } catch (e) {
      console.error("save settings failed", e);
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function openDataDir() {
    if (!dataDirPath || dataDirPath === "—") return;
    try {
      await openPath(dataDirPath);
    } catch (e) {
      console.error("open data dir failed", e);
    }
  }

  function reset() {
    lowCfg = { count: 1, intervalSecs: 0 };
    normalCfg = { count: 5, intervalSecs: 8 };
    highCfg = { count: 30, intervalSecs: 4 };
    globalHotkey = "Ctrl+Alt+KeyN";
    recordingHotkey = false;
  }

  function captureHotkey(e: KeyboardEvent) {
    if (!recordingHotkey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      recordingHotkey = false;
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      e.stopPropagation();
      globalHotkey = "";
      recordingHotkey = false;
      return;
    }
    const combo = keyEventToCombo(e);
    if (combo) {
      e.preventDefault();
      e.stopPropagation();
      globalHotkey = combo;
      recordingHotkey = false;
    }
  }

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.floor(n)));
  }
</script>

<svelte:window onkeydown={(e) => {
  if (!open) return;
  if (recordingHotkey) {
    captureHotkey(e);
    return;
  }
  if (e.key === "Escape") onClose();
}} />

{#if open}
  <div
    class="overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
    onkeydown={(e) => {
      if (e.key === "Escape" && e.target === e.currentTarget) onClose();
    }}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="modal">
      <div class="sweep-bar"><div class="sweep"></div></div>

      <header class="head">
        <div class="head-left">
          <span class="lamp"></span>
          <h2 class="display title">SYSTEM CONFIG</h2>
        </div>
        <button class="close" onclick={onClose} aria-label="Close">×</button>
      </header>

      <div class="body">
        {#if error}
          <div class="error mono-caps">⚠ {error}</div>
        {/if}

        <section class="section">
          <div class="section-head">
            <span class="section-tick"></span>
            <h3 class="mono-caps section-title">Alert Behavior</h3>
            <span class="section-line"></span>
          </div>
          <div class="section-help mono-caps-faint">
            How many times each priority replays its tone, and the gap between repeats.
          </div>

          {#each [["low", lowCfg], ["normal", normalCfg], ["high", highCfg]] as entry (entry[0])}
            {@const key = entry[0] as Priority}
            {@const cfg = entry[1] as PrioConfig}
            <div class="prio-row">
              <div class="prio-head">
                <SignalLight priority={key} size={11} pulse={key === "high"} />
                <span class="mono-caps prio-label">{key}</span>
              </div>
              <div class="prio-fields">
                <label class="field">
                  <span class="mono-caps-faint field-label">Count</span>
                  <input
                    type="number"
                    min="1"
                    max="999"
                    value={cfg.count}
                    oninput={(e) => {
                      const n = clamp(Number((e.target as HTMLInputElement).value) || 0, 1, 999);
                      if (key === "low") lowCfg = { ...lowCfg, count: n };
                      else if (key === "normal") normalCfg = { ...normalCfg, count: n };
                      else highCfg = { ...highCfg, count: n };
                    }}
                  />
                </label>
                <label class="field">
                  <span class="mono-caps-faint field-label">Interval</span>
                  <div class="suffix-input">
                    <input
                      type="number"
                      min="0"
                      max="3600"
                      value={cfg.intervalSecs}
                      oninput={(e) => {
                        const n = clamp(Number((e.target as HTMLInputElement).value) || 0, 0, 3600);
                        if (key === "low") lowCfg = { ...lowCfg, intervalSecs: n };
                        else if (key === "normal") normalCfg = { ...normalCfg, intervalSecs: n };
                        else highCfg = { ...highCfg, intervalSecs: n };
                      }}
                    />
                    <span class="suffix mono-caps-faint">SEC</span>
                  </div>
                </label>
              </div>
            </div>
          {/each}
        </section>

        <section class="section">
          <div class="section-head">
            <span class="section-tick"></span>
            <h3 class="mono-caps section-title">Hotkeys</h3>
            <span class="section-line"></span>
          </div>
          <div class="section-help mono-caps-faint">
            System-wide hotkey for opening a new reminder from anywhere.
          </div>
          <div class="hotkey-row">
            <span class="hotkey-label-text">Global · New Reminder</span>
            <button
              class="hotkey-btn"
              class:recording={recordingHotkey}
              onclick={() => (recordingHotkey = !recordingHotkey)}
            >
              {#if recordingHotkey}
                <span class="rec-dot"></span>
                <span>Press combo… (Esc cancel · Del clear)</span>
              {:else}
                <span class="hotkey-value">{prettyShortcut(globalHotkey)}</span>
              {/if}
            </button>
            <button
              class="hotkey-clear"
              onclick={() => { globalHotkey = ""; recordingHotkey = false; }}
              disabled={!globalHotkey}
            >
              Clear
            </button>
          </div>
        </section>

        <section class="section">
          <div class="section-head">
            <span class="section-tick"></span>
            <h3 class="mono-caps section-title">Startup</h3>
            <span class="section-line"></span>
          </div>

          <label class="toggle-row">
            <input
              type="checkbox"
              bind:checked={autostart}
              class="toggle-input"
            />
            <span class="toggle-knob"></span>
            <span class="toggle-text">
              <span class="toggle-title">Launch on system startup</span>
              <span class="mono-caps-faint">Klaxon will run in the tray after login</span>
            </span>
          </label>
        </section>

        <SyncSection />

        <section class="section">
          <div class="section-head">
            <span class="section-tick"></span>
            <h3 class="mono-caps section-title">System</h3>
            <span class="section-line"></span>
          </div>
          <div class="meta-grid">
            <span class="mono-caps-faint">Database</span>
            <div class="path-row">
              <code class="path">{dataDirPath || "—"}</code>
              <button class="open-btn" onclick={openDataDir} disabled={!dataDirPath || dataDirPath === "—"}>
                Reveal
              </button>
            </div>
            <span class="mono-caps-faint">Version</span>
            <span class="meta-value">v0.2.0-dev · industrial</span>
          </div>
        </section>
      </div>

      <footer class="actions">
        <button class="btn ghost" onclick={reset} disabled={busy}>Reset Defaults</button>
        <div class="spacer"></div>
        {#if savedFlash}
          <span class="saved-flash mono-caps">● Saved</span>
        {/if}
        <button class="btn ghost" onclick={onClose} disabled={busy}>Close</button>
        <button class="btn primary" onclick={save} disabled={busy}>
          {busy ? "Saving…" : "Apply"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 160ms var(--ease);
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal {
    width: min(640px, 92vw);
    max-height: 90vh;
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.75);
    display: flex;
    flex-direction: column;
    position: relative;
    animation: rise 200ms var(--ease);
  }
  @keyframes rise {
    from { transform: translateY(12px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }

  .sweep-bar {
    height: 3px;
    overflow: hidden;
    position: relative;
    background: var(--bg);
  }
  .sweep {
    position: absolute; inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--klaxon) 50%,
      transparent 100%
    );
    animation: sweep 3s linear infinite;
  }
  @keyframes sweep {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 22px 14px;
    border-bottom: 1px solid var(--border);
  }
  .head-left {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .lamp {
    width: 10px;
    height: 10px;
    background: var(--klaxon);
    border-radius: 50%;
    box-shadow: 0 0 12px var(--klaxon-glow-strong);
  }
  .title {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .close {
    width: 32px;
    height: 32px;
    color: var(--text-muted);
    font-size: 22px;
    line-height: 1;
    transition: color 120ms var(--ease);
  }
  .close:hover { color: var(--text); }

  .body {
    flex: 1;
    overflow-y: auto;
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  .error {
    color: var(--signal-high);
    border: 1px solid var(--signal-high);
    padding: 8px 12px;
    background: rgba(255, 59, 48, 0.06);
    font-size: 11px;
    letter-spacing: 0.18em;
  }

  .section { display: flex; flex-direction: column; gap: 10px; }
  .section-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .section-tick {
    width: 8px;
    height: 1px;
    background: var(--klaxon);
  }
  .section-title {
    color: var(--text-2);
    letter-spacing: 0.22em;
    font-size: 11px;
  }
  .section-line {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .section-help {
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.14em;
    margin-bottom: 4px;
  }

  .prio-row {
    display: grid;
    grid-template-columns: 130px 1fr;
    align-items: center;
    gap: 18px;
    padding: 8px 0;
  }
  .prio-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .prio-label {
    color: var(--text);
    letter-spacing: 0.22em;
    font-weight: 700;
    font-size: 11px;
  }
  .prio-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .field-label {
    font-size: 9px;
    letter-spacing: 0.22em;
  }
  .field input {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    transition: border-color 120ms var(--ease);
  }
  .field input:focus { border-color: var(--klaxon); }

  .suffix-input {
    display: flex;
    align-items: stretch;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    transition: border-color 120ms var(--ease);
  }
  .suffix-input:focus-within { border-color: var(--klaxon); }
  .suffix-input input {
    flex: 1;
    border: none;
    background: transparent;
    padding: 8px 10px;
  }
  .suffix-input input:focus { border: none; }
  .suffix {
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-left: 1px solid var(--border);
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }

  /* Toggle */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
    cursor: pointer;
  }
  .toggle-input {
    appearance: none;
    width: 0;
    height: 0;
    margin: 0;
    padding: 0;
    border: none;
    pointer-events: none;
  }
  .toggle-knob {
    flex-shrink: 0;
    position: relative;
    width: 44px;
    height: 22px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    transition: all 140ms var(--ease);
  }
  .toggle-knob::before {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    background: var(--text-muted);
    transition: all 140ms var(--ease);
  }
  .toggle-input:checked + .toggle-knob {
    border-color: var(--klaxon);
    background: rgba(255, 157, 0, 0.08);
  }
  .toggle-input:checked + .toggle-knob::before {
    left: 25px;
    background: var(--klaxon);
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
  }
  .toggle-text {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .toggle-title {
    font-size: 12px;
    color: var(--text);
    font-weight: 500;
  }

  /* Meta */
  .meta-grid {
    display: grid;
    grid-template-columns: 110px 1fr;
    align-items: center;
    gap: 10px 16px;
  }
  .path-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .path {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-2);
    background: var(--bg-surface);
    border: 1px solid var(--border);
    padding: 6px 10px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open-btn {
    padding: 6px 10px;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    transition: all 120ms var(--ease);
  }
  .open-btn:hover {
    color: var(--klaxon);
    border-color: var(--klaxon);
  }
  .open-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .meta-value {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-2);
  }

  /* Actions */
  .actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 22px 18px;
    border-top: 1px solid var(--border);
  }
  .spacer { flex: 1; }
  .btn {
    padding: 9px 16px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .btn:hover { color: var(--text); border-color: var(--border-bright); }
  .btn.ghost { background: transparent; }
  .btn.primary {
    background: var(--klaxon);
    color: var(--bg);
    border-color: var(--klaxon);
  }
  .btn.primary:hover {
    background: transparent;
    color: var(--klaxon);
    box-shadow: 0 0 18px var(--klaxon-glow);
  }
  .btn.primary:disabled,
  .btn.ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    box-shadow: none;
  }
  .saved-flash {
    color: var(--ok);
    font-size: 10px;
    letter-spacing: 0.22em;
    animation: fadeIn 200ms var(--ease);
  }

  /* Hotkeys */
  .hotkey-row {
    display: grid;
    grid-template-columns: 180px 1fr auto;
    align-items: center;
    gap: 12px;
  }
  .hotkey-label-text {
    font-size: 11px;
    color: var(--text-2);
    letter-spacing: 0.04em;
  }
  .hotkey-btn {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 14px;
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.12em;
    text-align: left;
    transition: all 120ms var(--ease);
    min-height: 38px;
  }
  .hotkey-btn:hover {
    border-color: var(--border-bright);
  }
  .hotkey-btn.recording {
    border-color: var(--klaxon);
    color: var(--klaxon);
    background: rgba(255, 157, 0, 0.05);
    box-shadow: inset 0 0 18px var(--klaxon-glow);
  }
  .rec-dot {
    width: 8px;
    height: 8px;
    background: var(--klaxon);
    border-radius: 50%;
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
    animation: pulse 1s var(--ease) infinite;
  }
  .hotkey-value {
    font-family: var(--font-mono);
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.12em;
  }
  .hotkey-clear {
    padding: 8px 12px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    transition: all 120ms var(--ease);
  }
  .hotkey-clear:hover:not(:disabled) {
    color: var(--signal-high);
    border-color: var(--signal-high);
  }
  .hotkey-clear:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
