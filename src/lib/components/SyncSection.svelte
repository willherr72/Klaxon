<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

  // Pair modal state
  let pairOpen = $state(false);
  let pairId = $state("");
  let pairName = $state("");
  let pairUrl = $state("");
  let pairSecret = $state("");
  let pairBusy = $state(false);
  let pairError = $state<string | null>(null);

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
    if (!d.cert_fingerprint) {
      tapPair = {
        kind: "error",
        message: "Peer is not advertising a TLS fingerprint — try restarting it.",
      };
      return;
    }
    tapPairBusy = true;
    tapPair = { kind: "starting", peerName: d.device_name };
    try {
      const outcome = await api.startPairWith(
        d.url,
        d.device_id,
        d.device_name,
        d.cert_fingerprint,
      );
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

  function openPair() {
    pairId = "";
    pairName = "";
    pairUrl = "";
    pairSecret = "";
    pairError = null;
    pairOpen = true;
  }

  async function generateSecret() {
    try {
      pairSecret = await api.generateSecret();
    } catch (e) {
      pairError = String(e);
    }
  }

  async function submitPair() {
    if (pairBusy) return;
    pairError = null;
    if (!pairId.trim() || !pairUrl.trim() || !pairSecret.trim()) {
      pairError = "ID, URL, and Secret are required.";
      return;
    }
    pairBusy = true;
    try {
      await api.addPeer({
        id: pairId.trim(),
        name: pairName.trim() || pairId.trim(),
        url: pairUrl.trim(),
        shared_secret: pairSecret.trim(),
      });
      pairOpen = false;
      await refresh();
    } catch (e) {
      pairError = String(e);
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
    <h3 class="mono-caps section-title">LAN Sync</h3>
    <span class="section-line"></span>
    <span class="status-pill" class:on={syncEnabled}>
      {syncEnabled ? "ON" : "OFF"}
    </span>
  </button>
  {#if !collapsed}
  <div class="section-help mono-caps-faint">
    Sync reminders between paired devices on your local network. Restart Klaxon after enabling so the sync server starts up.
  </div>

  {#if error}
    <div class="error mono-caps">⚠ {error}</div>
  {/if}

  <label class="toggle-row">
    <input type="checkbox" checked={syncEnabled} onchange={toggleSync} class="toggle-input" />
    <span class="toggle-knob"></span>
    <span class="toggle-text">
      <span class="toggle-title">Enable LAN sync</span>
      <span class="mono-caps-faint">Run an embedded HTTP server + periodic sync task</span>
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

        <span class="kv-label mono-caps-faint">URL</span>
        <div class="kv-row">
          <code class="mono">{device.sync_url_hint}</code>
          <button class="copy" onclick={() => device && copy(device.sync_url_hint, "URL")}>Copy</button>
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
            <code class="mono discovered-url">{d.url}</code>
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
              <code class="mono peer-url">{p.url}</code>
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
          <h3 class="display pair-title">PAIR DEVICE</h3>
        </div>
        <button class="pair-close" onclick={() => (pairOpen = false)}>×</button>
      </header>

      <div class="pair-help">
        Both devices need each other's <strong>ID</strong>, <strong>URL</strong>, and the <strong>same shared secret</strong>. Generate the secret on one device, copy it, then add the other device on both ends.
      </div>

      {#if pairError}
        <div class="error mono-caps">⚠ {pairError}</div>
      {/if}

      <div class="pair-fields">
        <label class="pair-field">
          <span class="mono-caps-faint">Their Device ID</span>
          <input type="text" class="pair-input" bind:value={pairId} placeholder="UUID from the other device" />
        </label>
        <label class="pair-field">
          <span class="mono-caps-faint">Their Name (optional)</span>
          <input type="text" class="pair-input" bind:value={pairName} placeholder="e.g., Phone" />
        </label>
        <label class="pair-field">
          <span class="mono-caps-faint">Their URL</span>
          <input type="text" class="pair-input" bind:value={pairUrl} placeholder="http://192.168.x.x:7124" />
        </label>
        <label class="pair-field">
          <span class="mono-caps-faint">Shared Secret</span>
          <div class="secret-row">
            <input type="text" class="pair-input mono-input" bind:value={pairSecret} placeholder="Hex token (same on both devices)" />
            <button class="ghost-btn" onclick={generateSecret}>Generate</button>
          </div>
        </label>
      </div>

      <footer class="pair-actions">
        <button class="ghost-btn" onclick={() => (pairOpen = false)}>Cancel</button>
        <button class="primary-btn" onclick={submitPair} disabled={pairBusy}>
          {pairBusy ? "Adding…" : "Add Peer"}
        </button>
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
    grid-template-columns: 80px 1fr;
    gap: 8px 14px;
    align-items: center;
  }
  .kv-label {
    font-size: 9px;
    letter-spacing: 0.22em;
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
