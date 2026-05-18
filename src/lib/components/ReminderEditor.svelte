<script lang="ts">
  import { msToLocalInput, localInputToMs } from "../time";
  import type { Priority, Reminder, ReminderCreate, RepeatRule } from "../types";
  import SignalLight from "./SignalLight.svelte";

  let {
    open,
    reminder,
    defaultDueAt = null,
    defaultSilent = false,
    onClose,
    onSave,
    onDelete,
  }: {
    open: boolean;
    reminder: Reminder | null;
    defaultDueAt?: number | null;
    defaultSilent?: boolean;
    onClose: () => void;
    onSave: (input: ReminderCreate, id: string | null) => void;
    onDelete: (id: string) => void;
  } = $props();

  let title = $state("");
  let description = $state("");
  let dueLocal = $state(msToLocalInput(Date.now() + 3600_000));
  let priority = $state<Priority>("normal");
  let repeatKind = $state<"none" | "daily" | "weekly" | "interval" | "monthly">("none");
  let intervalSecs = $state(3600);
  let silent = $state(false);
  let tags = $state<string[]>([]);
  let tagDraft = $state("");
  let titleInput: HTMLInputElement | null = $state(null);

  function normalizeTag(raw: string): string {
    return raw.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function commitTagDraft() {
    const t = normalizeTag(tagDraft);
    if (!t) {
      tagDraft = "";
      return;
    }
    if (!tags.includes(t)) {
      tags = [...tags, t];
    }
    tagDraft = "";
  }

  function removeTag(t: string) {
    tags = tags.filter((x) => x !== t);
  }

  $effect(() => {
    if (open && titleInput) {
      // Wait for the slide-in transition to begin so focus doesn't yank attention.
      const t = setTimeout(() => titleInput?.focus(), 80);
      return () => clearTimeout(t);
    }
  });

  $effect(() => {
    // Re-seed every time the editor opens. Reading `open` makes the effect
    // re-run on null → null transitions (e.g. opening "new" twice in a row)
    // — without it, the previous title sticks around.
    if (!open) return;
    if (reminder) {
      title = reminder.title;
      description = reminder.description ?? "";
      dueLocal = msToLocalInput(reminder.due_at);
      priority = reminder.priority;
      repeatKind = reminder.repeat_rule?.kind ?? "none";
      if (reminder.repeat_rule?.kind === "interval") {
        intervalSecs = reminder.repeat_rule.every_seconds;
      } else {
        intervalSecs = 3600;
      }
      silent = reminder.silent;
      tags = [...reminder.tags];
    } else {
      title = "";
      description = "";
      dueLocal = msToLocalInput(defaultDueAt ?? Date.now() + 3600_000);
      priority = "normal";
      repeatKind = "none";
      intervalSecs = 3600;
      silent = defaultSilent;
      tags = [];
    }
    tagDraft = "";
  });

  function buildRepeatRule(): RepeatRule | null {
    switch (repeatKind) {
      case "daily": return { kind: "daily" };
      case "weekly": return { kind: "weekly", weekdays: [0, 1, 2, 3, 4] };
      case "interval": return { kind: "interval", every_seconds: intervalSecs };
      case "monthly": return { kind: "monthly", day: new Date(localInputToMs(dueLocal)).getDate() };
      default: return null;
    }
  }

  function handleSave() {
    if (!title.trim()) return;
    // Flush any unfinished tag draft so the user doesn't lose a tag they
    // typed but didn't press Enter on.
    if (tagDraft.trim()) commitTagDraft();
    const input: ReminderCreate = {
      title: title.trim(),
      description: description.trim() || null,
      due_at: localInputToMs(dueLocal),
      priority,
      sound_path: null,
      repeat_rule: silent ? null : buildRepeatRule(),
      silent,
      tags,
    };
    onSave(input, reminder?.id ?? null);
  }

  function onWindowKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }
</script>

<svelte:window onkeydown={onWindowKey} />

