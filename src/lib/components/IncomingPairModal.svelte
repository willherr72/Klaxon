<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api, type PendingPairEvent } from "../api";

  let pending = $state<PendingPairEvent | null>(null);
  let busy = $state(false);
  let elapsed = $state(0);
  let unlisten: UnlistenFn | null = null;
  let tickHandle: number | null = null;
  let openedAt = 0;

  onMount(async () => {
    unlisten = await listen<PendingPairEvent>(
      "klaxon://pair-request",
      (event) => {
        pending = event.payload;
        busy = false;
        openedAt = Date.now();
        elapsed = 0;
      },
    );
    tickHandle = window.setInterval(() => {
      if (pending) elapsed = Math.floor((Date.now() - openedAt) / 1000);
    }, 500);
  });

  onDestroy(() => {
    if (unlisten) unlisten();
    if (tickHandle !== null) clearInterval(tickHandle);
  });

  async function approve() {
    if (!pending || busy) return;
    busy = true;
    try {
      await api.approvePairRequest(pending.request_id);
    } catch (e) {
      console.error("approve failed", e);
    }
    pending = null;
  }

  async function decline() {
    if (!pending || busy) return;
    busy = true;
    try {
      await api.declinePairRequest(pending.request_id);
    } catch (e) {
      console.error("decline failed", e);
    }
    pending = null;
  }
</script>

<svelte:window onkeydown={(e) => {
  if (!pending) return;
  if (e.key === "Escape") decline();
  if (e.key === "Enter") approve();
}} />

{#if pending}
  <div class="overlay" role="alertdialog" aria-modal="true" aria-labelledby="pair-title">
    <div class="modal">
      <div class="hazard-strip"></div>
      <header class="head">
        <div class="head-left">
          <span class="lamp"></span>
          <h2 id="pair-title" class="display title">PAIRING REQUEST</h2>
        </div>
        <div class="elapsed mono-caps-faint">{elapsed}s</div>
      </header>

      <div class="body">
        <div class="from">
          <span class="mono-caps-faint">From</span>
          <span class="from-name display">{pending.initiator_name}</span>
        </div>
        <div class="from-id mono-caps-faint">
          {pending.initiator_url}
        </div>

        <div class="code-frame">
          <div class="code-label mono-caps-faint">Confirmation Code</div>
          <div class="code-value">{pending.confirmation_code}</div>
          <div class="code-hint mono-caps-faint">
            Verify the code matches on the other device.
          </div>
        </div>
      </div>

      <footer class="actions">
        <button class="btn decline" onclick={decline} disabled={busy}>
          Decline
        </button>
        <button class="btn approve" onclick={approve} disabled={busy}>
          {busy ? "Pairing…" : "Approve"}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 300;
    background: rgba(0, 0, 0, 0.78);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 180ms var(--ease);
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .modal {
    width: min(520px, 92vw);
    background: var(--bg-elev);
    border: 1px solid var(--klaxon-dim);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.85),
      0 0 0 1px var(--klaxon-glow);
    display: flex;
    flex-direction: column;
    position: relative;
    animation: rise 220ms var(--ease);
  }
  @keyframes rise {
    from { transform: translateY(16px) scale(0.98); opacity: 0; }
    to   { transform: translateY(0) scale(1); opacity: 1; }
  }
  .hazard-strip {
    height: 6px;
    background: repeating-linear-gradient(
      -45deg,
      var(--hazard-yellow) 0 10px,
      var(--hazard-black) 10px 20px
    );
  }

  .head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 24px 14px;
    border-bottom: 1px solid var(--border);
  }
  .head-left { display: flex; align-items: center; gap: 14px; }
  .lamp {
    width: 12px; height: 12px;
    background: var(--klaxon);
    border-radius: 50%;
    box-shadow: 0 0 14px var(--klaxon-glow-strong);
    animation: lampPulse 1.4s var(--ease) infinite;
  }
  @keyframes lampPulse {
    0%, 100% { box-shadow: 0 0 10px var(--klaxon-glow-strong); }
    50%      { box-shadow: 0 0 22px var(--klaxon); }
  }
  .title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.1em;
  }
  .elapsed {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
  }

  .body {
    padding: 22px 24px;
    display: flex; flex-direction: column; gap: 16px;
    align-items: stretch;
  }
  .from { display: flex; align-items: baseline; gap: 12px; }
  .from-name {
    font-size: 22px;
    font-weight: 700;
    color: var(--text);
  }
  .from-id {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .code-frame {
    border: 1px solid var(--border-strong);
    background: var(--bg);
    padding: 22px 18px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .code-label {
    font-size: 9px;
    letter-spacing: 0.32em;
    color: var(--text-muted);
  }
  .code-value {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 56px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--klaxon);
    text-shadow: 0 0 24px var(--klaxon-glow-strong);
    line-height: 1;
  }
  .code-hint {
    font-size: 9px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    text-align: center;
    margin-top: 2px;
  }

  .actions {
    display: flex;
    gap: 10px;
    padding: 16px 24px 22px;
    border-top: 1px solid var(--border);
  }
  .btn {
    flex: 1;
    padding: 12px 16px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .btn:disabled { opacity: 0.45; cursor: wait; }
  .btn.decline:hover:not(:disabled) {
    color: var(--signal-high);
    border-color: var(--signal-high);
  }
  .btn.approve {
    background: var(--klaxon);
    color: var(--bg);
    border-color: var(--klaxon);
  }
  .btn.approve:hover:not(:disabled) {
    background: transparent;
    color: var(--klaxon);
    box-shadow: 0 0 22px var(--klaxon-glow);
  }
</style>
