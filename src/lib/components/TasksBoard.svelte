<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api, type Lane } from "../api";
  import type { Reminder } from "../types";
  import ConfirmModal from "./ConfirmModal.svelte";

  let {
    reminders,
    onSelect,
    onAddCardToLane,
  }: {
    /// Pre-filtered to silent + active in App.svelte.
    reminders: Reminder[];
    onSelect: (r: Reminder) => void;
    onAddCardToLane: (laneId: string) => void;
  } = $props();

  let lanes = $state<Lane[]>([]);
  let unlistenLanes: UnlistenFn | null = null;

  onMount(async () => {
    await loadLanes();
    unlistenLanes = await listen("klaxon://lanes-changed", () => loadLanes());
  });
  onDestroy(() => {
    if (unlistenLanes) unlistenLanes();
  });

  async function loadLanes() {
    try {
      lanes = await api.listLanes();
    } catch (e) {
      console.error("listLanes failed", e);
    }
  }

  // Cards per lane — newest activity first. Drop-into-column updates
  // `updated_at`, so a freshly-moved card pops to the top of its new
  // column without us having to track per-card ordering.
  function cardsForLane(laneId: string): Reminder[] {
    return reminders
      .filter((r) => r.task_lane_id === laneId)
      .sort((a, b) => b.updated_at - a.updated_at);
  }

  function laneCardCount(laneId: string): number {
    return reminders.filter((r) => r.task_lane_id === laneId).length;
  }

  // ── Drag-and-drop ────────────────────────────────────────────────
  // We mark the payload with a custom MIME type so `ondragover` can
  // recognize "this is a Klaxon DnD" and preventDefault the right way
  // (which is what tells the browser the location is a valid drop
  // target and switches the cursor from the red ✕ to a move icon).
  //
  // We deliberately don't gate dragover on Svelte state — relying on
  // `drag` being non-null inside the closure turned out to be flaky in
  // Webview2 (the closure read raced with the dragstart write, leaving
  // dragover thinking no drag was in progress and never calling
  // preventDefault, producing the red ✕ cursor). The dataTransfer
  // types check is what the browser already tracks for us.
  const CARD_MIME = "application/x-klaxon-card";
  const LANE_MIME = "application/x-klaxon-lane";

  // Local visual state — purely for hover styling. The actual drag
  // routing reads from dataTransfer at drop time.
  let hoveredLaneId = $state<string | null>(null);
  let draggingCardId = $state<string | null>(null);
  let draggingLaneId = $state<string | null>(null);

  function startCardDrag(reminderId: string) {
    return (e: DragEvent) => {
      draggingCardId = reminderId;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(CARD_MIME, reminderId);
        // text/plain mirror so e.g. dragging to a text input still does
        // something sensible (the id paste); not required for our drop
        // routing.
        e.dataTransfer.setData("text/plain", reminderId);
      }
    };
  }
  function startLaneDrag(laneId: string) {
    return (e: DragEvent) => {
      draggingLaneId = laneId;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(LANE_MIME, laneId);
        e.dataTransfer.setData("text/plain", `lane:${laneId}`);
      }
    };
  }
  function endDrag() {
    draggingCardId = null;
    draggingLaneId = null;
    hoveredLaneId = null;
  }
  function isKlaxonDrag(e: DragEvent): boolean {
    const types = e.dataTransfer?.types ?? [];
    return types.includes(CARD_MIME) || types.includes(LANE_MIME);
  }
  function onLaneDragOver(laneId: string) {
    return (e: DragEvent) => {
      if (!isKlaxonDrag(e)) return;
      // Critical: preventDefault is what tells the browser "this is a
      // valid drop target". Without it the cursor stays as the red ✕.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      hoveredLaneId = laneId;
    };
  }
  function onLaneDragLeave(laneId: string) {
    return () => {
      if (hoveredLaneId === laneId) hoveredLaneId = null;
    };
  }
  // Outer function stays SYNC. If it's `async`, Svelte binds a Promise
  // as `ondrop` and the browser silently ignores it.
  function onLaneDrop(targetLaneId: string) {
    return async (e: DragEvent) => {
      e.preventDefault();
      const cardId = e.dataTransfer?.getData(CARD_MIME);
      const laneId = e.dataTransfer?.getData(LANE_MIME);
      try {
        if (cardId) {
          await api.setTaskLane(cardId, targetLaneId);
        } else if (laneId && laneId !== targetLaneId) {
          // Reorder: place dragged lane before the drop target lane.
          const ids = lanes.map((l) => l.id);
          const from = ids.indexOf(laneId);
          const to = ids.indexOf(targetLaneId);
          if (from >= 0 && to >= 0) {
            ids.splice(from, 1);
            ids.splice(to, 0, laneId);
            await api.reorderLanes(ids);
          }
        }
      } catch (err) {
        console.error("drop failed", err);
      }
      endDrag();
    };
  }

  // ── Add lane ─────────────────────────────────────────────────────
  let addingLane = $state(false);
  let newLaneName = $state("");
  let addLaneInput: HTMLInputElement | null = $state(null);

  async function startAddLane() {
    addingLane = true;
    await tick();
    addLaneInput?.focus();
  }
  async function commitAddLane() {
    const name = newLaneName.trim();
    if (!name) {
      cancelAddLane();
      return;
    }
    try {
      await api.createLane(name);
    } catch (e) {
      console.error("createLane failed", e);
    }
    newLaneName = "";
    addingLane = false;
  }
  function cancelAddLane() {
    addingLane = false;
    newLaneName = "";
  }

  // ── Rename / delete ──────────────────────────────────────────────
  let renamingLaneId = $state<string | null>(null);
  let renameDraft = $state("");
  let renameInput: HTMLInputElement | null = $state(null);

  async function startRename(lane: Lane) {
    renamingLaneId = lane.id;
    renameDraft = lane.name;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }
  async function commitRename() {
    if (!renamingLaneId) return;
    const newName = renameDraft.trim();
    if (newName) {
      try {
        await api.renameLane(renamingLaneId, newName);
      } catch (e) {
        console.error("renameLane failed", e);
      }
    }
    renamingLaneId = null;
    renameDraft = "";
  }
  function cancelRename() {
    renamingLaneId = null;
    renameDraft = "";
  }
  // Lane-delete confirmation lives in a real modal (not a native confirm)
  // so the destructive flow matches the rest of the Klaxon aesthetic and
  // we can describe the cascade-to-default behavior in detail.
  let confirmingDelete = $state<Lane | null>(null);
  let deletingBusy = $state(false);

  function askDeleteLane(lane: Lane) {
    if (lane.is_default) return;
    confirmingDelete = lane;
  }
  async function performDelete() {
    const lane = confirmingDelete;
    if (!lane || deletingBusy) return;
    deletingBusy = true;
    try {
      await api.deleteLane(lane.id);
      confirmingDelete = null;
    } catch (e) {
      console.error("deleteLane failed", e);
    } finally {
      deletingBusy = false;
    }
  }
  function cancelDelete() {
    if (deletingBusy) return;
    confirmingDelete = null;
  }

  // Short "in 2h", "tomorrow 14:30" style chip for cards with a due time.
  // Tasks frequently have a due_at of 0 (no time set) — skip those.
  function dueChip(ms: number): string | null {
    if (!ms || ms <= 0) return null;
    const d = new Date(ms);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(ms);
    target.setHours(0, 0, 0, 0);
    const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (diffDays === 0) return `today ${hh}:${mm}`;
    if (diffDays === 1) return `tomorrow ${hh}:${mm}`;
    if (diffDays === -1) return `yesterday ${hh}:${mm}`;
    if (diffDays > 1 && diffDays < 7) {
      const wk = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
      return `${wk[d.getDay()]} ${hh}:${mm}`;
    }
    const months = [
      "JAN","FEB","MAR","APR","MAY","JUN",
      "JUL","AUG","SEP","OCT","NOV","DEC",
    ];
    return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, "0")}`;
  }
</script>

<div class="board">
  {#each lanes as lane (lane.id)}
    <div
      class="lane"
      class:hovered={hoveredLaneId === lane.id}
      class:dragging-self={draggingLaneId === lane.id}
      ondragover={onLaneDragOver(lane.id)}
      ondragleave={onLaneDragLeave(lane.id)}
      ondrop={onLaneDrop(lane.id)}
      role="region"
      aria-label={`Lane ${lane.name}`}
    >
      <header
        class="lane-head"
        draggable={renamingLaneId !== lane.id}
        ondragstart={startLaneDrag(lane.id)}
        ondragend={endDrag}
      >
        {#if renamingLaneId === lane.id}
          <input
            bind:this={renameInput}
            bind:value={renameDraft}
            class="lane-name-input mono"
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelRename();
            }}
          />
        {:else}
          <span class="lane-grip mono-caps-faint" aria-hidden="true">⋮⋮</span>
          <!-- Span (not a button) so the parent header's mousedown isn't
               eaten before dragstart can fire. Double-click on the
               header bubbles up here too. -->
          <span
            class="lane-name"
            ondblclick={() => startRename(lane)}
            role="button"
            tabindex="0"
            onkeydown={(e) => {
              if (e.key === "Enter") startRename(lane);
            }}
            title="Double-click to rename. Drag the header to reorder."
          >{lane.name}</span>
          {#if lane.is_default}
            <span
              class="lane-default-badge mono-caps-faint"
              title="Default lane — tasks from deleted lanes land here. Cannot be deleted."
            >default</span>
          {/if}
          <span class="lane-count mono-caps-faint">{laneCardCount(lane.id)}</span>
          {#if !lane.is_default}
            <button
              class="lane-delete"
              onclick={() => askDeleteLane(lane)}
              title="Delete lane"
            >×</button>
          {/if}
        {/if}
      </header>

      <div class="cards">
        {#each cardsForLane(lane.id) as card (card.id)}
          {@const due = dueChip(card.due_at)}
          <!-- div + role=button instead of <button> because draggable
               buttons have spotty behavior in Webview2 — the parent
               button captures mousedown and the drag never starts. -->
          <div
            class="card"
            class:dragging={draggingCardId === card.id}
            role="button"
            tabindex="0"
            draggable="true"
            ondragstart={startCardDrag(card.id)}
            ondragend={endDrag}
            onclick={() => onSelect(card)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(card);
              }
            }}
          >
            <div class="card-title">{card.title}</div>
            {#if card.description}
              <div class="card-desc">{card.description}</div>
            {/if}
            {#if (card.tags && card.tags.length > 0) || due}
              <div class="card-meta">
                {#if due}
                  <span class="card-due mono-caps-faint">{due}</span>
                {/if}
                {#if card.tags}
                  {#each card.tags as tag (tag)}
                    <span class="card-tag">#{tag}</span>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      <button class="lane-add" onclick={() => onAddCardToLane(lane.id)}>
        + Add task
      </button>
    </div>
  {/each}

  <div class="add-lane-column">
    {#if addingLane}
      <input
        bind:this={addLaneInput}
        bind:value={newLaneName}
        class="lane-name-input mono"
        placeholder="Lane name"
        onblur={commitAddLane}
        onkeydown={(e) => {
          if (e.key === "Enter") commitAddLane();
          if (e.key === "Escape") cancelAddLane();
        }}
      />
    {:else}
      <button class="add-lane-btn mono-caps" onclick={startAddLane}>
        + Add lane
      </button>
    {/if}
  </div>
</div>

<ConfirmModal
  open={!!confirmingDelete}
  title="DELETE LANE"
  message={confirmingDelete
    ? (laneCardCount(confirmingDelete.id) > 0
        ? `Delete the "${confirmingDelete.name}" lane?`
        : `Delete the "${confirmingDelete.name}" lane?`)
    : ""}
  detail={confirmingDelete && laneCardCount(confirmingDelete.id) > 0
    ? `${laneCardCount(confirmingDelete.id)} task${laneCardCount(confirmingDelete.id) === 1 ? "" : "s"} will move to the default lane.`
    : "The lane has no tasks — nothing else will change."}
  confirmLabel={deletingBusy ? "Deleting…" : "Delete"}
  danger
  onConfirm={performDelete}
  onCancel={cancelDelete}
/>

<style>
  .board {
    grid-area: main;
    display: flex;
    gap: 12px;
    padding: 16px 18px 24px;
    overflow-x: auto;
    overflow-y: hidden;
    align-items: flex-start;
  }
  .lane {
    flex: 0 0 280px;
    display: flex;
    flex-direction: column;
    max-height: 100%;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    transition: border-color 120ms var(--ease), background 120ms var(--ease);
  }
  .lane.hovered {
    border-color: var(--klaxon);
    background: rgba(255, 157, 0, 0.04);
  }
  .lane.dragging-self {
    opacity: 0.4;
  }

  .lane-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    cursor: grab;
    -webkit-user-select: none;
    user-select: none;
  }
  .lane-head:active {
    cursor: grabbing;
  }
  .lane-grip {
    color: var(--text-faint);
    font-size: 11px;
    letter-spacing: -0.1em;
    padding-right: 2px;
  }
  .lane-name {
    flex: 1;
    text-align: left;
    color: var(--text);
    font-family: var(--font-display);
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0;
    cursor: pointer;
  }
  .lane-name:hover { color: var(--klaxon); }
  .lane-name-input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--klaxon);
    color: var(--text);
    font-size: 13px;
    padding: 4px 8px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .lane-count {
    font-size: 9px;
    letter-spacing: 0.2em;
    padding: 2px 6px;
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
  .lane-default-badge {
    font-size: 8px;
    letter-spacing: 0.2em;
    padding: 2px 6px;
    border: 1px solid var(--border);
    color: var(--text-faint);
    background: transparent;
  }
  .lane-delete {
    background: transparent;
    border: none;
    color: var(--text-faint);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .lane-delete:hover {
    color: var(--signal-high);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    overflow-y: auto;
    min-height: 60px;
  }
  .card {
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: grab;
    font-family: inherit;
    transition: border-color 80ms var(--ease), background 80ms var(--ease);
    /* Without user-select:none Chromium starts a text-selection drag
       (text/plain payload, no drop target accepts it) instead of an
       element drag — the cursor goes red and our ondragstart never
       fires. */
    -webkit-user-select: none;
    user-select: none;
  }
  .card:active { cursor: grabbing; }
  .card:hover {
    border-color: var(--klaxon-dim);
    background: var(--bg-elev);
  }
  .card.dragging {
    opacity: 0.35;
    border-color: var(--klaxon);
  }
  .card-title {
    font-size: 13px;
    line-height: 1.3;
    color: var(--text);
  }
  .card-desc {
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .card-due {
    font-size: 9px;
    letter-spacing: 0.16em;
    color: var(--klaxon);
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.06);
    padding: 2px 6px;
  }
  .card-tag {
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    border: 1px solid var(--border);
    padding: 2px 6px;
  }

  .lane-add {
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    padding: 10px 12px;
    font-size: 10px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
    transition: color 120ms var(--ease), background 120ms var(--ease);
  }
  .lane-add:hover {
    color: var(--klaxon);
    background: rgba(255, 157, 0, 0.04);
  }

  .add-lane-column {
    flex: 0 0 200px;
    display: flex;
    flex-direction: column;
    padding: 6px;
  }
  .add-lane-btn {
    width: 100%;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    padding: 12px;
    font-size: 10px;
    letter-spacing: 0.2em;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .add-lane-btn:hover {
    color: var(--klaxon);
    border-color: var(--klaxon);
    background: rgba(255, 157, 0, 0.04);
  }
</style>