<aside class="editor" class:open>
  <div class="edge"></div>
  <header class="head">
    <div class="head-left">
      <span class="dot"></span>
      <span class="display head-title">
        {reminder ? "EDIT" : "NEW"}
      </span>
    </div>
    <button class="close" onclick={onClose} aria-label="Close">×</button>
  </header>

  <div class="form">
    <div class="kind-toggle">
      <button
        class="kind-btn"
        class:active={!silent}
        onclick={() => (silent = false)}
        type="button"
      >
        Reminder
      </button>
      <button
        class="kind-btn"
        class:active={silent}
        onclick={() => (silent = true)}
        type="button"
      >
        Task
      </button>
    </div>

    <label class="field">
      <span class="mono-caps-faint">Title</span>
      <input
        bind:this={titleInput}
        class="title-input"
        type="text"
        placeholder="Remember what?"
        bind:value={title}
      />
    </label>

    <label class="field">
      <span class="mono-caps-faint">Note</span>
      <textarea
        class="desc-input"
        rows="3"
        placeholder="Details (optional)"
        bind:value={description}
      ></textarea>
    </label>

    <label class="field">
      <span class="mono-caps-faint">When</span>
      <input
        class="dt-input"
        type="datetime-local"
        bind:value={dueLocal}
      />
    </label>

    <div class="field">
      <span class="mono-caps-faint">Tags</span>
      <div class="tags-input">
        {#each tags as t (t)}
          <span class="tag-chip">
            <span class="tag-text">{t}</span>
            <button
              class="tag-remove"
              type="button"
              onclick={() => removeTag(t)}
              aria-label="Remove tag {t}"
            >×</button>
          </span>
        {/each}
        <input
          class="tag-input"
          type="text"
          placeholder={tags.length === 0 ? "work, personal, urgent…" : "+ tag"}
          bind:value={tagDraft}
          onkeydown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commitTagDraft();
            } else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
              tags = tags.slice(0, -1);
            }
          }}
          onblur={commitTagDraft}
        />
      </div>
    </div>

    {#if !silent}
      <div class="field">
        <span class="mono-caps-faint">Priority</span>
        <div class="prio-row">
          {#each ["low", "normal", "high"] as p (p)}
            <button
              class="prio"
              class:active={priority === p}
              onclick={() => (priority = p as Priority)}
            >
              <SignalLight priority={p as Priority} size={11} />
              <span class="prio-label">{p}</span>
            </button>
          {/each}
        </div>
      </div>

      <label class="field">
        <span class="mono-caps-faint">Repeat</span>
        <select class="select" bind:value={repeatKind}>
          <option value="none">— Once —</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekdays (Mon–Fri)</option>
          <option value="interval">Every N seconds</option>
          <option value="monthly">Monthly</option>
        </select>
      </label>

      {#if repeatKind === "interval"}
        <label class="field">
          <span class="mono-caps-faint">Interval (seconds)</span>
          <input
            class="dt-input"
            type="number"
            min="1"
            bind:value={intervalSecs}
          />
        </label>
      {/if}
    {:else}
      <div class="task-note mono-caps-faint">
        Tasks appear in the list but do not trigger the alarm. Mark them done when you're finished.
      </div>
    {/if}
  </div>

  <footer class="actions">
    {#if reminder}
      <button
        class="btn ghost danger"
        onclick={() => reminder && onDelete(reminder.id)}
      >
        Delete
      </button>
    {/if}
    <div class="spacer"></div>
    <button class="btn ghost" onclick={onClose}>Cancel</button>
    <button class="btn primary" onclick={handleSave} disabled={!title.trim()}>
      {reminder ? "Save" : "Arm"}
    </button>
  </footer>
</aside>

<style>
  .editor {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--editor-w);
    background: var(--bg-elev);
    border-left: 1px solid var(--border-strong);
    transform: translateX(100%);
    transition: transform 240ms var(--ease);
    display: flex;
    flex-direction: column;
    z-index: 50;
    box-shadow: -16px 0 32px rgba(0, 0, 0, 0.5);
  }
  .editor.open { transform: translateX(0); }

  .edge {
    position: absolute;
    top: 0; bottom: 0; left: -1px;
    width: 2px;
    background: var(--klaxon);
    box-shadow: 0 0 14px var(--klaxon-glow-strong);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 22px 22px 14px;
    border-bottom: 1px solid var(--border);
  }
  .head-left { display: flex; align-items: center; gap: 12px; }
  .dot {
    width: 8px; height: 8px;
    background: var(--klaxon);
    box-shadow: 0 0 8px var(--klaxon-glow-strong);
    border-radius: 50%;
  }
  .head-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }
  .close {
    width: 32px; height: 32px;
    color: var(--text-muted);
    font-size: 22px;
    line-height: 1;
    transition: color 120ms var(--ease);
  }
  .close:hover { color: var(--text); }

  .form {
    flex: 1;
    overflow-y: auto;
    padding: 18px 22px 22px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .kind-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    border: 1px solid var(--border-strong);
    background: var(--bg-surface);
  }
  .kind-btn {
    padding: 10px 12px;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    cursor: pointer;
    transition: all 120ms var(--ease);
  }
  .kind-btn:hover { color: var(--text-2); }
  .kind-btn.active {
    background: var(--bg-active);
    color: var(--klaxon);
    box-shadow: inset 0 0 14px rgba(255, 157, 0, 0.08);
  }
  .kind-btn + .kind-btn { border-left: 1px solid var(--border); }

  .task-note {
    border: 1px dashed var(--border-strong);
    padding: 12px 14px;
    font-size: 10px;
    letter-spacing: 0.14em;
    color: var(--text-muted);
    line-height: 1.55;
  }

  /* Tag input */
  .tags-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    transition: border-color 120ms var(--ease);
    min-height: 38px;
  }
  .tags-input:focus-within { border-color: var(--klaxon); }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 8px;
    border: 1px solid var(--klaxon-dim);
    background: rgba(255, 157, 0, 0.08);
    color: var(--klaxon);
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
  }
  .tag-text { line-height: 1; }
  .tag-remove {
    width: 16px;
    height: 16px;
    background: transparent;
    border: none;
    color: var(--klaxon-dim);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
    transition: color 100ms var(--ease);
  }
  .tag-remove:hover { color: var(--signal-high); }
  .tag-input {
    flex: 1;
    min-width: 100px;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 4px 2px;
  }
  .tag-input:focus { outline: none; }
  .tag-input::placeholder { color: var(--text-faint); }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .title-input {
    font-size: 18px;
    color: var(--text);
    padding: 6px 0;
    border-bottom: 1px solid var(--border-strong);
    transition: border-color 120ms var(--ease);
  }
  .title-input:focus { border-bottom-color: var(--klaxon); }
  .title-input::placeholder { color: var(--text-faint); }

  .desc-input {
    color: var(--text-2);
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    resize: vertical;
    transition: border-color 120ms var(--ease);
  }
  .desc-input:focus { border-color: var(--klaxon); }

  .dt-input {
    color: var(--text);
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    transition: border-color 120ms var(--ease);
    color-scheme: dark;
  }
  .dt-input:focus { border-color: var(--klaxon); }

  .select {
    appearance: none;
    color: var(--text);
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .select:focus { border-color: var(--klaxon); }

  .prio-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .prio {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 10px 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.18em;
    color: var(--text-muted);
    transition: all 120ms var(--ease);
  }
  .prio:hover { border-color: var(--border-bright); color: var(--text-2); }
  .prio.active {
    border-color: var(--klaxon);
    color: var(--text);
    background: var(--bg-active);
    box-shadow: inset 0 0 14px rgba(255, 157, 0, 0.08);
  }
  .prio-label { font-weight: 600; }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 22px 22px;
    border-top: 1px solid var(--border);
  }
  .spacer { flex: 1; }
  .btn {
    padding: 9px 16px;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    border: 1px solid var(--border-strong);
    color: var(--text-2);
    transition: all 120ms var(--ease);
  }
  .btn:hover { color: var(--text); border-color: var(--border-bright); }
  .btn.ghost { background: transparent; }
  .btn.primary {
    background: var(--klaxon);
    color: var(--bg);
    border-color: var(--klaxon);
  }
  .btn.primary:hover {
    background: transparent;
    color: var(--klaxon);
    box-shadow: 0 0 18px var(--klaxon-glow);
  }
  .btn.primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    box-shadow: none;
  }
  .btn.danger { color: var(--signal-high); border-color: var(--signal-high); }
  .btn.danger:hover {
    background: var(--signal-high);
    color: var(--bg);
  }
</style>
