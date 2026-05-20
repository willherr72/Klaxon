<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import QRCode from "qrcode";
  import {
    api,
    type DeviceInfo,
    type DiscoveredPeer,
    type PairProgress,
    type PeerView,
  } from "../api";

  let {
    collapsed = false,
    onToggle,
  }: {
    collapsed?: boolean;
    onToggle?: () => void;
  } = $props();

  let device = $state<DeviceInfo | null>(null);
  let deviceName = $state("");
  let peers = $state<PeerView[]>([]);
  let discovered = $state<DiscoveredPeer[]>([]);
  let syncEnabled = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let discoveryTimer: number | null = null;

  // Pairing-ticket modal — "Show this device's ticket" + "Paste their ticket".
  let pairOpen = $state(false);
  let pairTicket = $state(""); // pasted ticket input
  let pairBusy = $state(false);
  let pairError = $state<string | null>(null);
  let qrDataUrl = $state<string | null>(null);

  let pingStatus = $state<Record<string, "ok" | "fail" | "pending" | undefined>>({});
  let copyFlash = $state<string | null>(null);

  // Tap-to-pair progress
  type TapPairState =
    | { kind: "starting"; peerName: string }
    | { kind: "awaiting"; code: string; peerName: string }
    | { kind: "success"; peerName: string }
    | { kind: "error"; message: string };
  let tapPair = $state<TapPairState | null>(null);
  let tapPairBusy = $state(false);
  let unlistenProgress: UnlistenFn | null = null;

  onMount(async () => {
    refresh();
    refreshDiscovery();
    discoveryTimer = window.setInterval(refreshDiscovery, 3000);
    unlistenProgress = await listen<PairProgress>(
      "klaxon://pair-progress",
      (event) => {
        if (!tapPair) return;
        tapPair = {
          kind: "awaiting",
          code: event.payload.confirmation_code,
          peerName: event.payload.peer_name,
        };
      },
    );
  });

  onDestroy(() => {
    if (discoveryTimer !== null) clearInterval(discoveryTimer);
    if (unlistenProgress) unlistenProgress();
  });

  async function refresh() {
    try {
      const [dev, ps] = await Promise.all([api.deviceIdentity(), api.listPeers()]);
      device = dev;
      deviceName = dev.device_name;
      syncEnabled = dev.sync_enabled;
      peers = ps;
    } catch (e) {
      console.error(e);
      error = String(e);
    }
  }

  async function refreshDiscovery() {
    try {
      const list = await api.listDiscoveredPeers();
      // Filter out anyone we've already paired with — they don't need to be
      // re-discovered, just show them in the paired list.
      const pairedIds = new Set(peers.map((p) => p.id));
      discovered = list.filter((d) => !pairedIds.has(d.device_id));
    } catch (e) {
      // Discovery may be off; ignore failures.
    }
  }

  async function pairDiscovered(d: DiscoveredPeer) {
    if (tapPairBusy) return;
    if (!d.node_id) {
      tapPair = {
        kind: "error",
        message:
          "Peer hasn't advertised an iroh node id (older build?) — they need to upgrade to v0.3+",
      };
      return;
    }
    tapPairBusy = true;
    tapPair = { kind: "starting", peerName: d.device_name };
    try {
      const outcome = await api.startPairWith(d.node_id, d.device_name);
      tapPair = { kind: "success", peerName: outcome.peer_name };
      await refresh();
      await refreshDiscovery();
      setTimeout(() => {
        if (tapPair?.kind === "success") tapPair = null;
        tapPairBusy = false;
      }, 1600);
    } catch (e) {
      tapPair = { kind: "error", message: String(e) };
      tapPairBusy = false;
    }
  }

  function dismissTapPair() {
    tapPair = null;
    tapPairBusy = false;
  }

  async function toggleSync() {
    if (busy) return;
    busy = true;
    try {
      await api.setSyncEnabled(!syncEnabled);
      syncEnabled = !syncEnabled;
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function saveDeviceName() {
    if (!device) return;
    if (deviceName === device.device_name) return;
    try {
      await api.setSetting("device_name", deviceName.trim() || "Klaxon");
      await refresh();
    } catch (e) {
      console.error(e);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      copyFlash = label;
      setTimeout(() => (copyFlash = null), 1100);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  }

  async function openPair() {
    pairTicket = "";
    pairError = null;
    pairOpen = true;
    qrDataUrl = null;
    if (device?.iroh_node_id) {
      try {
        qrDataUrl = await QRCode.toDataURL(device.iroh_node_id, {
          margin: 1,
          width: 240,
          color: { dark: "#ff9d00", light: "#0a0a0a" },
        });
      } catch (e) {
        console.error("qr generation failed", e);
      }
    }
  }

  async function submitPair() {
    if (pairBusy) return;
    pairError = null;
    const ticket = pairTicket.trim();
    if (!ticket) {
      pairError = "Paste the other device's pairing ticket first.";
      return;
    }
    pairBusy = true;
    // Close the ticket modal immediately so the tap-pair overlay (which
    // shows the SAS code and the eventual success/error) isn't stacked
    // on top of it.
    pairOpen = false;
    tapPair = { kind: "starting", peerName: "(ticket)" };
    try {
      const outcome = await api.startPairWith(ticket, "");
      tapPair = { kind: "success", peerName: outcome.peer_name };
      await refresh();
      setTimeout(() => {
        if (tapPair?.kind === "success") tapPair = null;
      }, 1600);
    } catch (e) {
      tapPair = { kind: "error", message: String(e) };
    } finally {
      pairBusy = false;
    }
  }

  async function removePeer(p: PeerView) {
    if (!confirm(`Remove peer "${p.name}"?`)) return;
    try {
      await api.removePeer(p.id);
      await refresh();
    } catch (e) {
      console.error(e);
    }
  }

  async function pingPeer(p: PeerView) {
    pingStatus = { ...pingStatus, [p.id]: "pending" };
    try {
      await api.pingPeer(p.id);
      pingStatus = { ...pingStatus, [p.id]: "ok" };
    } catch (e) {
      console.error("ping failed", e);
      pingStatus = { ...pingStatus, [p.id]: "fail" };
    }
    setTimeout(() => {
      pingStatus = { ...pingStatus, [p.id]: undefined };
      refresh();
    }, 2200);
  }


  function relativeTime(ms: number | null): string {
    if (!ms || ms === 0) return "—";
    const diff = Date.now() - ms;
    if (diff < 0) return "just now";
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function statusFor(p: PeerView): "ok" | "stale" | "cold" {
    if (!p.last_seen_at) return "cold";
    const diff = Date.now() - p.last_seen_at;
    if (diff < 60_000) return "ok";
    if (diff < 5 * 60_000) return "stale";
    return "cold";
  }
</script>

<section class="section">
  <button
    class="section-head"
    class:open={!collapsed}
    onclick={() => onToggle?.()}
    aria-expanded={!collapsed}
    type="button"
  >
    <span class="chevron" class:open={!collapsed}>▸</span>
    <span class="section-tick"></span>
    <h3 class="mono-caps section-title">Sync</h3>
    <span class="section-line"></span>
    <span class="status-pill" class:on={syncEnabled}>
      {syncEnabled ? "ON" : "OFF"}
    </span>
  </button>
  {#if !collapsed}
  <div class="section-help mono-caps-faint">
    Sync reminders between paired devices over iroh — direct LAN when possible, hole-punched / relayed when peers are on different networks. Restart Klaxon after enabling so the transport spins up.
  </div>

  {#if error}
    <div class="error mono-caps">⚠ {error}</div>
  {/if}

  <label class="toggle-row">
    <input type="checkbox" checked={syncEnabled} onchange={toggleSync} class="toggle-input" />
    <span class="toggle-knob"></span>
    <span class="toggle-text">
      <span class="toggle-title">Enable sync</span>
      <span class="mono-caps-faint">Bring up the iroh endpoint + periodic sync task</span>
    </span>
  </label>

  {#if device}
    <div class="device-panel">
      <div class="panel-head">
        <span class="lamp"></span>
        <span class="mono-caps panel-title">This Device</span>
      </div>
      <div class="kv-grid">
        <span class="kv-label mono-caps-faint">Name</span>
        <input
          type="text"
          class="kv-input"
          bind:value={deviceName}
          onblur={saveDeviceName}
        />

        <span class="kv-label mono-caps-faint">ID</span>
        <div class="kv-row">
          <code class="mono">{device.device_id}</code>
          <button class="copy" onclick={() => device && copy(device.device_id, "ID")}>Copy</button>
        </div>

        <span class="kv-label mono-caps-faint">Iroh node id</span>
        <div class="kv-row">
          <code class="mono">{device.iroh_node_id ?? "(endpoint not started)"}</code>
          {#if device.iroh_node_id}
            <button class="copy" onclick={() => device?.iroh_node_id && copy(device.iroh_node_id, "Node id")}>Copy</button>
            <button class="copy" onclick={openPair}>Pairing ticket</button>
          {/if}
        </div>
      </div>
      {#if copyFlash}
        <div class="copy-flash mono-caps">● {copyFlash} copied</div>
      {/if}
    </div>
  {/if}

  {#if syncEnabled && discovered.length > 0}
    <div class="discovery-head">
      <span class="mono-caps">Discovered on LAN</span>
      <span class="discovery-count mono-caps-faint">{discovered.length}</span>
      <span class="discovery-spacer"></span>
      <span class="discovery-pulse mono-caps-faint">● scanning</span>
    </div>
    <div class="discovery-list">
      {#each discovered as d (d.device_id)}
        <div class="discovered">
          <span class="discovered-led"></span>
          <div class="discovered-body">
            <div class="discovered-name">{d.device_name}</div>
            {#if d.node_id}
              <code class="mono discovered-url">iroh://{d.node_id.slice(0, 16)}…</code>
            {:else}
              <code class="mono discovered-url" title="Peer hasn't advertised an iroh node id — likely on a pre-v0.3 build">no node id</code>
            {/if}
          </div>
          <button class="primary-btn" onclick={() => pairDiscovered(d)}>Pair</button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="peers-head">
    <span class="mono-caps peers-title">Paired Devices</span>
    <span class="peers-count mono-caps-faint">{peers.length}</span>
    <span class="peers-spacer"></span>
    <button class="ghost-btn" onclick={refresh}>Refresh</button>
    <button class="primary-btn" onclick={openPair}>+ Pair Device</button>
  </div>

  {#if peers.length === 0}
    <div class="peers-empty mono-caps-faint">
      No paired devices yet. Use "Pair Device" to add one.
    </div>
  {:else}
    <div class="peers-list">
      {#each peers as p (p.id)}
        {@const status = statusFor(p)}
        <div class="peer">
          <span class="peer-led peer-led-{status}"></span>
          <div class="peer-body">
            <div class="peer-row1">
              <span class="peer-name">{p.name || p.id}</span>
              <span class="peer-seen mono-caps-faint">
                {p.last_seen_at ? `seen ${relativeTime(p.last_seen_at)}` : "never seen"}
              </span>
            </div>
            <div class="peer-row2">
              <code class="mono peer-url">
                {p.iroh_node_id
                  ? `iroh://${p.iroh_node_id.slice(0, 16)}…`
                  : "no iroh node id — re-pair to sync"}
              </code>
            </div>
            <div class="peer-row3 mono-caps-faint">
              pull {relativeTime(p.last_pull_at)} · push {relativeTime(p.last_push_at)}
            </div>
          </div>
          <div class="peer-actions">
            {#if pingStatus[p.id] === "pending"}
              <span class="ping-state mono-caps-faint">…</span>
            {:else if pingStatus[p.id] === "ok"}
              <span class="ping-state ok mono-caps">OK</span>
            {:else if pingStatus[p.id] === "fail"}
              <span class="ping-state fail mono-caps">FAIL</span>
            {:else}
              <button class="ghost-btn" onclick={() => pingPeer(p)}>Ping</button>
            {/if}
            <button class="ghost-btn danger" onclick={() => removePeer(p)}>Remove</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  {/if}
</section>

{#if tapPair}
  <div class="overlay" onclick={(e) => {
      if (e.target !== e.currentTarget) return;
      if (tapPair?.kind === "error" || tapPair?.kind === "success") dismissTapPair();
    }}
    onkeydown={(e) => {
      if (e.key !== "Escape") return;
      if (tapPair?.kind === "error" || tapPair?.kind === "success") dismissTapPair();
    }}
    role="alertdialog" aria-modal="true" tabindex="-1">
    <div class="tap-modal">
      <div class="sweep-bar"><div class="sweep"></div></div>
      <header class="tap-head">
        <span class="lamp"></span>
        <h3 class="display tap-title">
          {#if tapPair.kind === "starting"}CONNECTING{:else if tapPair.kind === "awaiting"}VERIFY CODE{:else if tapPair.kind === "success"}PAIRED{:else}FAILED{/if}
        </h3>
      </header>
      <div class="tap-body">
        {#if tapPair.kind === "starting"}
          <div class="tap-peer mono-caps-faint">Reaching {tapPair.peerName}…</div>
          <div class="spinner"></div>
        {:else if tapPair.kind === "awaiting"}
          <div class="tap-peer mono-caps-faint">{tapPair.peerName}</div>
          <div class="code-frame">
            <div class="code-label mono-caps-faint">Confirmation Code</div>
            <div class="code-value">{tapPair.code}</div>
            <div class="code-hint mono-caps-faint">
              Verify it matches and tap Approve on the other device.
            </div>
          </div>
        {:else if tapPair.kind === "success"}
          <div class="tap-success">
            <div class="ok-mark">✓</div>
            <div class="tap-success-text">Paired with {tapPair.peerName}</div>
          </div>
        {:else}
          <div class="tap-error mono-caps">{tapPair.message}</div>
          <button class="primary-btn" onclick={dismissTapPair}>Close</button>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if pairOpen}
  <div class="pair-overlay" onclick={(e) => { if (e.target === e.currentTarget) pairOpen = false; }}
    role="dialog" aria-modal="true" tabindex="-1"
    onkeydown={(e) => { if (e.key === "Escape") pairOpen = false; }}>
    <div class="pair-modal">
      <div class="sweep-bar"><div class="sweep"></div></div>
      <header class="pair-head">
        <div class="pair-head-left">
          <span class="lamp"></span>
          <h3 class="display pair-title">PAIRING TICKET</h3>
        </div>
        <button class="pair-close" onclick={() => (pairOpen = false)}>×</button>
      </header>

      <div class="pair-help">
        Show this ticket on another device, or paste theirs below. Same handshake as tap-to-pair — the 6-digit code on both screens must match before you Approve.
      </div>

      <div class="ticket-block">
        <div class="ticket-title mono-caps-faint">Your ticket</div>
        {#if device?.iroh_node_id}
          <div class="ticket-row">
            {#if qrDataUrl}
              <img class="ticket-qr" src={qrDataUrl} alt="Pairing QR code" width="240" height="240" />
            {:else}
              <div class="ticket-qr-pending mono-caps-faint">generating QR…</div>
            {/if}
            <div class="ticket-text-col">
              <code class="mono ticket-id">{device.iroh_node_id}</code>
              <button class="ghost-btn" onclick={() => device?.iroh_node_id && copy(device.iroh_node_id, "Ticket")}>
                Copy ticket
              </button>
              <div class="ticket-caption mono-caps-faint">
                52-char base32 iroh node id. Same value as the QR. Mobile scans the QR; desktop pastes the string.
              </div>
            </div>
          </div>
        {:else}
          <div class="ticket-pending mono-caps-faint">Iroh endpoint not ready — sync may be disabled.</div>
        {/if}
      </div>

      <div class="ticket-block">
        <div class="ticket-title mono-caps-faint">Pair from a ticket</div>
        {#if pairError}
          <div class="error mono-caps">⚠ {pairError}</div>
        {/if}
        <div class="pair-from-row">
          <input
            type="text"
            class="pair-input mono-input"
            bind:value={pairTicket}
            placeholder="Paste their pairing ticket"
            autocomplete="off"
            spellcheck="false"
          />
          <button class="primary-btn" onclick={submitPair} disabled={pairBusy}>
            {pairBusy ? "Pairing…" : "Pair"}
          </button>
        </div>
        <div class="ticket-caption mono-caps-faint">
          Both devices must approve the matching 6-digit code on the next screen.
        </div>
      </div>

      <footer class="pair-actions">
        <button class="ghost-btn" onclick={() => (pairOpen = false)}>Close</button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .section-head {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .section-tick {
    width: 8px; height: 1px; background: var(--klaxon);
  }
  .section-title {
    color: var(--text-2); letter-spacing: 0.22em; font-size: 11px;
  }
  .section-line {
    flex: 1; height: 1px; background: var(--border);
  }
  .status-pill {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.22em;
    padding: 2px 8px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
  button.section-head {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 6px 0;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
  }
  button.section-head:hover .section-title { color: var(--text); }
  .chevron {
    display: inline-block;
    width: 12px;
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 160ms var(--ease), color 100ms var(--ease);
    text-align: center;
  }
  .chevron.open {
    transform: rotate(90deg);
    color: var(--klaxon);
  }
  button.section-head:hover .chevron { color: var(--text); }
  .status-pill.on {
    color: var(--ok);
    border-color: var(--ok);
    background: rgba(34, 197, 94, 0.06);
  }
  .section-help {
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.14em;
    margin-bottom: 4px;
  }
  .error {
    color: var(--signal-high);
    border: 1px solid var(--signal-high);
    padding: 8px 12px;
    background: rgba(255, 59, 48, 0.06);
    font-size: 11px;
    letter-spacing: 0.18em;
  }

  /* Toggle reuses styling from SettingsModal */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
    cursor: pointer;
  }
  .toggle-input {
    appearance: none; width: 0; height: 0; margin: 0; padding: 0; border: none; pointer-events: none;
  }
  .toggle-knob {
    flex-shrink: 0; position: relative; width: 44px; height: 22px;
    background: var(--bg-surface); border: 1px solid var(--border-strong);
    transition: all 140ms var(--ease);
  }
  .toggle-knob::before {
    content: ""; position: absolute; top: 3px; left: 3px;
    width: 14px; height: 14px;
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
    display: flex; flex-direction: column; gap: 3px;
  }
  .toggle-title {
    font-size: 12px; color: var(--text); font-weight: 500;
  }

  /* Device panel */
  .device-panel {
    border: 1px solid var(--border);
    background: var(--bg-surface);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .panel-head {
    display: flex; align-items: center; gap: 10px;
  }
  .lamp {
    width: 8px; height: 8px;
    background: var(--klaxon);
    border-radius: 50%;
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
  }
  .panel-title {
    color: var(--text-2);
    letter-spacing: 0.22em;
    font-size: 10px;
  }
  .kv-grid {
    display: grid;
    grid-template-columns: 130px minmax(0, 1fr);
    gap: 8px 14px;
    align-items: center;
  }
  .kv-label {
    font-size: 9px;
    letter-spacing: 0.22em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kv-input {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    transition: border-color 120ms var(--ease);
  }
  .kv-input:focus { border-color: var(--klaxon); outline: none; }
  .kv-row {
    display: flex; align-items: center; gap: 10px;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-2);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    padding: 5px 10px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .copy {
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    background: transparent;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .copy:hover { color: var(--klaxon); border-color: var(--klaxon); }
  .copy-flash {
    color: var(--ok);
    font-size: 10px;
    letter-spacing: 0.22em;
  }

  /* Peers */
  .peers-head {
    display: flex; align-items: center; gap: 10px;
    padding-top: 6px;
  }
  .peers-title {
    color: var(--text-2); letter-spacing: 0.22em; font-size: 11px;
  }
  .peers-count {
    font-family: var(--font-mono);
    border: 1px solid var(--border-strong);
    padding: 2px 8px; font-size: 10px;
    color: var(--text-muted);
  }
  .peers-spacer { flex: 1; }
  .ghost-btn, .primary-btn {
    padding: 6px 12px;
    font-family: var(--font-mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-2);
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .ghost-btn:hover { color: var(--text); border-color: var(--border-bright); }
  .ghost-btn.danger:hover { color: var(--signal-high); border-color: var(--signal-high); }
  .primary-btn {
    background: var(--klaxon); color: var(--bg); border-color: var(--klaxon);
    font-weight: 700;
  }
  .primary-btn:hover {
    background: transparent; color: var(--klaxon);
    box-shadow: 0 0 14px var(--klaxon-glow);
  }
  .primary-btn:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }

  .peers-empty {
    padding: 22px;
    text-align: center;
    border: 1px dashed var(--border);
    color: var(--text-muted);
    font-size: 10px;
    letter-spacing: 0.18em;
  }
  .peers-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .peer {
    display: grid;
    grid-template-columns: 12px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border: 1px solid var(--border);
    background: var(--bg-surface);
  }
  .peer-led {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--text-faint);
    align-self: center;
  }
  .peer-led-ok {
    background: var(--ok);
    box-shadow: 0 0 8px var(--ok-glow);
  }
  .peer-led-stale {
    background: var(--warn);
    box-shadow: 0 0 6px rgba(245, 158, 11, 0.4);
  }
  .peer-led-cold {
    background: var(--text-faint);
  }
  .peer-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .peer-row1 {
    display: flex; align-items: baseline; gap: 12px;
  }
  .peer-name {
    color: var(--text);
    font-size: 12px;
    font-weight: 500;
  }
  .peer-seen {
    font-size: 9px;
    letter-spacing: 0.18em;
  }
  .peer-url {
    flex: 1;
    background: transparent;
    border: none;
    padding: 0;
    font-size: 10px;
    color: var(--text-muted);
  }
  .peer-row3 {
    font-size: 9px;
    letter-spacing: 0.16em;
  }
  .peer-actions {
    display: flex; gap: 6px;
  }
  .ping-state {
    font-size: 10px;
    letter-spacing: 0.22em;
    padding: 6px 10px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
  .ping-state.ok { color: var(--ok); border-color: var(--ok); }
  .ping-state.fail { color: var(--signal-high); border-color: var(--signal-high); }

  /* Discovered peers */
  .discovery-head {
    display: flex; align-items: center; gap: 10px;
    padding-top: 6px;
  }
  .discovery-count {
    font-family: var(--font-mono);
    border: 1px solid var(--klaxon-dim);
    color: var(--klaxon);
    padding: 2px 8px; font-size: 10px;
  }
  .discovery-spacer { flex: 1; }
  .discovery-pulse {
    color: var(--klaxon);
    font-size: 9px;
    letter-spacing: 0.22em;
    animation: pulse 1.6s var(--ease) infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  .discovery-list {
    display: flex; flex-direction: column; gap: 8px;
    margin-top: 4px;
  }
  .discovered {
    display: grid;
    grid-template-columns: 12px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 10px 14px;
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.04);
  }
  .discovered-led {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--klaxon);
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
    align-self: center;
  }
  .discovered-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .discovered-name {
    font-size: 12px;
    font-weight: 500;
    color: var(--text);
  }
  .discovered-url {
    background: transparent;
    border: none;
    padding: 0;
    font-size: 10px;
    color: var(--text-muted);
  }

  /* Tap-to-pair progress modal */
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 250;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fadeIn 160ms var(--ease);
  }
  .tap-modal {
    width: min(440px, 90vw);
    background: var(--bg-elev);
    border: 1px solid var(--klaxon-dim);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.7),
      0 0 0 1px var(--klaxon-glow);
    display: flex; flex-direction: column;
    animation: rise 200ms var(--ease);
  }
  .tap-head {
    display: flex; align-items: center; gap: 14px;
    padding: 18px 22px 14px;
    border-bottom: 1px solid var(--border);
  }
  .tap-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.1em;
  }
  .tap-body {
    padding: 24px 22px 26px;
    display: flex; flex-direction: column;
    align-items: center;
    gap: 14px;
  }
  .tap-peer {
    font-size: 10px;
    letter-spacing: 0.22em;
    color: var(--text-2);
  }
  .spinner {
    width: 28px; height: 28px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--klaxon);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .code-frame {
    border: 1px solid var(--border-strong);
    background: var(--bg);
    padding: 22px 18px 14px;
    display: flex; flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
  }
  .code-label {
    font-size: 9px;
    letter-spacing: 0.32em;
  }
  .code-value {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 52px;
    font-weight: 600;
    letter-spacing: 0.12em;
    color: var(--klaxon);
    text-shadow: 0 0 24px var(--klaxon-glow-strong);
    line-height: 1;
  }
  .code-hint {
    font-size: 9px;
    letter-spacing: 0.18em;
    text-align: center;
    color: var(--text-muted);
    max-width: 32ch;
  }
  .tap-success {
    display: flex; flex-direction: column;
    align-items: center; gap: 14px;
    padding: 20px 0;
  }
  .ok-mark {
    width: 56px; height: 56px;
    border-radius: 50%;
    border: 2px solid var(--ok);
    color: var(--ok);
    display: flex; align-items: center; justify-content: center;
    font-size: 28px;
    box-shadow: 0 0 18px var(--ok-glow);
  }
  .tap-success-text {
    font-size: 13px;
    color: var(--text);
  }
  .tap-error {
    color: var(--signal-high);
    font-size: 11px;
    letter-spacing: 0.14em;
    text-align: center;
    border: 1px solid var(--signal-high);
    background: rgba(255, 59, 48, 0.06);
    padding: 12px 16px;
    width: 100%;
    box-sizing: border-box;
  }

  /* Pair modal */
  .pair-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    animation: fadeIn 160ms var(--ease);
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  .ticket-block {
    padding: 14px 22px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ticket-block:last-of-type { border-bottom: none; }
  .ticket-title {
    font-size: 9px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }
  .ticket-row {
    display: flex;
    gap: 18px;
    align-items: flex-start;
  }
  .ticket-qr {
    width: 240px;
    height: 240px;
    background: var(--bg);
    padding: 6px;
    border: 1px solid var(--border-strong);
    image-rendering: pixelated;
    flex-shrink: 0;
  }
  .ticket-qr-pending {
    width: 240px;
    height: 240px;
    border: 1px dashed var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .ticket-text-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
    min-width: 0;
  }
  .ticket-id {
    font-size: 11px;
    word-break: break-all;
    line-height: 1.5;
    color: var(--klaxon);
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.06);
    padding: 8px 10px;
    width: 100%;
    box-sizing: border-box;
  }
  .ticket-caption {
    font-size: 9px;
    letter-spacing: 0.16em;
    color: var(--text-muted);
    line-height: 1.6;
  }
  .ticket-pending {
    font-size: 10px;
    letter-spacing: 0.22em;
    color: var(--text-muted);
  }
  .pair-from-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }

  .pair-modal {
    width: min(560px, 92vw);
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.75);
    display: flex;
    flex-direction: column;
    animation: rise 200ms var(--ease);
  }
  @keyframes rise {
    from { transform: translateY(12px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  .sweep-bar {
    height: 3px; overflow: hidden; position: relative; background: var(--bg);
  }
  .sweep {
    position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent 0%, var(--klaxon) 50%, transparent 100%);
    animation: sweepAnim 3s linear infinite;
  }
  @keyframes sweepAnim {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
  }
  .pair-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 18px 22px 14px;
    border-bottom: 1px solid var(--border);
  }
  .pair-head-left { display: flex; align-items: center; gap: 14px; }
  .pair-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .pair-close {
    width: 32px; height: 32px;
    color: var(--text-muted);
    background: transparent; border: none;
    font-size: 22px; line-height: 1;
    cursor: pointer;
  }
  .pair-close:hover { color: var(--text); }
  .pair-help {
    padding: 14px 22px;
    font-size: 11px;
    color: var(--text-2);
    line-height: 1.55;
    background: var(--bg);
  }
  .pair-fields {
    padding: 14px 22px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .pair-field {
    display: flex; flex-direction: column; gap: 4px;
  }
  .pair-input {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    transition: border-color 120ms var(--ease);
  }
  .pair-input:focus { border-color: var(--klaxon); outline: none; }
  .mono-input { font-variant-numeric: tabular-nums; }
  .secret-row {
    display: flex; gap: 8px;
  }
  .secret-row .pair-input { flex: 1; }
  .pair-actions {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 8px;
    padding: 14px 22px 18px;
    border-top: 1px solid var(--border);
  }
</style>
