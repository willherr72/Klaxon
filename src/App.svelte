<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { api } from "./lib/api";
  import { reminders, filter, editingId, editorOpen, nowTick } from "./lib/stores";
  import type { FilterKey, Reminder, ReminderCreate } from "./lib/types";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import TopBar from "./lib/components/TopBar.svelte";
  import ReminderList from "./lib/components/ReminderList.svelte";
  import ReminderEditor from "./lib/components/ReminderEditor.svelte";
  import StatusBar from "./lib/components/StatusBar.svelte";
  import SettingsModal from "./lib/components/SettingsModal.svelte";

  let allReminders = $state<Reminder[]>([]);
  let currentFilter = $state<FilterKey>("all");
  let currentEditingId = $state<string | null>(null);
  let isEditorOpen = $state(false);
  let now = $state(Date.now());
  let settingsOpen = $state(false);

  reminders.subscribe((v) => (allReminders = v));
  filter.subscribe((v) => (currentFilter = v));
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

  let unlistenNew: UnlistenFn | null = null;

  function onKeydown(e: KeyboardEvent) {
    // Ctrl+N (or Cmd+N) → open new reminder. Ignored if any modifier-altered.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      !e.shiftKey &&
      e.key.toLowerCase() === "n"
    ) {
      e.preventDefault();
      openNew();
    }
  }

  onMount(async () => {
    refresh();
    unlistenNew = await listen("klaxon://open-new-reminder", () => {
      openNew();
    });
    window.addEventListener("keydown", onKeydown);
  });

  onDestroy(() => {
    if (unlistenNew) unlistenNew();
    window.removeEventListener("keydown", onKeydown);
  });

  let filtered = $derived.by(() => {
    const dayMs = 86_400_000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = today.getTime() + dayMs;

    switch (currentFilter) {
      case "today":
        return allReminders.filter(
          (r) =>
            r.state !== "completed" &&
            r.due_at >= today.getTime() &&
            r.due_at < tomorrow,
        );
      case "upcoming":
        return allReminders.filter(
          (r) => r.state !== "completed" && r.due_at >= tomorrow,
        );
      case "recurring":
        return allReminders.filter(
          (r) => r.state !== "completed" && r.repeat_rule != null,
        );
      case "completed":
        return allReminders.filter((r) => r.state === "completed");
      default:
        return allReminders.filter((r) => r.state !== "completed");
    }
  });

  let pendingCount = $derived(
    allReminders.filter((r) => r.state === "pending" || r.state === "snoozed").length,
  );

  let nextReminder = $derived.by<Reminder | null>(() => {
    const candidates = allReminders.filter(
      (r) => r.state === "pending" || r.state === "snoozed",
    );
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) =>
        (a.snooze_until ?? a.due_at) - (b.snooze_until ?? b.due_at),
    );
    return candidates[0];
  });

  let counts = $derived.by<Record<FilterKey, number>>(() => {
    const dayMs = 86_400_000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = today.getTime() + dayMs;
    return {
      all: allReminders.filter((r) => r.state !== "completed").length,
      today: allReminders.filter(
        (r) =>
          r.state !== "completed" &&
          r.due_at >= today.getTime() &&
          r.due_at < tomorrow,
      ).length,
      upcoming: allReminders.filter(
        (r) => r.state !== "completed" && r.due_at >= tomorrow,
      ).length,
      recurring: allReminders.filter(
        (r) => r.state !== "completed" && r.repeat_rule != null,
      ).length,
      completed: allReminders.filter((r) => r.state === "completed").length,
    };
  });

  let editingReminder = $derived(
    currentEditingId
      ? allReminders.find((r) => r.id === currentEditingId) ?? null
      : null,
  );

  function selectFilter(k: FilterKey) {
    filter.set(k);
  }

  function openNew() {
    editingId.set(null);
    editorOpen.set(true);
  }

  function openEdit(r: Reminder) {
    editingId.set(r.id);
    editorOpen.set(true);
  }

  function closeEditor() {
    editorOpen.set(false);
    editingId.set(null);
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
    current={currentFilter}
    counts={counts}
    onSelect={selectFilter}
    onNew={openNew}
    onOpenSettings={() => (settingsOpen = true)}
  />
  <TopBar
    filter={currentFilter}
    nextReminder={nextReminder}
    now={now}
  />
  <ReminderList
    reminders={filtered}
    selectedId={currentEditingId}
    onSelect={openEdit}
    onComplete={handleComplete}
    onDelete={handleListDelete}
  />
  <StatusBar
    pendingCount={pendingCount}
    nextReminder={nextReminder}
    now={now}
  />
  <ReminderEditor
    open={isEditorOpen}
    reminder={editingReminder}
    onClose={closeEditor}
    onSave={handleSave}
    onDelete={handleDelete}
  />
  <SettingsModal
    open={settingsOpen}
    onClose={() => (settingsOpen = false)}
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
