<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api } from "./lib/api";
  import { reminders, editingId, editorOpen, nowTick, setTickRate } from "./lib/stores";
  import { comboMatches } from "./lib/shortcut";
  import type { Reminder, ReminderCreate, TimeFilter, ViewMode } from "./lib/types";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TopBar from "./lib/components/TopBar.svelte";
  import ReminderList from "./lib/components/ReminderList.svelte";
  import ReminderEditor from "./lib/components/ReminderEditor.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import IncomingPairModal from "./lib/components/IncomingPairModal.svelte";
  import CalendarView from "./lib/components/CalendarView.svelte";
  import QuickAdd from "./lib/components/QuickAdd.svelte";
  import TasksBoard from "./lib/components/TasksBoard.svelte";

  let allReminders = $state<Reminder[]>([]);
  let currentView = $state<ViewMode>("reminders");
  let currentTimeFilter = $state<TimeFilter>("all");
  let currentEditingId = $state<string | null>(null);
  let isEditorOpen = $state(false);
  let now = $state(Date.now());
  let settingsOpen = $state(false);
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let sortOrder = $state<"date_asc" | "date_desc">("date_asc");
  let editorDefaultDueAt = $state<number | null>(null);
  let editorDefaultSilent = $state(false);
  // v0.3.1: when the user hits `+ Add task` on a swim-lane column, this
  // pre-seeds the editor so the saved task lands in the right lane.
  let editorDefaultLaneId = $state<string | null>(null);
  let tagFilter = $state<string | null>(null);
  let quickAddOpen = $state(false);
  let quickAddHotkey = $state("Ctrl+KeyK");

  reminders.subscribe((v) => (allReminders = v));
  editingId.subscribe((v) => (currentEditingId = v));
  editorOpen.subscribe((v) => (isEditorOpen = v));
  nowTick.subscribe((v) => (now = v));

  async function refresh() {
    try {
      const list = await api.listReminders();
      reminders.set(list);
    } catch (e) {
      console.error("listReminders failed", e);
    }
  }

  async function loadSort() {
    try {
      const v = await api.getSetting("list_sort_order");
      if (v === "date_desc") sortOrder = "date_desc";
      else sortOrder = "date_asc";
    } catch (e) {
      console.warn("loadSort failed", e);
    }
  }

  async function loadInappHotkeys() {
    try {
      const v = await api.getSetting("inapp_hotkey_quickadd");
      quickAddHotkey = v?.trim() ? v : "Ctrl+KeyK";
    } catch (e) {
      console.warn("loadInappHotkeys failed", e);
    }
  }

  function handleSettingsClose() {
    settingsOpen = false;
    // Sort + in-app hotkeys may have changed — refresh.
    loadSort();
    loadInappHotkeys();
  }

  let unlistenNew: UnlistenFn | null = null;
  let unlistenChanged: UnlistenFn | null = null;

  function onKeydown(e: KeyboardEvent) {
    // Ctrl+N → open new reminder
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "n"
    ) {
      e.preventDefault();
      openNew();
      return;
    }
    // Ctrl+F → open search
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "f"
    ) {
      e.preventDefault();
      searchOpen = true;
      return;
    }
    // Configurable Quick Add hotkey (default Ctrl+K)
    if (comboMatches(quickAddHotkey, e)) {
      e.preventDefault();
      quickAddOpen = true;
      return;
    }
    // Esc → close search (if active and not currently inside a text field
    // — the search/editor inputs handle their own Esc)
    if (e.key === "Escape" && searchOpen) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      searchOpen = false;
      searchQuery = "";
    }
  }

  onMount(async () => {
    refresh();
    loadSort();
    loadInappHotkeys();
    unlistenNew = await listen("klaxon://open-new-reminder", () => {
      openNew();
    });
    // Backend signals this whenever it mutates reminders without a user
    // command — sync push/pull applying remote changes, scheduler firing
    // a reminder, scheduler rescheduling a recurring item. We just re-fetch.
    unlistenChanged = await listen("klaxon://reminders-changed", () => {
      refresh();
    });
    window.addEventListener("keydown", onKeydown);
  });

  onDestroy(() => {
    if (unlistenNew) unlistenNew();
    if (unlistenChanged) unlistenChanged();
    window.removeEventListener("keydown", onKeydown);
  });

  // States:
  //   Pending   — will ring at due_at
  //   Snoozed   — will ring at snooze_until (overrides due_at)
  //   Fired     — one-shot whose alarm has played; user hasn't decided yet
  //   Dismissed — user closed the alarm; task still on the list
  //   Completed — user marked done; terminal
  // Active list shows everything except Completed. Only Completed is "done."
  function isActive(r: Reminder): boolean {
    return r.state !== "completed";
  }
  function isDone(r: Reminder): boolean {
    return r.state === "completed";
  }
  function effectiveTime(r: Reminder): number {
    return r.state === "snoozed" && r.snooze_until != null
      ? r.snooze_until
      : r.due_at;
  }

  let filtered = $derived.by(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = today.getTime() + 86_400_000;

    // Step 1: filter by primary view (sidebar).
    let result: Reminder[];
    switch (currentView) {
      case "tasks":
        result = allReminders.filter((r) => r.silent && isActive(r));
        break;
      case "calendar":
        result = allReminders.filter(isActive);
        break;
      case "completed":
        result = allReminders.filter(isDone);
        break;
      case "reminders":
      default:
        result = allReminders.filter((r) => !r.silent && isActive(r));
        break;
    }

    // Step 2: apply time filter (top-bar chips) — uses effective time so a
    // snoozed reminder appears in the bucket of its NEXT fire, not its
    // original due_at.
    if (currentView === "reminders" || currentView === "tasks") {
      switch (currentTimeFilter) {
        case "today":
          result = result.filter((r) => {
            const t = effectiveTime(r);
            return t >= today.getTime() && t < tomorrow;
          });
          break;
        case "upcoming":
          result = result.filter((r) => effectiveTime(r) >= tomorrow);
          break;
        case "recurring":
          result = result.filter((r) => r.repeat_rule != null);
          break;
        // "all" — no narrowing
      }
    }

    // Step 3: text search across title + description.
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((r) => {
        if (r.title.toLowerCase().includes(q)) return true;
        if (r.description && r.description.toLowerCase().includes(q)) return true;
        if (r.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      });
    }

    // Step 3b: tag filter (set by clicking a tag chip on a reminder).
    if (tagFilter) {
      result = result.filter((r) => r.tags.includes(tagFilter as string));
    }

    // Step 4: sort by effective time per user preference.
    const sorted = [...result].sort((a, b) => {
      const aT = effectiveTime(a);
      const bT = effectiveTime(b);
      return sortOrder === "date_desc" ? bT - aT : aT - bT;
    });
    return sorted;
  });

  let pendingCount = $derived(
    allReminders.filter((r) => r.state === "pending" || r.state === "snoozed").length,
  );

  let nextReminder = $derived.by<Reminder | null>(() => {
    // "Next in" represents the next *alert* that will fire. Silent tasks
    // don't ring, so they're not real next-events. And a past-due
    // pending item (typically a silent task that wasn't acted on) would
    // peg the countdown at 00:00:00 forever — skip those too.
    const nowMs = now;
    const candidates = allReminders.filter(
      (r) =>
        !r.silent &&
        (r.state === "pending" || r.state === "snoozed") &&
        (r.snooze_until ?? r.due_at) > nowMs,
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        (a.snooze_until ?? a.due_at) - (b.snooze_until ?? b.due_at),
    );
    return candidates[0];
  });

  let counts = $derived.by<Record<ViewMode, number>>(() => ({
    reminders: allReminders.filter((r) => !r.silent && isActive(r)).length,
    tasks: allReminders.filter((r) => r.silent && isActive(r)).length,
    calendar: allReminders.filter(isActive).length,
    completed: allReminders.filter(isDone).length,
  }));

  let editingReminder = $derived(
    currentEditingId
      ? allReminders.find((r) => r.id === currentEditingId) ?? null
      : null,
  );

  // Tick fast (1 s) only when the soonest visible countdown is sub-day,
  // since that's the threshold where HH:MM:SS precision matters. For
  // multi-day countdowns the minute digit only changes every 60 s, so a
  // 30 s tick is plenty and saves CPU.
  $effect(() => {
    const target = nextReminder
      ? (nextReminder.snooze_until ?? nextReminder.due_at)
      : null;
    if (target == null) {
      setTickRate(30_000);
      return;
    }
    const diff = target - now;
    setTickRate(diff > 86_400_000 ? 30_000 : 1000);
  });

  function selectView(k: ViewMode) {
    currentView = k;
  }

  function selectTimeFilter(t: TimeFilter) {
    currentTimeFilter = t;
  }

  function selectTag(t: string) {
    tagFilter = t === tagFilter ? null : t;
  }

  function clearTagFilter() {
    tagFilter = null;
  }

  function openNew() {
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
    editingId.set(null);
    editorOpen.set(true);
  }

  /** Open the editor for a brand-new reminder/task, pre-seeded to the given
   * timestamp. Used by the calendar's right-click → context menu flow. */
  function openNewForDate(ms: number, silent: boolean) {
    editorDefaultDueAt = ms;
    editorDefaultSilent = silent;
    editorDefaultLaneId = null;
    editingId.set(null);
    editorOpen.set(true);
  }

  /** Open the editor for a brand-new task that should land in a specific
   * swim lane. Used by the `+ Add task` button on a column. */
  function openNewInLane(laneId: string) {
    editorDefaultDueAt = null;
    editorDefaultSilent = true;
    editorDefaultLaneId = laneId;
    editingId.set(null);
    editorOpen.set(true);
  }

  function openEdit(r: Reminder) {
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
    editingId.set(r.id);
    editorOpen.set(true);
  }

  function closeEditor() {
    editorOpen.set(false);
    editingId.set(null);
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
  }

  async function handleSave(input: ReminderCreate, id: string | null) {
    try {
      if (id) {
        await api.updateReminder(id, {
          title: input.title,
          description: input.description,
          due_at: input.due_at,
          priority: input.priority,
          sound_path: input.sound_path,
          repeat_rule: input.repeat_rule,
          silent: input.silent,
        });
      } else {
        await api.createReminder(input);
      }
      closeEditor();
      await refresh();
    } catch (e) {
      console.error("save failed", e);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteReminder(id);
      closeEditor();
      await refresh();
    } catch (e) {
      console.error("delete failed", e);
    }
  }

  async function handleComplete(r: Reminder) {
    try {
      await api.completeReminder(r.id);
      await refresh();
    } catch (e) {
      console.error("complete failed", e);
    }
  }

  async function handleListDelete(r: Reminder) {
    try {
      await api.deleteReminder(r.id);
      await refresh();
    } catch (e) {
      console.error("delete failed", e);
    }
  }
