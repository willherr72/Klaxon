<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api, type UpdateCheck } from "./lib/api";
  import { getVersion } from "@tauri-apps/api/app";
  import changelogRaw from "../CHANGELOG.md?raw";
  import { extractChangelogSection } from "./lib/whatsnew";
  import { renderMdLite } from "./lib/mdlite";
  import { reminders, editingId, editorOpen, nowTick, setTickRate } from "./lib/stores";
  import { comboMatches } from "./lib/shortcut";
  import type { Reminder, ReminderCreate, TimeFilter, ViewMode } from "./lib/types";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TopBar from "./lib/components/TopBar.svelte";
  import ReminderList from "./lib/components/ReminderList.svelte";
  import ReminderEditor from "./lib/components/ReminderEditor.svelte";
  import ThoughtsView from "./lib/components/ThoughtsView.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";
  import IncomingPairModal from "./lib/components/IncomingPairModal.svelte";
  import CalendarView from "./lib/components/CalendarView.svelte";
  import QuickAdd from "./lib/components/QuickAdd.svelte";
  import TasksBoard from "./lib/components/TasksBoard.svelte";
  import {
    isPermissionGranted as isNotifPermissionGranted,
    requestPermission as requestNotifPermission,
  } from "@tauri-apps/plugin-notification";
  import {
    reconcileScheduledNotifications,
    setupMobileNotifications,
  } from "./lib/mobile-scheduler";

  let allReminders = $state<Reminder[]>([]);
  let availableUpdate = $state<UpdateCheck | null>(null);
  let whatsNew = $state<string | null>(null);
  let appVersionNow = $state("");

  async function initWhatsNew(): Promise<void> {
    try {
      appVersionNow = await getVersion();
      const lastSeen = await api.getSetting("last_seen_version");
      if (lastSeen === null) {
        // Fresh install: swallow silently so a brand-new user gets the
        // first-run card, not release notes for a version they never
        // upgraded from.
        await api.setSetting("last_seen_version", appVersionNow);
      } else if (lastSeen !== appVersionNow) {
        whatsNew = extractChangelogSection(changelogRaw, appVersionNow);
        if (whatsNew === null) {
          // Section missing (dev build) — don't re-check every launch.
          await api.setSetting("last_seen_version", appVersionNow);
        }
      }
    } catch (e) {
      console.warn("what's-new init failed", e);
    }
  }

  async function dismissWhatsNew(): Promise<void> {
    whatsNew = null;
    await api.setSetting("last_seen_version", appVersionNow);
  }

  // First-run card (v0.7.1): only when the whole app is genuinely empty
  // — any reminder, thought, or peer anywhere suppresses it forever, so
  // restores and synced-in data never see onboarding.
  let showFirstRun = $state(false);

  async function evalFirstRun(): Promise<void> {
    try {
      if (allReminders.length > 0) return;
      if ((await api.getSetting("onboarding_dismissed")) !== null) return;
      const [peers, thoughts] = await Promise.all([
        api.listPeers(),
        api.listThoughts(null, 1, 0),
      ]);
      showFirstRun = peers.length === 0 && thoughts.length === 0;
    } catch {
      showFirstRun = false;
    }
  }

  async function dismissFirstRun(): Promise<void> {
    showFirstRun = false;
    try {
      await api.setSetting("onboarding_dismissed", "1");
    } catch (e) {
      console.warn("onboarding dismiss failed", e);
    }
  }

  async function runUpdateCheck(): Promise<void> {
    try {
      const r = await api.checkForUpdate();
      availableUpdate = r.update_available ? r : null;
    } catch (e) {
      console.warn("update check failed (silent)", e);
    }
  }
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
  // Seeds the title when promoting a thought into a task or reminder.
  // Cleared by every other editor-opening path so a promoted thought
  // can't leak into the next "New reminder".
  let editorDefaultTitle = $state("");
  // v0.3.1: when the user hits `+ Add task` on a swim-lane column, this
  // pre-seeds the editor so the saved task lands in the right lane.
  let editorDefaultLaneId = $state<string | null>(null);
  // Bumped by every openNew*/openEdit call. Lets the editor tell a real
  // open from the `reminder` prop being swapped by a list refresh, so it
  // re-seeds for the former and leaves unsaved edits alone for the latter.
  let editorSeedToken = $state(0);
  let tagFilter = $state<string | null>(null);
  let quickAddOpen = $state(false);
  let quickAddHotkey = $state("Ctrl+KeyK");
  // Bound from CalendarView's day panel (Finding 3, v0.10.0 review): the
  // panel's open state used to live entirely inside CalendarView, so App
  // couldn't see it and Back backgrounded the whole app with the panel
  // still open instead of closing it. Read-only from here — closing goes
  // through calendarViewRef.closePanel(), never a direct assignment, so
  // the panel's own flush-on-close runs.
  let calendarPanelOpen = $state(false);
  let calendarViewRef: CalendarView | undefined = $state();

  // Android back-button handling. The Tauri webview routes the system
  // back press to `popstate`. Strategy: every time a modal transitions
  // from closed → open, push a history entry; popstate closes the
  // topmost open modal. If the user closes via X, the entry stays
  // (one harmless "no-op" back press before exit) — simpler than
  // trying to keep history depth perfectly in sync.
  let prevEditorOpenForBack = false;
  let prevSettingsOpenForBack = false;
  let prevQuickAddOpenForBack = false;
  let prevSearchOpenForBack = false;
  let prevCalendarPanelOpenForBack = false;
  $effect(() => {
    if (isEditorOpen && !prevEditorOpenForBack) {
      history.pushState({ klaxonModal: "editor" }, "");
    }
    prevEditorOpenForBack = isEditorOpen;
  });
  $effect(() => {
    if (settingsOpen && !prevSettingsOpenForBack) {
      history.pushState({ klaxonModal: "settings" }, "");
    }
    prevSettingsOpenForBack = settingsOpen;
  });
  $effect(() => {
    if (quickAddOpen && !prevQuickAddOpenForBack) {
      history.pushState({ klaxonModal: "quickadd" }, "");
    }
    prevQuickAddOpenForBack = quickAddOpen;
  });
  $effect(() => {
    if (searchOpen && !prevSearchOpenForBack) {
      history.pushState({ klaxonModal: "search" }, "");
    }
    prevSearchOpenForBack = searchOpen;
  });
  $effect(() => {
    if (calendarPanelOpen && !prevCalendarPanelOpenForBack) {
      history.pushState({ klaxonModal: "calendarPanel" }, "");
    }
    prevCalendarPanelOpenForBack = calendarPanelOpen;
  });
  // CalendarView (and its bound panelOpen) unmounts whenever the user
  // navigates to another primary view — unlike the other four overlays,
  // which stay mounted for the app's whole life. Without this, switching
  // away from the calendar while the panel was open would leave
  // calendarPanelOpen stuck true with no CalendarView left to close.
  $effect(() => {
    if (currentView !== "calendar") calendarPanelOpen = false;
  });

  function onPopState() {
    // Close in z-index priority: editor sits on top of everything else.
    if (isEditorOpen) { closeEditor(); return; }
    // Goes through closePanel(), not a direct assignment, so DayPanel's
    // own close() runs and flushes any pending note before the panel
    // hides — see the comment on calendarPanelOpen above.
    if (calendarPanelOpen) { calendarViewRef?.closePanel(); return; }
    if (settingsOpen) { settingsOpen = false; return; }
    if (quickAddOpen) { quickAddOpen = false; return; }
    if (searchOpen) { searchOpen = false; searchQuery = ""; return; }
    // No modal open — let the browser/OS handle (exits app on Android).
  }

  reminders.subscribe((v) => (allReminders = v));
  editingId.subscribe((v) => (currentEditingId = v));
  editorOpen.subscribe((v) => (isEditorOpen = v));
  nowTick.subscribe((v) => (now = v));

  // Serialized form of the rows last published to the store, so a refresh
  // that fetches identical rows can skip re-publishing them. Every mutating
  // command emits klaxon://reminders-changed AND its handler calls
  // refresh(), so the same state is routinely fetched twice in a row;
  // re-setting the store the second time re-derives every view and
  // re-renders the board for nothing (issue #6). Safe to cache because
  // this is the only place that writes the store. The "" start is a
  // sentinel no JSON.stringify result can equal (the shortest is "[]"),
  // so the first fetch always publishes.
  let publishedReminders = "";

  // Reconciling OS alarms is the expensive half — on Android it's a full
  // AlarmManager pass; on desktop it's a no-op. Coalesce bursts into one
  // trailing run rather than skipping any: a reconcile that is merely
  // late still arms every future alarm, whereas one that is wrongly
  // skipped does not, and cold alarms are not something to be clever
  // about.
  const RECONCILE_COALESCE_MS = 300;
  // Ceiling on how long coalescing may defer a pass. A steady sub-300ms
  // stream of events would otherwise push the deadline out forever; no
  // current emitter can produce one, but alarms are the wrong place to
  // rely on that staying true.
  const RECONCILE_MAX_WAIT_MS = 1000;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileDueBy = 0;

  function runReconcile() {
    if (reconcileTimer !== null) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    reconcileDueBy = 0;
    reconcileScheduledNotifications().catch((e) =>
      console.warn("reconcileScheduledNotifications failed", e),
    );
  }

  function scheduleReconcile() {
    const nowMs = Date.now();
    if (reconcileTimer === null) reconcileDueBy = nowMs + RECONCILE_MAX_WAIT_MS;
    else clearTimeout(reconcileTimer);
    const delay = Math.max(0, Math.min(RECONCILE_COALESCE_MS, reconcileDueBy - nowMs));
    reconcileTimer = setTimeout(runReconcile, delay);
  }

  /// Run a pending reconcile NOW rather than losing it. On a device with
  /// sync disabled — the default — this webview timer is the only thing
  /// that ever arms an OS alarm: both background reconcilers short-circuit
  /// when sync is off. So a pending pass must be flushed at the moments
  /// the process may stop existing (backgrounding, teardown), or a
  /// just-created reminder would silently never ring.
  function flushReconcile() {
    if (reconcileTimer === null) return;
    runReconcile();
  }

  async function refresh() {
    try {
      const list = await api.listReminders();
      // Keep the OS-level scheduled notifications (AlarmManager on
      // Android) in sync with whatever the canonical reminder list looks
      // like now. No-op on desktop. Scheduled unconditionally — every
      // refresh reconciles exactly as before, bursts just collapse into
      // one pass instead of two.
      scheduleReconcile();
      const published = JSON.stringify(list);
      if (published === publishedReminders) return;
      publishedReminders = published;
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
    await refresh();
    void evalFirstRun();
    loadSort();
    loadInappHotkeys();
    // Mobile: register notification channels + action buttons + tap
    // handler. No-op on desktop. The tap handler routes through
    // openReminderById so a notification body tap deep-links into
    // the editor for that reminder.
    setupMobileNotifications({ onOpenReminder: openReminderById }).catch(
      (e) => console.warn("setupMobileNotifications failed", e),
    );
    // Ask for notification permission once per install. Android 13+
    // refuses to show notifications until POST_NOTIFICATIONS is granted
    // — without this the app silently fails to fire any reminder on
    // mobile. Idempotent: the OS only shows the prompt the first time;
    // subsequent calls return cached state.
    try {
      const granted = await isNotifPermissionGranted();
      if (!granted) await requestNotifPermission();
    } catch (e) {
      console.error("notification permission check failed", e);
    }
    // Update check: delayed so it never competes with startup, then
    // daily while running. Auto-checks are silent — failures only ever
    // surface from the manual "Check now" button in Settings.
    setTimeout(() => void runUpdateCheck(), 5_000);
    setInterval(() => void runUpdateCheck(), 24 * 60 * 60 * 1000);
    void initWhatsNew();
    // Sync-on-foreground. When the mobile OS brings Klaxon back from
    // the background, kick an immediate sync pass so the user sees
    // fresh data from peers instead of waiting up to 20s for the next
    // periodic tick. Desktop also benefits when the window regains
    // focus after a long idle. Errors are non-fatal — the periodic
    // tick will retry anyway.
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("popstate", onPopState);

    unlistenNew = await listen("klaxon://open-new-reminder", () => {
      openNew();
    });
    // Backend signals this whenever it mutates reminders: sync push/pull
    // applying remote changes, the scheduler firing or rescheduling, and
    // the mutating commands themselves (update, place_task, sort lane).
    // Commands emit too so a caller that can't re-fetch on its own — the
    // Tasks board's star control, say — still shows the truth. We just
    // re-fetch.
    unlistenChanged = await listen("klaxon://reminders-changed", () => {
      refresh();
    });
    window.addEventListener("keydown", onKeydown);
  });

  onDestroy(() => {
    flushReconcile();
    if (unlistenNew) unlistenNew();
    if (unlistenChanged) unlistenChanged();
    window.removeEventListener("keydown", onKeydown);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("popstate", onPopState);
  });

  function onVisibilityChange() {
    if (document.visibilityState !== "visible") {
      // Going to background is exactly when the cold-alarm guarantee
      // starts mattering, and when the process may be killed without
      // warning — don't leave a coalesced reconcile pending.
      flushReconcile();
      return;
    }
    api.syncNow().catch((e) => console.warn("syncNow failed", e));
  }

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
    const nowMs = Date.now();
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
          // "Everything still to come": anything not yet due, from now
          // onward — includes later today and all future days, and excludes
          // past-due items. (Completed items are already filtered out by the
          // active-view step above.)
          result = result.filter((r) => effectiveTime(r) >= nowMs);
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

  // Partial: the Thoughts channel deliberately carries no badge — see
  // the note on `items` in Sidebar.svelte.
  let counts = $derived.by<Partial<Record<ViewMode, number>>>(() => ({
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
    editorSeedToken++;
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
    editorDefaultTitle = "";
    editingId.set(null);
    editorOpen.set(true);
  }

  /** Open the editor for a brand-new reminder/task, pre-seeded to the given
   * timestamp. Used by the calendar's right-click → context menu flow. */
  function openNewForDate(ms: number, silent: boolean) {
    editorSeedToken++;
    editorDefaultDueAt = ms;
    editorDefaultSilent = silent;
    editorDefaultLaneId = null;
    editorDefaultTitle = "";
    editingId.set(null);
    editorOpen.set(true);
  }

  /** Open the editor for a brand-new task or reminder seeded from a
   * thought's text. The thought itself is untouched — this is a copy, not
   * a move, so acting on an idea never puts a hole in the archive.
   *
   * Only the first line becomes the title: a title field shouldn't hold a
   * paragraph, and the rest of the thought stays available in the feed. */
  function openNewFromThought(body: string, silent: boolean) {
    editorSeedToken++;
    editorDefaultDueAt = null;
    editorDefaultSilent = silent;
    editorDefaultLaneId = null;
    editorDefaultTitle = body.split("\n")[0].slice(0, 200);
    editingId.set(null);
    editorOpen.set(true);
  }

  /** Open the editor for a brand-new task that should land in a specific
   * swim lane. Used by the `+ Add task` button on a column. */
  function openNewInLane(laneId: string) {
    editorSeedToken++;
    editorDefaultDueAt = null;
    editorDefaultSilent = true;
    editorDefaultLaneId = laneId;
    editorDefaultTitle = "";
    editingId.set(null);
    editorOpen.set(true);
  }

  function openEdit(r: Reminder) {
    editorSeedToken++;
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
    editorDefaultTitle = "";
    editingId.set(r.id);
    editorOpen.set(true);
  }

  /// Open the editor for a reminder by id. Used by the mobile
  /// notification deep-link (body-tap) — the OS hands us only the
  /// reminder UUID via `extra`, so we look up the full reminder
  /// either from the current in-memory list (synced reload may have
  /// dropped it) or from the backend as a fallback.
  async function openReminderById(id: string) {
    let r = allReminders.find((x) => x.id === id) ?? null;
    if (!r) {
      try {
        r = await api.getReminder(id);
      } catch (e) {
        console.warn("openReminderById: getReminder failed", e);
        return;
      }
    }
    if (r) openEdit(r);
  }

  function closeEditor() {
    editorOpen.set(false);
    editingId.set(null);
    editorDefaultDueAt = null;
    editorDefaultSilent = false;
    editorDefaultLaneId = null;
    editorDefaultTitle = "";
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
          tags: input.tags,
          task_lane_id: input.task_lane_id ?? null,
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

  /// Complete from inside the editor (e.g. marking a task done). Unlike the
  /// list's inline complete, this also closes the editor since the item
  /// leaves the active view.
  async function handleEditorComplete(id: string) {
    try {
      await api.completeReminder(id);
      closeEditor();
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
  {#if whatsNew}
    <!-- Floating on purpose: .app is a named-area grid, and an in-flow
         card would auto-place into a phantom cell. -->
    <div class="whatsnew">
      <div class="mono-caps">Updated to v{appVersionNow}</div>
      <div class="whatsnew-body">
        <!-- renderMdLite escapes before injecting -->
        {@html renderMdLite(whatsNew)}
      </div>
      <button class="whatsnew-btn mono-caps" onclick={dismissWhatsNew}>Got it</button>
    </div>
  {/if}
  {#if currentView === "calendar"}
    <!-- allReminders is deliberately the unfiltered list, not `filtered`:
         the day panel answers "what actually happened this day"
         (fired/dismissed/completed included, spec: UI section 2), which
         must not shrink just because a search or tag filter narrowed the
         grid. Grid and panel disagreeing on count while a filter is
         active is intended, not a bug — do not "fix" this back to one prop. -->
    <CalendarView
      bind:this={calendarViewRef}
      bind:panelOpen={calendarPanelOpen}
      reminders={filtered}
      allReminders={allReminders}
      onSelect={openEdit}
      onCreateForDate={openNewForDate}
    />
  {:else if currentView === "tasks"}
    <TasksBoard
      reminders={filtered}
      onSelect={openEdit}
      onAddCardToLane={openNewInLane}
    />
  {:else if currentView === "thoughts"}
    <ThoughtsView
      onMakeTask={(body) => openNewFromThought(body, true)}
      onMakeReminder={(body) => openNewFromThought(body, false)}
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
      firstRun={showFirstRun}
      onFirstRunCreate={() => { void dismissFirstRun(); openNew(); }}
      onFirstRunPair={() => { void dismissFirstRun(); settingsOpen = true; }}
      onFirstRunDismiss={() => void dismissFirstRun()}
    />
  {/if}
  <StatusBar
    pendingCount={pendingCount}
    nextReminder={nextReminder}
    now={now}
    availableUpdate={availableUpdate}
  />
  <ReminderEditor
    open={isEditorOpen}
    reminder={editingReminder}
    defaultDueAt={editorDefaultDueAt}
    defaultSilent={editorDefaultSilent}
    defaultLaneId={editorDefaultLaneId}
    defaultTitle={editorDefaultTitle}
    seedToken={editorSeedToken}
    onClose={closeEditor}
    onSave={handleSave}
    onDelete={handleDelete}
    onComplete={handleEditorComplete}
  />
  <SettingsModal
    open={settingsOpen}
    onClose={handleSettingsClose}
    availableUpdate={availableUpdate}
    onUpdateChecked={(r: UpdateCheck) =>
      (availableUpdate = r.update_available ? r : null)}
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

  /* ── Mobile / narrow viewports ────────────────────────────────────
   * Fold cover display is ~904px wide; phones are typically <=600px.
   * Anything below 1024px is treated as "mobile" — sidebar collapses
   * to a bottom nav, status bar tucks under the main area, and the
   * editor goes full-screen instead of a side panel.
   */
  @media (max-width: 1024px) {
    .app {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: var(--header-h) 1fr var(--status-h) 64px;
      grid-template-areas:
        "topbar"
        "main"
        "status"
        "sidebar";
      padding-top: env(safe-area-inset-top, 0);
      padding-bottom: env(safe-area-inset-bottom, 0);
      box-sizing: border-box;
      overflow: hidden;
    }
    /* Every grid item gets `min-width: 0` so an oversized child
     * (e.g. an unwrapping chip row) can't push the column wider than
     * the viewport and trigger horizontal scroll. */
    .app > * { min-width: 0; }
    .app.editor-open {
      padding-right: 0;
    }
  }

  /* v0.7.1 what's-new card — floats above the grid, toast-style. */
  .whatsnew {
    position: fixed;
    top: 56px;
    right: 16px;
    z-index: 60;
    max-width: 420px;
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  }
  .whatsnew-body {
    margin: 0;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .whatsnew-body :global(h4) {
    margin: 8px 0 4px;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text);
  }
  .whatsnew-body :global(ul) {
    margin: 4px 0;
    padding-left: 18px;
  }
  .whatsnew-body :global(li) {
    margin: 2px 0;
  }
  .whatsnew-body :global(p) {
    margin: 4px 0;
  }
  .whatsnew-btn {
    align-self: flex-end;
    background: transparent;
    border: 1px solid var(--border-strong);
    color: var(--text);
    padding: 5px 14px;
    cursor: pointer;
  }
  .whatsnew-btn:hover {
    border-color: var(--klaxon);
  }
  @media (max-width: 1024px) {
    .whatsnew {
      left: 12px;
      right: 12px;
      max-width: none;
    }
  }
</style>
