<script lang="ts">
  import { api, type NlParsed } from "../api";
  import type { ReminderCreate } from "../types";

  let {
    open,
    onClose,
    onCreate,
  }: {
    open: boolean;
    onClose: () => void;
    onCreate: (input: ReminderCreate) => Promise<void> | void;
  } = $props();

  let input = $state("");
  let parsed = $state<NlParsed | null>(null);
  let parseError = $state<string | null>(null);
  let busy = $state(false);
  let inputEl: HTMLInputElement | null = $state(null);

  $effect(() => {
    if (open) {
      input = "";
      parsed = null;
      parseError = null;
      busy = false;
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  // Re-parse on every change. Tauri IPC is fast enough that we don't need
  // to debounce; latency-wise it feels instantaneous.
  let parseSeq = 0;
  async function reparse() {
    if (!input.trim()) {
      parsed = null;
      parseError = null;
      return;
    }
    const seq = ++parseSeq;
    try {
      const r = await api.nlParse(input);
      if (seq !== parseSeq) return; // stale
      parsed = r;
      parseError = null;
    } catch (e: unknown) {
      if (seq !== parseSeq) return;
      const msg =
        e && typeof e === "object" && "message" in e
          ? String((e as { message: string }).message)
          : String(e);
      parsed = null;
      parseError = msg;
    }
  }

  $effect(() => {
    void input;
    if (open) reparse();
  });

  function formatTarget(ms: number): { dateLine: string; relLine: string } {
    const d = new Date(ms);
    const weekdays = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const months = [
      "JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC",
    ];
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateLine = `${weekdays[d.getDay()]} ${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const diff = ms - Date.now();
    let relLine: string;
    if (diff < 0) {
      relLine = "in the past";
    } else if (diff < 60_000) {
      relLine = "in under a minute";
    } else if (diff < 3_600_000) {
      relLine = `in ${Math.round(diff / 60_000)} min`;
    } else if (diff < 86_400_000) {
      const h = Math.floor(diff / 3_600_000);
      const m = Math.round((diff % 3_600_000) / 60_000);
      relLine = m ? `in ${h}h ${m}m` : `in ${h}h`;
    } else {
      const days = Math.floor(diff / 86_400_000);
      const h = Math.round((diff % 86_400_000) / 3_600_000);
      relLine = h ? `in ${days}d ${h}h` : `in ${days}d`;
    }
    return { dateLine, relLine };
  }

  async function commit() {
    if (busy || !parsed) return;
    busy = true;
    const reminder: ReminderCreate = {
      title: parsed.title,
      description: null,
      due_at: parsed.due_at_ms,
      priority: "normal",
      sound_path: null,
      repeat_rule: null,
      silent: false,
      tags: parsed.tags,
    };
    try {
      await onCreate(reminder);
      onClose();
    } catch (e) {
      console.error("quick-add create failed", e);
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
  }
</script>

{#if open}
  <div
    class="overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onkeydown={(e) => { if (e.key === "Escape") onClose(); }}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="modal">
      <div class="sweep-bar"><div class="sweep"></div></div>

      <header class="head">
        <div class="head-left">
          <span class="lamp"></span>
          <h2 class="display title">QUICK ADD</h2>
        </div>
        <span class="hint mono-caps-faint">ESC</span>
      </header>

      <div class="input-row">
        <span class="prompt">▌</span>
        <input
          bind:this={inputEl}
          bind:value={input}
          onkeydown={onKey}
          placeholder='try: "tomorrow 9am gym #fitness" · "in 30 min call back"'
          class="nl-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="preview">
        {#if !input.trim()}
          <div class="preview-empty mono-caps-faint">
            Type a phrase like "next monday 9am team review" — date and time get extracted, the rest becomes the title.
          </div>
        {:else if parsed}
          {@const fmt = formatTarget(parsed.due_at_ms)}
          <div class="preview-title">{parsed.title}</div>
          <div class="preview-when mono">{fmt.dateLine}</div>
          <div class="preview-rel mono-caps-faint">{fmt.relLine}</div>
          {#if parsed.tags.length > 0}
            <div class="preview-tags">
              {#each parsed.tags as t (t)}
                <span class="tag-token">#{t}</span>
              {/each}
            </div>
          {/if}
          {#if parsed.matched_date || parsed.matched_time}
            <div class="preview-tokens mono-caps-faint">
              matched
              {#if parsed.matched_date}<span class="token">{parsed.matched_date}</span>{/if}
              {#if parsed.matched_time}<span class="token">{parsed.matched_time}</span>{/if}
            </div>
          {/if}
        {:else if parseError}
          <div class="preview-error mono-caps">⚠ {parseError}</div>
        {/if}
      </div>

      <footer class="footer mono-caps-faint">
        <span>↵ Enter to add</span>
        <span class="dot">·</span>
        <span>Esc to cancel</span>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 220;
    background: rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 18vh;
    animation: fadeIn 140ms var(--ease);
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .modal {
    width: min(620px, 92vw);
    background: var(--bg-elev);
    border: 1px solid var(--klaxon-dim);
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.72),
      0 0 0 1px var(--klaxon-glow);
    display: flex;
    flex-direction: column;
    animation: rise 180ms var(--ease);
  }
  @keyframes rise {
    from { transform: translateY(-12px); opacity: 0; }
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
    animation: sweepAnim 2.6s linear infinite;
  }
  @keyframes sweepAnim {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 22px 10px;
    border-bottom: 1px solid var(--border);
  }
  .head-left { display: flex; align-items: center; gap: 12px; }
  .lamp {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: var(--klaxon);
    box-shadow: 0 0 12px var(--klaxon-glow-strong);
  }
  .title {
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.1em;
  }
  .hint {
    font-size: 9px;
    letter-spacing: 0.22em;
    padding: 3px 7px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }

  .input-row {
    display: grid;
    grid-template-columns: 22px 1fr;
    align-items: center;
    gap: 8px;
    padding: 14px 22px 14px;
    border-bottom: 1px solid var(--border);
  }
  .prompt {
    color: var(--klaxon);
    font-family: var(--font-mono);
    font-size: 16px;
    line-height: 1;
  }
  .nl-input {
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 18px;
    padding: 4px 0;
    width: 100%;
  }
  .nl-input:focus { outline: none; }
  .nl-input::placeholder { color: var(--text-faint); }

  .preview {
    padding: 18px 22px 20px;
    min-height: 92px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .preview-empty {
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 60ch;
  }
  .preview-title {
    font-size: 18px;
    color: var(--text);
    font-weight: 500;
    margin-bottom: 4px;
  }
  .mono { font-family: var(--font-mono); }
  .preview-when {
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--klaxon);
    font-variant-numeric: tabular-nums;
  }
  .preview-rel {
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }
  .preview-tokens {
    margin-top: 6px;
    font-size: 9px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .token {
    padding: 2px 7px;
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.06);
    color: var(--klaxon);
    text-transform: none;
    letter-spacing: 0.06em;
    font-size: 10px;
  }

  .preview-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  .tag-token {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.08);
    color: var(--klaxon);
  }
  .preview-error {
    color: var(--signal-high);
    border: 1px solid var(--signal-high);
    background: rgba(255, 59, 48, 0.06);
    padding: 8px 12px;
    font-size: 10px;
    letter-spacing: 0.18em;
  }

  .footer {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 22px 14px;
    border-top: 1px solid var(--border);
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }
  .footer .dot { opacity: 0.45; }
</style>