</script>

<div class="app" class:editor-open={isEditorOpen}>
  <Sidebar
    current={currentView}
    counts={counts}
    onSelect={selectView}
    onNew={openNew}
    onOpenSettings={() => (settingsOpen = true)}
  />
  <TopBar
    view={currentView}
    timeFilter={currentTimeFilter}
    onTimeFilterChange={selectTimeFilter}
    tagFilter={tagFilter}
    onTagFilterClear={clearTagFilter}
    nextReminder={nextReminder}
    now={now}
  />
  {#if currentView === "calendar"}
    <CalendarView
      reminders={filtered}
      onSelect={openEdit}
      onCreateForDate={openNewForDate}
    />
  {:else if currentView === "tasks"}
    <TasksBoard
      reminders={filtered}
      onSelect={openEdit}
      onAddCardToLane={openNewInLane}
    />
  {:else}
    <ReminderList
      reminders={filtered}
      selectedId={currentEditingId}
      onSelect={openEdit}
      onComplete={handleComplete}
      onDelete={handleListDelete}
      onTagClick={selectTag}
      searchOpen={searchOpen}
      bind:searchQuery
      onSearchClose={() => { searchOpen = false; searchQuery = ""; }}
      sortOrder={sortOrder}
    />
  {/if}
  <StatusBar
    pendingCount={pendingCount}
    nextReminder={nextReminder}
    now={now}
  />
  <ReminderEditor
    open={isEditorOpen}
    reminder={editingReminder}
    defaultDueAt={editorDefaultDueAt}
    defaultSilent={editorDefaultSilent}
    defaultLaneId={editorDefaultLaneId}
    onClose={closeEditor}
    onSave={handleSave}
    onDelete={handleDelete}
  />
  <SettingsModal
    open={settingsOpen}
    onClose={handleSettingsClose}
  />
  <IncomingPairModal />
  <QuickAdd
    open={quickAddOpen}
    onClose={() => (quickAddOpen = false)}
    onCreate={async (input) => {
      try {
        await api.createReminder(input);
        await refresh();
      } catch (e) {
        console.error("quick-add create failed", e);
      }
    }}
  />
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    grid-template-rows: var(--header-h) 1fr var(--status-h);
    grid-template-areas:
      "sidebar topbar"
      "sidebar main"
      "status status";
    height: 100vh;
    width: 100vw;
    transition: padding-right 240ms var(--ease);
  }
  .app.editor-open {
    padding-right: var(--editor-w);
  }
</style>
