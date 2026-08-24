# Calendar: Day Detail and Day Notes (v0.10.0)

**Date:** 2026-08-23
**Status:** Approved design, pre-implementation
**Target release:** v0.10.0 (wire-format break — both devices must update together)

## Context

Two complaints, one underlying cause: the month grid is the only way to see
a day, and a grid cell is too small to be one.

1. A busy day renders four items and then `+N more`
   (`CalendarView.svelte:205`), which names a quantity and hides the
   content. There is no way to see what the other items are.
2. On a phone the seven-column grid gives each day roughly 45px.
   `CalendarView.svelte` has **no media queries at all**, so it renders the
   desktop layout squeezed — item titles are unreadable and days are hard
   to tell apart.

Separately, there is nowhere to record what actually happened on a day.
Reminders are prospective; nothing in Klaxon is retrospective.

## Goals

- Open any day and see everything that touched it.
- Make the month scannable on a phone.
- Keep a free-text note per day.

## Non-goals

- Calendar-provider integration. That work is shelved on
  `roost/01a1ae1f` and is a different feature; this is native and offline.
- Multiple notes per day, note history, or formatting. One editable body.
- Deleting note rows (see "Emptying a note" below).
- Week or day *views*. The month grid remains the only calendar layout.

## Data model

**Migration 015** — `day_notes`:

```sql
CREATE TABLE day_notes (
    day         TEXT PRIMARY KEY,   -- local calendar date, 'YYYY-MM-DD'
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
```

**The date is the primary key.** That is what makes concurrent edits
converge: both devices editing the same day resolve by last-write-wins on
`updated_at`, exactly as reminders do by id. A surrogate id would let each
device create its own row for the same day and produce duplicates that
never merge.

**Local date, not UTC.** "What happened on the 23rd" is a local-calendar
question, and the grid already buckets by local date. Both devices share a
timezone; a device that changed timezones would attribute a note to the
date it was written under, which is the intuitive reading.

**The frontend owns the conversion.** Commands take `day` as an already
formatted `'YYYY-MM-DD'` string; the backend never derives a date from a
timestamp. Only the frontend knows the user's local calendar, and the grid
is already built from local `Date` objects — deriving the day in Rust would
introduce a second, disagreeing notion of which day a moment belongs to. A
single helper (`localDayKey(d: Date): string`) is the only place that
formats it.

**Emptying a note writes an empty body; it does not delete the row.**
Deletion would mean teaching the tombstone cascade
(`sync/ops.rs`) a third entity type and inventing a tombstone id scheme for
a non-UUID key. A few empty rows cost nothing. The UI treats `body.trim()
== ""` as "no note", so nothing user-visible depends on the row's absence.

**Migration numbering:** this claims 015. The shelved calendar-integrations
branch, already needing renumbering past 013, now needs 016+.

## Sync

`RemoteDayNote { day, body, created_at, updated_at }`, appended as a
**trailing** field on `ChangeSet`, merged through the same last-write-wins
path as every other table (`day_notes::apply_remote`, skipping when the
local row's `updated_at` is at least as recent).

This is a **wire-format break**. postcard is not self-describing, so a
0.10 peer decoding a 0.9 changeset runs out of buffer and fails the frame —
the failure mode documented on `ChangeSet.thoughts`. Both devices update
together, as with v0.8.0. Sync stalls rather than corrupting: `sync/task.rs`
pulls before pushing and propagates the decode error before any watermark
advances.

## Backend commands

- `set_day_note(day: String, body: String) -> DayNote` — upsert. Emits a
  new `klaxon://day-notes-changed` event, following the
  `thoughts-changed` precedent, so a note arriving by sync refreshes an
  open panel. Calls `nudge_write` so it pushes promptly.
- `get_day_note(day: String) -> Option<DayNote>` — for the panel.
- `day_summaries(from_ms: i64, to_ms: i64) -> Vec<DaySummary>` where
  `DaySummary { day: String, thought_count: usize, has_note: bool }` — one
  query per visible month, feeding the grid's markers. Reminder density is
  computed in the frontend from props it already holds, so this does not
  need to carry it.
- `thoughts_between(from_ms: i64, to_ms: i64) -> Vec<Thought>` — the
  panel's thoughts list. `list_thoughts` filters by tag, not date.

## UI

### DayPanel.svelte (new)

Mirrors `ReminderEditor`'s panel: fixed to the right at `var(--editor-w)`
on desktop with the month still visible, full-screen under the existing
`max-width: 1024px` breakpoint. Clicking a different day swaps its
contents rather than closing and reopening.

Sections, in order:

1. **Note** — a textarea, placeholder "What happened?".
2. **Reminders and tasks** — every item whose effective due time falls in
   that local day, *including* fired, dismissed and completed ones, with
   finished items visually distinguished from pending. Each opens the
   reminder editor on click.
3. **Thoughts** — thoughts captured that day, read-only.
4. **Add** — create a reminder or task on this date, reusing the
   `onCreateForDate` callback the right-click menu already uses.

**Autosave:** debounced 1000ms after the last keystroke, and **flushed on
panel close, on switching to another day, and on component destroy**. An
unflushed debounce silently discards the thing it exists to protect — the
same defect pattern as the reconcile timer in `App.svelte`. Switching days
matters as much as closing: the panel swaps contents in place, so an
unflushed note would be overwritten by the next day's body. No Save button.

### CalendarView.svelte (modified)

- Cells become buttons: click and keyboard both open the panel. The
  existing right-click context menu is preserved unchanged.
- The selected day is visually marked while the panel is open.
- Desktop keeps four items plus `+N more`; `+N more` becomes clickable.
- **Mobile (`max-width: 1024px`), this component's first media query:**
  item titles are dropped. Each cell shows its day number plus markers —
  **up to 3 dots** for reminders and tasks, with unfinished distinguished
  from finished, a marker when the day has a note, and another when
  thoughts were captured. A day with more than 3 items still shows 3 dots
  and no overflow text — the count is what the panel is for, and a "+N"
  at this size would reproduce the problem this feature exists to fix.

## Testing

**Rust**
- Migration 015 creates the table with `day` as primary key.
- Upsert replaces rather than duplicating for the same day; `get` returns
  the current body; range query bounds are inclusive of both ends.
- `apply_remote` honours last-write-wins and skips a stale incoming note.
- The three-device mesh test forwards a day note A→B→C unchanged.

**Frontend (Vitest)**
- Typing fires exactly one `set_day_note` after the debounce, not one per
  keystroke.
- Closing the panel with pending text flushes the save.
- A body of only whitespace reads as "no note".
- Clicking a cell opens the panel for that date; clicking another swaps it.
- A day's finished and unfinished items are both listed and distinguished.

**Hardware drill (Fold)**
- Density markers legible and days distinguishable at phone width.
- Panel is full-screen and dismissible.
- A note written on one device appears on the other after a sync.

## Release

v0.10.0. Changelog leads with the update-both-devices warning, in the same
plain voice as the 0.8.0 entry. Asset-name contract unchanged
(`Klaxon_0.10.0_x64-setup.exe`, `klaxon-0.10.0-arm64.apk`).
