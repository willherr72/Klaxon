<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api } from "../api";
  import { dayBounds, localDayKey } from "../day";
  import { effectiveDueAt } from "../time";
  import type { Reminder, Thought } from "../types";
  import SignalLight from "./SignalLight.svelte";

  let {
    open,
    date,
    reminders,
    onClose,
    onSelect,
    onCreateForDate,
  }: {
    open: boolean;
    date: Date | null;
    reminders: Reminder[];
    onClose: () => void;
    onSelect: (r: Reminder) => void;
    onCreateForDate: (ms: number, silent: boolean) => void;
  } = $props();

  const AUTOSAVE_MS = 1000;

  let note = $state("");
  let thoughts = $state<Thought[]>([]);
  // The day the current `note` belongs to. Plain `let`, not $state: it is
  // written from the effect that reads it, and a reactive write would
  // re-trigger that effect.
  let loadedDay: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Set while a save is pending, so flushing knows what to write even
  // after `note` has been replaced by another day's body.
  let pending: { day: string; body: string } | null = null;
  // Which day the user has typed into. A fetch that resolves after the user
  // has edited is stale by definition — `pending` is not enough on its own,
  // because the debounce clears it the moment the save is dispatched.
  let editedDay: string | null = null;
  // Saves must land in the order they were issued. Two overlapping
  // setDayNote calls can otherwise resolve out of order and persist the
  // older body, which is precisely the loss the debounce exists to prevent.
  let saveChain: Promise<unknown> = Promise.resolve();

  function flushNote() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const p = pending;
    pending = null;
    if (!p) return;
    saveChain = saveChain.then(() =>
      api.setDayNote(p.day, p.body).catch((e) => console.error("setDayNote failed", e)),
    );
  }

  function scheduleSave(day: string, body: string) {
    pending = { day, body };
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNote, AUTOSAVE_MS);
  }

  function onNoteInput(e: Event) {
    const body = (e.currentTarget as HTMLTextAreaElement).value;
    note = body;
    if (loadedDay) {
      editedDay = loadedDay;
      scheduleSave(loadedDay, body);
    }
  }

  function close() {
    // Flush BEFORE handing control back: an unflushed debounce silently
    // discards the note it exists to protect.
    flushNote();
    onClose();
  }

  $effect(() => {
    if (!open || !date) return;
    const key = localDayKey(date);
    if (loadedDay === key) return;
    // Switching days must not carry the previous day's unsaved text over.
    flushNote();
    loadedDay = key;
    // Clear synchronously, before the fetches below even start: otherwise
    // the previous day's note and thoughts stay on screen — visibly wrong
    // for every switch, not just a narrow race — until the new day's fetch
    // resolves.
    note = "";
    thoughts = [];
    editedDay = null;
    const { startMs, endMs } = dayBounds(date);
    api
      .getDayNote(key)
      .then((n) => {
        // Skip the assignment if the day has moved on again, or if the user
        // has typed anything for this exact day since it loaded. `pending`
        // alone can't tell us that: the debounce clears it to null the
        // moment the save is dispatched, well before a slow fetch (cold
        // start, busy device) resolves — so a fetch landing after the
        // debounce fired would still overwrite the user's text with a
        // stale body if we only checked `pending`. `editedDay` stays set
        // for the whole day once the user has typed, which is the
        // guarantee we actually need here.
        if (loadedDay === key && editedDay !== key) note = n?.body ?? "";
      })
      .catch((e) => console.error("getDayNote failed", e));
    api
      .thoughtsBetween(startMs, endMs)
      .then((t) => {
        if (loadedDay === key) thoughts = t;
      })
      .catch((e) => console.error("thoughtsBetween failed", e));
  });

  onDestroy(flushNote);

  let unlistenNotes: UnlistenFn | null = null;
  // Set the instant onDestroy runs. `listen` is awaited, so if the
  // component is torn down before it resolves, `unlistenNotes` is still
  // null when onDestroy fires and would no-op — leaking the listener onto
  // a component that no longer exists. This flag lets the onMount
  // continuation notice and unlisten immediately instead.
  let destroyed = false;
  onMount(async () => {
    // A note edited on the other device should appear here without
    // reopening the day. `pending` alone does not prove it's safe to
    // overwrite `note`: it goes back to null the instant the debounce
    // dispatches a save, well before this fetch (or the save's own round
    // trip) resolves, so a stale read can still land after that point.
    const un = await listen("klaxon://day-notes-changed", async () => {
      if (pending !== null || !loadedDay) return;
      const day = loadedDay;
      // Snapshot what's on screen before the await. The only safe check
      // on the other side is "nothing changed while we were waiting" —
      // comparing to this snapshot catches any keystroke that landed
      // during the fetch, including ones typed after the debounce above
      // already cleared `pending`. We deliberately do NOT gate on
      // `editedDay`: it stays set for the whole day once the user has
      // typed anything, which would permanently disable this refresh for
      // that day and defeat the point of syncing notes in live.
      const before = note;
      try {
        const n = await api.getDayNote(day);
        if (loadedDay === day && note === before) note = n?.body ?? "";
      } catch (e) {
        console.error("getDayNote refresh failed", e);
      }
    });
    if (destroyed) {
      un();
    } else {
      unlistenNotes = un;
    }
  });

  onDestroy(() => {
    destroyed = true;
    if (unlistenNotes) unlistenNotes();
  });

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  let heading = $derived(
    date ? `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}` : "",
  );

  // Everything due that local day, finished or not — the grid hides state,
  // but "what happened" includes what already fired.
  let items = $derived.by(() => {
    if (!date) return [];
    const { startMs, endMs } = dayBounds(date);
    return reminders
      .filter((r) => {
        const t = effectiveDueAt(r);
        return t >= startMs && t < endMs;
      })
      .sort((a, b) => effectiveDueAt(a) - effectiveDueAt(b));
  });

  function isFinished(r: Reminder): boolean {
    return r.state === "completed" || r.state === "dismissed" || r.state === "fired";
  }

  function timeOf(r: Reminder): string {
    const d = new Date(effectiveDueAt(r));
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function addOnThisDay(silent: boolean) {
    if (!date) return;
    const now = new Date();
    const target = new Date(date);
    target.setHours(now.getHours(), now.getMinutes(), 0, 0);
    onCreateForDate(target.getTime(), silent);
  }
</script>

<aside class="panel" class:open aria-hidden={!open}>
  <header class="panel-head">
    <h2 class="display">{heading}</h2>
    <button class="close" aria-label="Close day" onclick={close}>×</button>
  </header>

  <div class="panel-body">
    <label class="field">
      <span class="mono-caps-faint">Note</span>
      <textarea
        class="note-input"
        rows="4"
        placeholder="What happened?"
        value={note}
        oninput={onNoteInput}
      ></textarea>
    </label>

    <div class="field">
      <span class="mono-caps-faint">Reminders &amp; tasks</span>
      {#if items.length === 0}
        <p class="empty mono-caps-faint">Nothing on this day</p>
      {:else}
        <ul class="items">
          {#each items as r (r.id)}
            <li>
              <button
                class="item"
                class:finished={isFinished(r)}
                onclick={() => onSelect(r)}
              >
                {#if !r.silent}
                  <SignalLight priority={r.priority} size={9} />
                {/if}
                <span class="item-time mono-caps-faint">{timeOf(r)}</span>
                <span class="item-title">{r.title}</span>
                {#if isFinished(r)}
                  <span class="item-state mono-caps-faint">{r.state}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if thoughts.length > 0}
      <div class="field">
        <span class="mono-caps-faint">Thoughts</span>
        <ul class="thoughts">
          {#each thoughts as t (t.id)}
            <li class="thought">{t.body}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="add-row">
      <button class="add-btn mono-caps" onclick={() => addOnThisDay(false)}>
        + Reminder
      </button>
      <button class="add-btn mono-caps" onclick={() => addOnThisDay(true)}>
        + Task
      </button>
    </div>
  </div>
</aside>

<style>
  /* Mirrors ReminderEditor: a right-hand panel on desktop, full-screen on
     mobile, so the calendar keeps its context on a wide screen. */
  .panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--editor-w);
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    transform: translateX(100%);
    transition: transform 240ms var(--ease);
    display: flex;
    flex-direction: column;
    z-index: 50;
  }
  .panel.open { transform: translateX(0); }
  .panel-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .panel-head h2 { flex: 1; font-size: 15px; letter-spacing: 0.06em; }
  .close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover { color: var(--klaxon); }
  .panel-body { overflow-y: auto; padding: 14px 16px 24px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px; }
  .note-input {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    padding: 8px 10px;
    resize: vertical;
  }
  .note-input:focus { outline: none; border-color: var(--klaxon-dim); }
  .items, .thoughts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    padding: 8px 10px;
    cursor: pointer;
  }
  .item:hover { border-color: var(--klaxon-dim); }
  .item.finished .item-title { color: var(--text-muted); text-decoration: line-through; }
  .item-time { font-size: 9px; letter-spacing: 0.12em; }
  .item-title { flex: 1; }
  .item-state { font-size: 8px; letter-spacing: 0.16em; }
  .thought {
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 8px 10px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-muted);
    white-space: pre-wrap;
  }
  .empty { font-size: 10px; letter-spacing: 0.16em; padding: 6px 0; }
  .add-row { display: flex; gap: 8px; }
  .add-btn {
    flex: 1;
    background: transparent;
    border: 1px dashed var(--border-strong);
    color: var(--text-muted);
    padding: 10px;
    font-size: 10px;
    letter-spacing: 0.16em;
    cursor: pointer;
  }
  .add-btn:hover { color: var(--klaxon); border-color: var(--klaxon); }

  @media (max-width: 1024px) {
    .panel { width: 100%; border-left: none; }
  }
</style>
