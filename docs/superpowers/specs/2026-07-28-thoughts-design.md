# Thoughts — a private, P2P idea feed — Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-07-28
**Branch:** new branch off `main`
**Author:** William Herr (with Claude)

---

## 1. Problem

Klaxon can express two kinds of item, and both of them are events in time. A
reminder rings at `due_at`. A task is a `silent = 1` reminder that doesn't ring
but still carries a date and a swim lane. Every row in the `reminders` table has
a `NOT NULL due_at` (`db/migrations.rs:13`).

A thought — an idea, a link, a half-formed sentence worth keeping — has no time
at all. There is nowhere to put one. In practice the user has been filing them as
reminders, which means real reminders and inert notes share a list, and the
scheduler has to be told to ignore things that were never events.

The commercial product that does this well (MindChuk, "the private feed for your
brain") is built on two halves: an SMS on-ramp for capture, and a permanent
tagged, searchable stream. Klaxon needs only the second half — it already has an
app, a global hotkey, and QuickAdd — and it can offer the stream without the two
things that make the commercial version unattractive: a subscription and a
central database. Klaxon's existing iroh P2P sync already moves data between
devices with no server in the middle.

There is also no search anywhere in Klaxon today. "Searchable forever" is most of
the value of an archive, so search is in scope here rather than deferred.

## 2. Goal & non-goals

### Goal

A fifth view in Klaxon holding a permanent, reverse-chronological feed of
free-text thoughts: captured in one keystroke from desktop or Android, tagged
with the same tag vocabulary as the rest of the app, full-text searchable, and
synced peer-to-peer between paired devices over the existing transport.

### Non-goals

- **Global search across reminders and tasks.** Search is scoped to the thought
  feed. A unified index over three entity types is a larger feature wearing this
  one's clothes; reminders are found by browsing a list of twenty.
- **Attachments — images, files.** Text only. Attachments mean a blob store,
  thumbnails, and multi-megabyte sync payloads against a 16 MiB frame cap
  (`sync/proto.rs:58`).
- **Auto-tagging.** Tags are typed by the user. Local heuristic tagging was
  considered and rejected: guessed tags have to be corrected, and correcting is
  worse than typing.
- **Android quick-capture notification or widget.** The share-target covers the
  mobile case. A persistent notification has the same always-there quality the
  user rejected for the sync foreground service.
- **A QuickAdd fallback** where un-parseable text becomes a thought. A mis-parse
  would silently file a real reminder as an inert note.
- **Resurfacing.** No "show me a random old thought." The feed is pull, not push.

## 3. Approach selection (recorded for context)

| Approach | Verdict |
| --- | --- |
| **Own `thoughts` table + own sync entity** — *chosen* | Clean separation; the scheduler cannot ring a thought because thoughts aren't in `reminders`. Only option that gets a well-formed FTS5 index, since a thought is exactly one text column. Cost: a new table, a new sync entity, and a shallow duplicate of the reminder CRUD. |
| **Third mode on `reminders`** (`due_at` nullable) | Rejected. Nullable `due_at` is a full table rebuild in SQLite, and every query plus the scheduler must learn to exclude thoughts. The blocker is the wire format: `RemoteReminder.due_at` is `i64`, not `Option<i64>` (`sync/types.rs:22`), so a v0.4.0 peer decodes a thought's missing date as `0` and gets an item that tries to ring at the Unix epoch. Silent corruption on un-upgraded devices. |
| **A "Thoughts" lane on the Tasks board** | Rejected. Zero schema change, but it is what the user already does by hand, with no search, no feed, and thoughts permanently tangled with tasks. |

## 4. Data model — migration 009

```sql
CREATE TABLE thoughts (
    id          TEXT PRIMARY KEY,
    body        TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    dirty       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_thoughts_created ON thoughts(created_at DESC);
CREATE INDEX idx_thoughts_dirty   ON thoughts(updated_at) WHERE dirty = 1;

CREATE VIRTUAL TABLE thoughts_fts USING fts5(
    body, tags, content='thoughts', content_rowid='rowid'
);
-- plus AFTER INSERT / AFTER UPDATE / AFTER DELETE triggers on `thoughts`
-- maintaining the external-content index.
```

No `due_at`, no `state`, no `priority`, no lane. A thought has no time and no
lifecycle — that absence is the type.

**FTS5 availability is confirmed, not assumed.** `rusqlite` is pinned with the
`bundled` feature (`src-tauri/Cargo.toml:23`), and `libsqlite3-sys`'s build script
compiles the vendored amalgamation with `-DSQLITE_ENABLE_FTS5` (`build.rs:129`).
No new dependency and no feature flag change.

**Tags** are byte-identical in format to reminder tags: a JSON array of lowercase
strings, normalized through the existing `normalize_tags()` (`models.rs:150`). One
tag vocabulary app-wide, so `#idea` means the same thing on a thought and on a
task. Tags are indexed in FTS alongside the body, so searching `recipe` matches a
thought whose body says "recipe" and one merely tagged `#recipe`.

**Deletes** write to the existing `tombstones` table, already shared between
reminders and lanes. Thoughts are its third tenant, not a new mechanism.

**On the `dirty` column.** It is carried for symmetry with the sibling tables and
set honestly on write, but no query filters on it. Push selects on the per-peer
high-water mark (`updated_at > last_push_at`), exactly as reminders do
(`db/reminders.rs:243`). This is deliberate: `task_lanes::dirty_since` and
`tombstones::dirty_since` additionally require `dirty = 1`, while rows received
from a peer are stored with `dirty = 0` (`db/reminders.rs:309`), so a lane learned
from one peer is never forwarded to a second peer. Thoughts do not inherit that
bug. Filed as [#1](https://github.com/willherr72/Klaxon/issues/1); keeping the
column means all three entity types can be fixed in one change later.

## 5. Capture

**In-app.** A compose box pinned to the top of the feed. `Enter` saves, the box
clears and holds focus so several thoughts can be dumped in a row without
touching the mouse; `Shift+Enter` inserts a newline. Inline `#tags` are parsed out
of the body at save time and stored in the `tags` column, while the `#tag` text
remains in the body — nothing the user typed is silently rewritten.

**Desktop global hotkey.** A second registration alongside the existing
new-reminder shortcut, configurable in Settings beside it. It opens a small
frameless always-on-top window containing only the compose box — no feed, no
chrome. `Enter` saves and closes, `Esc` discards. The main window is never
touched, so capture doesn't pull the user out of what they were doing. Built on
the existing alert-window machinery rather than a new window type.

**Android share-target.** An `ACTION_SEND` / `text/plain` intent filter puts Klaxon
in the system share sheet. Shared text becomes a thought; when a share carries
both a subject and a URL (what browsers send), both go into the body. **The save
is silent and in the background** — a toast confirms, and the user stays in the
app they shared from. A share can arrive with the app cold, so the intent is
handled in `MainActivity` and forwarded over JNI, following the path the calendar
branch already established for its OAuth redirect.

## 6. Feed and search

**Navigation.** `ViewMode` gains a fifth member: `"reminders" | "tasks" |
"calendar" | "completed" | "thoughts"`, with a count badge alongside the others
(`App.svelte:351`).

**The feed.** Reverse-chronological, newest first. Each entry shows a relative
timestamp, the body with the first line weighted and the remainder as preview,
tag chips reusing the existing chip styling (`ReminderItem.svelte:71`), and hover
actions: edit, make task, make reminder, delete. Clicking expands a truncated
thought in place. Editing is inline, not a modal — a modal for a single text field
is ceremony.

The feed pages at 50 entries with more on scroll. Thoughts accumulate forever by
design, and this is far cheaper to build now than to retrofit at five thousand
rows.

**Search.** A field at the top of the feed querying `thoughts_fts`, debounced,
with a trailing `*` on the final token so results narrow as the user types. FTS5's
`snippet()` supplies the matched excerpt and highlighting. An empty query yields
the plain chronological feed.

**Tag browse.** A collapsible tag list in the sidebar under Thoughts, each tag
with a count, click to filter, scoped to thoughts. This is new UI: tags render as
chips and are editable in the editor today, but nothing in the app currently lets
the user browse or filter *by* tag. Search and tag filter compose — filter to
`#idea`, then search within it.

**Promotion.** "Make a task" and "Make a reminder" open the normal editor
pre-filled with the thought's text. The thought stays in the feed, untouched, and
no link between the two is tracked. The archive never develops holes because the
user acted on something.

## 7. Sync

```rust
pub struct RemoteThought {
    pub id: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
```

No `dirty` and no local metadata, mirroring how `RemoteReminder` omits `source`
and `external_id`. `ChangeSet` gains `thoughts: Vec<RemoteThought>` as its last
field, and `PushResponse` gains `accepted_thoughts`. Conflict resolution is
last-write-wins on `updated_at`, consistent with every other entity.

Deletes ride the shared tombstone path, which requires two additions:
`tombstones::apply_remote` needs a `DELETE FROM thoughts` beside its existing
reminders delete, and `sync/ops.rs:111` needs a `thoughts::delete` call beside the
existing `task_lanes::delete`.

### Accepted risk: cross-version sync breaks

`postcard` is non-self-describing — fields are read sequentially with no names and
no presence flags — so `#[serde(default)]` has nothing to trigger on. Appending a
field is therefore asymmetric:

- **New peer → old peer works.** `postcard::from_bytes` (`postcard-1.1.3
  src/de/mod.rs:12`) deserializes `T` and returns without checking for trailing
  bytes, so an old peer reads the fields it knows and ignores the rest.
- **Old peer → new peer fails.** The new peer finishes `lanes`, reaches for
  `thoughts`, and hits end of buffer: `DeserializeUnexpectedEnd`. The **entire
  ChangeSet** fails to decode, not merely the thoughts portion. All sync between
  those two devices stops.

This makes the existing comment at `sync/types.rs:53` — *"`#[serde(default)]` keeps
the wire format compatible with v0.3.0 peers"* — true in only one direction. The
same latent break already exists for `lanes`; it has gone unnoticed because all
devices are upgraded together.

**Decision: accept it.** A prefix-decode fallback and an ALPN bump were both
considered and declined. The user controls every paired device and upgrades them
together, so the straddle window is small. The single mitigation is a targeted
log line: on ChangeSet decode failure, log that the peer is likely running an
older Klaxon, so the cause is legible instead of appearing as a raw postcard
error.

## 8. Error handling

**Search input is the one real injection surface.** User text lands in a `MATCH`
clause, where FTS5 treats `"`, `*`, `-`, `AND`, `OR` and `NEAR` as syntax — so
`can't` or `foo-bar` would either error or quietly mean something unintended. The
query builder tokenizes on whitespace, wraps each token in double quotes with
embedded quotes doubled, and appends `*` to the final token for prefix matching.
All input becomes literal; nothing typed can be an operator or a syntax error.

**Index drift cannot occur**, because the FTS triggers live on the table. Writes
applied by sync pass through them exactly as local edits do.

**Body cap.** A browser share can carry an entire article, and the whole ChangeSet
is held in memory under the 16 MiB frame cap (`sync/proto.rs:58`). Bodies are
capped at 64 KiB with a visible truncation notice — generous for a thought, far
below the frame limit even in bulk.

**Whitespace-only saves** are a silent no-op. **Hotkey registration failure**
surfaces in Settings, where the existing shortcut already reports its state.

## 9. Testing

Rust unit tests following the existing `#[cfg(test)]` convention:

- CRUD roundtrip; tag normalization applied at save.
- Search matches by body and by tag.
- Index correct after an edit and after a delete.
- Tombstone delete removes the row from both `thoughts` and the FTS index.
- `apply_remote` resolves last-write-wins by `updated_at`.
- `ChangeSet` postcard roundtrip including the new field.
- A table of adversarial search inputs — `can't`, `foo-bar`, `a OR b`, a bare `"`,
  an empty string — each asserted to be treated as literal text.

Frontend holds `svelte-check` at zero errors. The share-target and the global
hotkey require manual verification on real hardware.

## 10. Sequencing

Built on `main`, taking migration **009**.

The calendar integration work is 33 commits on `roost/01a1ae1f`, code-complete but
unmerged and never exercised end-to-end against a live provider, and it claims
migrations 009–011. It is blocked on the user obtaining real Google/Azure OAuth
apps and Android hardware for E2E, so it may sit unmerged for some time and should
not block a feature with no such dependency. When calendar rebases, its three
migrations renumber to 010–012 — a mechanical edit to three headers.

Suggested delivery slices, each independently shippable:

- **M1 — the feature proper.** Migration 009, thought CRUD, FTS index and the
  query builder, the feed view, search, sidebar tag browse, promotion to
  task/reminder, and sync. This is the whole value; everything after it is a
  capture shortcut.
- **M2 — desktop global hotkey** and its capture window.
- **M3 — Android share-target**, including the cold-start JNI path.

M2 and M3 are independent of each other and both depend only on M1.

**Hazard to handle at rebase time:** a development machine that has already *run*
the calendar branch has `schema_version = 11`. Adding a differently-numbered 009
on `main` means migrations 009–011 are skipped on that database, because the
runner takes `MAX(version)` and skips anything at or below it
(`db/migrations.rs:152`). Any dev database that has run `roost/01a1ae1f` must be
reset, or hand-repaired, before running `main` with this feature.

## 11. Follow-ups (not in scope)

- Fix `dirty`-gated forwarding across all three entity types —
  [#1](https://github.com/willherr72/Klaxon/issues/1).
- Prefix-decode fallback for cross-version ChangeSets, if straddling versions ever
  becomes real.
- Global search spanning reminders, tasks, and thoughts.
