<script lang="ts">
  // Generic Klaxon-styled confirmation dialog. Stays decoupled from any
  // particular action — parents own the state and the side-effect.
  // Render this once near the relevant component; toggle `open` to show.
  let {
    open,
    title,
    message,
    detail = null,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
  }: {
    open: boolean;
    title: string;
    message: string;
    detail?: string | null;
    confirmLabel?: string;
    cancelLabel?: string;
    /// When true the confirm button paints in the high-signal red so the
    /// destructive action reads as such.
    danger?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  let confirmBtn: HTMLButtonElement | null = $state(null);

  $effect(() => {
    if (open) {
      const t = setTimeout(() => confirmBtn?.focus(), 60);
      return () => clearTimeout(t);
    }
  });

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      e.preventDefault();
      onConfirm();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="overlay"
    onclick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
  >
    <div class="modal" class:danger>
      <div class="sweep-bar"><div class="sweep"></div></div>

      <header class="head">
        <div class="head-left">
          <span class="lamp" class:danger></span>
          <h2 id="confirm-title" class="display title">{title}</h2>
        </div>
        <span class="hint mono-caps-faint">ESC</span>
      </header>

      <div class="body">
        <p class="message">{message}</p>
        {#if detail}
          <p class="detail mono-caps-faint">{detail}</p>
        {/if}
      </div>

      <footer class="actions">
        <button class="btn cancel" onclick={onCancel}>{cancelLabel}</button>
        <button
          bind:this={confirmBtn}
          class="btn confirm"
          class:danger
          onclick={onConfirm}
        >
          {confirmLabel}
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 250;
    background: rgba(0, 0, 0, 0.66);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 140ms var(--ease);
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .modal {
    width: min(460px, 92vw);
    background: var(--bg-elev);
    border: 1px solid var(--klaxon-dim);
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.72),
      0 0 0 1px var(--klaxon-glow);
    display: flex;
    flex-direction: column;
    animation: rise 180ms var(--ease);
  }
  .modal.danger {
    border-color: var(--signal-high);
    box-shadow:
      0 24px 60px rgba(0, 0, 0, 0.72),
      0 0 0 1px rgba(255, 59, 48, 0.32);
  }
  @keyframes rise {
    from { transform: translateY(-10px); opacity: 0; }
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
  .modal.danger .sweep {
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--signal-high) 50%,
      transparent 100%
    );
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
  .lamp.danger {
    background: var(--signal-high);
    box-shadow: 0 0 12px rgba(255, 59, 48, 0.6);
  }
  .title {
    font-size: 18px;
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

  .body {
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .message {
    font-size: 13px;
    line-height: 1.5;
    color: var(--text);
    margin: 0;
  }
  .detail {
    font-size: 10px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    line-height: 1.6;
    margin: 0;
  }

  .actions {
    display: flex;
    gap: 8px;
    padding: 12px 22px 16px;
    border-top: 1px solid var(--border);
    justify-content: flex-end;
  }
  .btn {
    padding: 8px 18px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .btn.cancel:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }
  .btn.confirm {
    background: var(--klaxon);
    color: var(--bg);
    border-color: var(--klaxon);
  }
  .btn.confirm:hover {
    background: transparent;
    color: var(--klaxon);
    box-shadow: 0 0 22px var(--klaxon-glow);
  }
  .btn.confirm.danger {
    background: var(--signal-high);
    border-color: var(--signal-high);
    color: var(--bg);
  }
  .btn.confirm.danger:hover {
    background: transparent;
    color: var(--signal-high);
    box-shadow: 0 0 22px rgba(255, 59, 48, 0.4);
  }
</style>
