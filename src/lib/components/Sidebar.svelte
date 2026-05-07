<script lang="ts">
  import type { FilterKey } from "../types";

  let {
    current,
    counts,
    onSelect,
    onNew,
    onOpenSettings,
  }: {
    current: FilterKey;
    counts: Record<FilterKey, number>;
    onSelect: (k: FilterKey) => void;
    onNew: () => void;
    onOpenSettings: () => void;
  } = $props();

  const items: { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "today", label: "Today" },
    { key: "upcoming", label: "Upcoming" },
    { key: "recurring", label: "Recurring" },
    { key: "completed", label: "Completed" },
  ];
</script>

<nav class="sidebar">
  <div class="brand">
    <div class="brand-row">
      <div class="brand-light"></div>
      <h1 class="display brand-name">KLAXON</h1>
    </div>
    <div class="brand-tag mono-caps-faint">Reminders, but louder.</div>
    <div class="brand-rule"></div>
  </div>

  <div class="nav">
    <div class="nav-label mono-caps-faint">Channels</div>
    <ul class="nav-list">
      {#each items as item (item.key)}
        <li>
          <button
            class="nav-btn"
            class:active={current === item.key}
            onclick={() => onSelect(item.key)}
          >
            <span class="nav-bar"></span>
            <span class="nav-label-text">{item.label}</span>
            <span class="nav-count">{counts[item.key]}</span>
          </button>
        </li>
      {/each}
    </ul>
  </div>

  <div class="bottom">
    <button class="new-btn" onclick={onNew}>
      <span class="plus">+</span>
      <span class="new-text">New Reminder</span>
      <span class="new-shortcut">Ctrl+N</span>
    </button>
    <button class="settings-btn" onclick={onOpenSettings}>
      <span class="gear">⚙</span>
      <span class="settings-text">System Config</span>
    </button>
    <div class="version mono-caps-faint">v0.2.0-dev · Industrial</div>
  </div>
</nav>

<style>
  .sidebar {
    grid-area: sidebar;
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 22px 0 14px;
  }

  /* ── Brand ── */
  .brand {
    padding: 0 22px 24px;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 6px;
  }
  .brand-light {
    width: 12px;
    height: 12px;
    background: var(--klaxon);
    border-radius: 50%;
    box-shadow:
      0 0 0 2px var(--bg-elev),
      0 0 0 3px var(--klaxon-dim),
      0 0 16px var(--klaxon-glow-strong);
    animation: flicker 5s var(--ease) infinite;
  }
  .brand-name {
    font-size: 36px;
    font-weight: 900;
    letter-spacing: 0.06em;
    line-height: 1;
    color: var(--text);
  }
  .brand-tag {
    margin-left: 24px;
    color: var(--text-muted);
    letter-spacing: 0.18em;
    font-size: 9px;
  }
  .brand-rule {
    margin-top: 18px;
    height: 1px;
    background: linear-gradient(
      90deg,
      var(--klaxon) 0%,
      var(--klaxon) 24px,
      var(--border) 24px,
      var(--border) 100%
    );
  }

  /* ── Nav ── */
  .nav { padding: 14px 0 0; flex: 1; }
  .nav-label {
    padding: 0 22px 10px;
  }

  .nav-list {
    list-style: none;
  }

  .nav-btn {
    width: 100%;
    display: grid;
    grid-template-columns: 4px 1fr auto;
    align-items: center;
    gap: 14px;
    padding: 11px 22px 11px 18px;
    color: var(--text-muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    transition: all 120ms var(--ease);
    border-left: 1px solid transparent;
  }
  .nav-bar {
    width: 4px;
    height: 14px;
    background: transparent;
    transition: background 120ms var(--ease);
  }
  .nav-btn:hover {
    color: var(--text-2);
    background: var(--bg-hover);
  }
  .nav-btn:hover .nav-bar { background: var(--border-bright); }

  .nav-btn.active {
    color: var(--text);
    background: var(--bg-active);
  }
  .nav-btn.active .nav-bar {
    background: var(--klaxon);
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
  }

  .nav-label-text {
    text-align: left;
  }

  .nav-count {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    padding: 2px 6px;
    border: 1px solid var(--border-strong);
    min-width: 26px;
    text-align: center;
  }
  .nav-btn.active .nav-count {
    color: var(--klaxon);
    border-color: var(--klaxon-dim);
  }

  /* ── Bottom ── */
  .bottom {
    padding: 14px 22px 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .new-btn {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 11px 12px;
    border: 1px solid var(--klaxon-dim);
    background: transparent;
    color: var(--klaxon);
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.22em;
    transition: all 140ms var(--ease);
  }
  .new-btn:hover {
    background: var(--klaxon);
    color: var(--bg);
    box-shadow: 0 0 18px var(--klaxon-glow);
  }
  .plus {
    font-size: 16px;
    font-weight: 400;
    line-height: 1;
  }
  .new-text { text-align: left; }
  .new-shortcut {
    font-family: var(--font-mono);
    font-size: 9px;
    opacity: 0.55;
  }

  .settings-btn {
    display: grid;
    grid-template-columns: 18px 1fr;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border: 1px solid var(--border-strong);
    background: transparent;
    color: var(--text-muted);
    text-transform: uppercase;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.22em;
    transition: all 140ms var(--ease);
  }
  .settings-btn:hover {
    color: var(--text);
    border-color: var(--border-bright);
  }
  .gear {
    font-size: 14px;
    line-height: 1;
    color: var(--text-2);
  }
  .settings-text { text-align: left; }

  .version {
    text-align: center;
    font-size: 9px;
    letter-spacing: 0.22em;
    margin-top: 6px;
  }
</style>
