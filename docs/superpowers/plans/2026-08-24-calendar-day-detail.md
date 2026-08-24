# Calendar Day Detail + Day Notes (v0.10.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click any day in the calendar to see everything that touched it, keep a free-text note per day, and make the month readable on a phone.

**Architecture:** A new `day_notes` table keyed by the local date string (`'YYYY-MM-DD'`), synced by the same last-write-wins path as every other table. A new `DayPanel.svelte` mirrors `ReminderEditor`'s side-panel behaviour. `CalendarView` gains clickable cells and its first mobile media query.

**Tech Stack:** Rust (rusqlite, Tauri v2 commands, postcard sync), Svelte 5 (runes), Vitest + @testing-library/svelte.

**Spec:** `docs/superpowers/specs/2026-08-23-calendar-day-detail-design.md`

## Global Constraints

- The `day` key is a **local** calendar date formatted `'YYYY-MM-DD'`. The **frontend owns the conversion** — commands take an already-formatted string and the backend NEVER derives a date from a timestamp. One helper, `localDayKey(d: Date): string`, is the only place that formats it.
- **Emptying a note stores an empty body; it never deletes the row.** No tombstones for day notes. The UI treats `body.trim() === ""` as "no note".
- This is a **postcard wire-format break** (`ChangeSet` gains a trailing field): a 0.10 peer cannot decode a 0.9 changeset. Version bumps to 0.10.0 in the final task only.
- Autosave debounce is **1000ms**, flushed on panel close, on switching to another day, and on component destroy.
- Mobile cells show **up to 3 dots**, no overflow text.
- Run cargo commands from `src-tauri/`; npm commands from the repo root.
- Gates before each commit: `cargo test`, `RUSTFLAGS="-D warnings" cargo build` (from `src-tauri/`), `npm test`, `npm run check` (0 errors 0 warnings).
- End commit messages with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration 015 — the `day_notes` table

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append to `MIGRATIONS`, add test)

**Interfaces:**
- Produces: a `day_notes` table with `day` TEXT PRIMARY KEY, `body` TEXT NOT NULL, `created_at`/`updated_at` INTEGER NOT NULL.

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src-tauri/src/db/migrations.rs`:

```rust
    /// Migration 015: one note per day, keyed by the local date string.
    /// The primary key is what makes concurrent edits converge — a
    /// surrogate id would let each device create its own row for the same
    /// day and never merge them.
    #[test]
    fn migration_015_day_notes_is_keyed_by_day() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO day_notes (day, body, created_at, updated_at)
             VALUES ('2026-08-23', 'shipped v0.9.0', 1, 1)",
            [],
        )
        .unwrap();

        // Same day again must collide, not duplicate.
        let duplicate = conn.execute(
            "INSERT INTO day_notes (day, body, created_at, updated_at)
             VALUES ('2026-08-23', 'second note', 2, 2)",
            [],
        );
        assert!(duplicate.is_err(), "day must be unique");

        // An upsert is how a second write is meant to land.
        conn.execute(
            "INSERT INTO day_notes (day, body, created_at, updated_at)
             VALUES ('2026-08-23', 'edited', 1, 5)
             ON CONFLICT(day) DO UPDATE SET body = excluded.body,
                                           updated_at = excluded.updated_at",
            [],
        )
        .unwrap();

        let (body, updated): (String, i64) = conn
            .query_row(
                "SELECT body, updated_at FROM day_notes WHERE day = '2026-08-23'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(body, "edited");
        assert_eq!(updated, 5);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM day_notes", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "still exactly one row for that day");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run (in `src-tauri/`): `cargo test migration_015 -- --nocapture`
Expected: FAIL — `no such table: day_notes`

- [ ] **Step 3: Append migration 015**

After the 014 entry in the `MIGRATIONS` const:

```rust
    // 015 — v0.10: a free-text note per calendar day.
    //
    // `day` is the LOCAL date as 'YYYY-MM-DD' and is the primary key on
    // purpose: two devices editing the same day converge by last-write-wins
    // on updated_at, exactly as reminders do by id. A surrogate id would let
    // each device create its own row for one day and never merge them.
    //
    // Clearing a note writes an empty body rather than deleting the row, so
    // day notes never need tombstones.
    r#"
    CREATE TABLE day_notes (
        day         TEXT PRIMARY KEY,
        body        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );

    CREATE INDEX idx_day_notes_updated ON day_notes(updated_at);
    "#,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test migration_015 -- --nocapture`
Expected: PASS. Then `cargo test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db/migrations.rs
git commit -m "feat(db): migration 015 — day_notes keyed by local date

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `db::day_notes` repository

**Files:**
- Create: `src-tauri/src/db/day_notes.rs`
- Modify: `src-tauri/src/db/mod.rs` (add `pub mod day_notes;`)
- Modify: `src-tauri/src/models.rs` (add the `DayNote` struct)

**Interfaces:**
- Consumes: migration 015's table.
- Produces:
  - `models::DayNote { day: String, body: String, created_at: i64, updated_at: i64 }` (Serialize + Deserialize + Clone + Debug)
  - `day_notes::set(conn, day: &str, body: &str) -> AppResult<DayNote>`
  - `day_notes::get(conn, day: &str) -> AppResult<Option<DayNote>>`
  - `day_notes::between(conn, from: &str, to: &str) -> AppResult<Vec<DayNote>>` (inclusive both ends)
  - `day_notes::days_with_notes(conn, from: &str, to: &str) -> AppResult<Vec<String>>` (content-bearing notes only)
  - `day_notes::updated_since(conn, since: i64) -> AppResult<Vec<DayNote>>`
  - `day_notes::apply_remote(conn, n: &RemoteDayNote) -> AppResult<bool>` (added in Task 3)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/db/day_notes.rs` with only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::{between, get, set};

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn setting_a_note_twice_edits_it_rather_than_duplicating() {
        let conn = test_conn();
        let first = set(&conn, "2026-08-23", "shipped v0.9.0").unwrap();
        assert_eq!(first.body, "shipped v0.9.0");

        let second = set(&conn, "2026-08-23", "shipped v0.9.0 and drilled it").unwrap();
        assert_eq!(second.body, "shipped v0.9.0 and drilled it");
        assert_eq!(second.created_at, first.created_at, "created_at is preserved");
        assert!(second.updated_at >= first.updated_at, "updated_at advances");

        assert_eq!(between(&conn, "2026-01-01", "2026-12-31").unwrap().len(), 1);
    }

    #[test]
    fn getting_a_day_with_no_note_is_none_not_an_error() {
        let conn = test_conn();
        assert!(get(&conn, "2026-08-23").unwrap().is_none());
    }

    /// Clearing a note stores an empty body. The row survives on purpose —
    /// day notes have no tombstones, so a delete could never propagate.
    #[test]
    fn clearing_a_note_stores_an_empty_body_and_keeps_the_row() {
        let conn = test_conn();
        set(&conn, "2026-08-23", "something").unwrap();
        set(&conn, "2026-08-23", "").unwrap();

        let note = get(&conn, "2026-08-23").unwrap().expect("row still exists");
        assert_eq!(note.body, "");
    }

    /// A cleared note leaves a row behind by design, so the calendar's
    /// marker must not treat that row as a note — otherwise every day you
    /// ever typed in stays marked forever.
    #[test]
    fn a_whitespace_only_note_is_not_a_note() {
        let conn = test_conn();
        set(&conn, "2026-08-23", "real note").unwrap();
        set(&conn, "2026-08-24", "   \n  ").unwrap();
        set(&conn, "2026-08-25", "").unwrap();

        let marked = super::days_with_notes(&conn, "2026-08-01", "2026-08-31").unwrap();
        assert_eq!(marked, vec!["2026-08-23"]);
    }

    #[test]
    fn between_is_inclusive_of_both_ends() {
        let conn = test_conn();
        for day in ["2026-08-01", "2026-08-15", "2026-08-31", "2026-09-01"] {
            set(&conn, day, "x").unwrap();
        }
        let got: Vec<String> = between(&conn, "2026-08-01", "2026-08-31")
            .unwrap()
            .into_iter()
            .map(|n| n.day)
            .collect();
        assert_eq!(got, vec!["2026-08-01", "2026-08-15", "2026-08-31"]);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib db::day_notes`
Expected: FAIL to compile — module not declared, `set`/`get`/`between` not defined.

- [ ] **Step 3: Add the model**

In `src-tauri/src/models.rs`, after the `Thought` struct:

```rust
/// A free-text note about one calendar day.
///
/// `day` is the LOCAL date as 'YYYY-MM-DD' and is the primary key — see
/// migration 015. An empty `body` means "no note"; the row is kept so day
/// notes never need tombstones.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayNote {
    pub day: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}
```

- [ ] **Step 4: Write the repository**

Prepend to `src-tauri/src/db/day_notes.rs` (above the test module):

```rust
//! Storage for per-day notes.
//!
//! Keyed by the local calendar date, which is what makes two devices
//! editing the same day converge instead of duplicating. Sync semantics
//! match every other table: `updated_at` is the LWW clock. Unlike
//! reminders and thoughts there are no deletes — clearing a note writes an
//! empty body — so this module never touches `tombstones`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::AppResult;
use crate::models::{now_ms, truncate_body, DayNote};

const COLUMNS: &str = "day, body, created_at, updated_at";

fn row_to_note(row: &Row<'_>) -> rusqlite::Result<DayNote> {
    Ok(DayNote {
        day: row.get("day")?,
        body: row.get("body")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Upsert the note for `day`. `created_at` survives an edit; `updated_at`
/// always advances, since it is the sync clock.
pub fn set(conn: &Connection, day: &str, body: &str) -> AppResult<DayNote> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO day_notes (day, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(day) DO UPDATE SET
            body = excluded.body,
            updated_at = excluded.updated_at",
        params![day, truncate_body(body), now],
    )?;
    get(conn, day)?.ok_or_else(|| {
        crate::error::AppError::Invalid(format!("day note {day} vanished after write"))
    })
}

pub fn get(conn: &Connection, day: &str) -> AppResult<Option<DayNote>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM day_notes WHERE day = ?1"))?;
    Ok(stmt.query_row(params![day], row_to_note).optional()?)
}

/// Notes between two day keys, inclusive of both ends. Lexical comparison
/// is chronological for 'YYYY-MM-DD'.
pub fn between(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<DayNote>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM day_notes
          WHERE day >= ?1 AND day <= ?2
          ORDER BY day ASC"
    ))?;
    let rows = stmt.query_map(params![from, to], row_to_note)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Days in the range that carry a note worth marking on the calendar.
///
/// A note whose body is only whitespace is not a note: clearing one stores
/// an empty body rather than deleting the row, so the marker has to filter
/// on content or every day you ever typed in would stay marked forever.
pub fn days_with_notes(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<String>> {
    Ok(between(conn, from, to)?
        .into_iter()
        .filter(|n| !n.body.trim().is_empty())
        .map(|n| n.day)
        .collect())
}

/// Rows to push to a peer, by the per-peer high-water mark.
pub fn updated_since(conn: &Connection, since: i64) -> AppResult<Vec<DayNote>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM day_notes
          WHERE updated_at > ?1
          ORDER BY updated_at ASC"
    ))?;
    let rows = stmt.query_map(params![since], row_to_note)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

Then in `src-tauri/src/db/mod.rs`, add alongside the other module declarations:

```rust
pub mod day_notes;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test` and `RUSTFLAGS="-D warnings" cargo build`
Expected: both green, including the four new tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/day_notes.rs src-tauri/src/db/mod.rs src-tauri/src/models.rs
git commit -m "feat(db): day_notes repository — upsert, get, range, watermark

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Sync day notes

**Files:**
- Modify: `src-tauri/src/sync/types.rs` (add `RemoteDayNote`, `ChangeSet` field, `From` impl, `PushResponse` counter)
- Modify: `src-tauri/src/db/day_notes.rs` (add `apply_remote` + tests)
- Modify: `src-tauri/src/sync/ops.rs` (pull, push, and the mesh test)

**Interfaces:**
- Consumes: `day_notes::{updated_since, get, set}` from Task 2.
- Produces: `RemoteDayNote { day, body, created_at, updated_at }`; `ChangeSet.day_notes: Vec<RemoteDayNote>`; `PushResponse.accepted_day_notes: usize`; `day_notes::apply_remote(conn, &RemoteDayNote) -> AppResult<bool>`.

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `src-tauri/src/db/day_notes.rs`:

```rust
    use crate::sync::types::RemoteDayNote;

    fn remote(day: &str, body: &str, updated_at: i64) -> RemoteDayNote {
        RemoteDayNote {
            day: day.to_string(),
            body: body.to_string(),
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn a_newer_incoming_note_wins() {
        let conn = test_conn();
        let local = set(&conn, "2026-08-23", "mine").unwrap();

        assert!(super::apply_remote(&conn, &remote("2026-08-23", "theirs", local.updated_at + 1)).unwrap());
        assert_eq!(get(&conn, "2026-08-23").unwrap().unwrap().body, "theirs");
    }

    #[test]
    fn a_stale_incoming_note_is_ignored() {
        let conn = test_conn();
        let local = set(&conn, "2026-08-23", "mine").unwrap();

        assert!(!super::apply_remote(&conn, &remote("2026-08-23", "theirs", local.updated_at - 1)).unwrap());
        assert_eq!(get(&conn, "2026-08-23").unwrap().unwrap().body, "mine");
    }

    /// An incoming CLEARED note must land like any other edit — otherwise
    /// clearing a note on the phone would never reach the desktop.
    #[test]
    fn an_incoming_cleared_note_applies() {
        let conn = test_conn();
        let local = set(&conn, "2026-08-23", "mine").unwrap();

        assert!(super::apply_remote(&conn, &remote("2026-08-23", "", local.updated_at + 1)).unwrap());
        assert_eq!(get(&conn, "2026-08-23").unwrap().unwrap().body, "");
    }

    #[test]
    fn an_unseen_day_is_inserted() {
        let conn = test_conn();
        assert!(super::apply_remote(&conn, &remote("2026-08-23", "theirs", 42)).unwrap());
        assert_eq!(get(&conn, "2026-08-23").unwrap().unwrap().body, "theirs");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib db::day_notes`
Expected: FAIL to compile — `RemoteDayNote` and `apply_remote` not defined.

- [ ] **Step 3: Add the wire type**

In `src-tauri/src/sync/types.rs`, after `RemoteThought`:

```rust
/// A day note on the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteDayNote {
    pub day: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}
```

Add the trailing field to `ChangeSet`, after `thoughts`:

```rust
    /// v0.10: per-day notes. Appended last, for the same reason `thoughts`
    /// was: an older peer decoding this ChangeSet reads the fields it knows
    /// and ignores the trailing bytes. The reverse does NOT hold — a 0.10
    /// peer decoding a 0.9 ChangeSet runs out of buffer and fails the whole
    /// frame. Upgrade paired devices together.
    #[serde(default)]
    pub day_notes: Vec<RemoteDayNote>,
```

Add the counter to `PushResponse`, after `accepted_thoughts`:

```rust
    #[serde(default)]
    pub accepted_day_notes: usize,
```

And the conversion, next to the other `From` impls:

```rust
impl From<&crate::models::DayNote> for RemoteDayNote {
    fn from(n: &crate::models::DayNote) -> Self {
        Self {
            day: n.day.clone(),
            body: n.body.clone(),
            created_at: n.created_at,
            updated_at: n.updated_at,
        }
    }
}
```

- [ ] **Step 4: Add `apply_remote`**

In `src-tauri/src/db/day_notes.rs`, after `updated_since`:

```rust
/// Apply a day note that arrived over sync. Last-write-wins by
/// `updated_at`; equal-or-older incoming rows are ignored. An incoming
/// empty body is a real edit (a cleared note), not a no-op.
pub fn apply_remote(conn: &Connection, n: &crate::sync::types::RemoteDayNote) -> AppResult<bool> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM day_notes WHERE day = ?1",
            params![n.day],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        if n.updated_at <= existing {
            return Ok(false);
        }
    }

    conn.execute(
        "INSERT INTO day_notes (day, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(day) DO UPDATE SET
            body = excluded.body,
            updated_at = excluded.updated_at",
        params![n.day, truncate_body(&n.body), n.created_at, n.updated_at],
    )?;
    Ok(true)
}
```

- [ ] **Step 5: Wire into pull and push**

In `src-tauri/src/sync/ops.rs`, add to the `pull` function's `ChangeSet`
construction — after the `thoughts` binding:

```rust
    let day_notes = day_notes::updated_since(&conn, since)?
        .iter()
        .map(RemoteDayNote::from)
        .collect();
```

and add `day_notes,` to the `ChangeSet { .. }` literal.

In `push`, add a counter `let mut accepted_day_notes = 0usize;` beside the
others, this loop after the thoughts loop:

```rust
        for n in &set.day_notes {
            match day_notes::apply_remote(&conn, n) {
                Ok(true) => accepted_day_notes += 1,
                Ok(false) => {}
                Err(e) => log::warn!("apply remote day note {}: {e}", n.day),
            }
        }
```

add `accepted_day_notes` to the `PushResponse { .. }` literal, and include
it in the condition that decides whether to emit `reminders-changed`:

```rust
        if accepted_reminders > 0
            || accepted_tombstones > 0
            || accepted_lanes > 0
            || accepted_thoughts > 0
            || accepted_day_notes > 0
```

Update the imports at the top of `ops.rs`: add `day_notes` to the
`crate::db::{...}` list and `RemoteDayNote` to the
`crate::sync::types::{...}` list. Add the same loop to the test-only
`apply_set` helper so the mesh test exercises it:

```rust
        for n in &set.day_notes {
            day_notes::apply_remote(&conn, n).unwrap();
        }
```

- [ ] **Step 6: Extend the mesh test**

In `changes_forward_across_three_devices_via_watermarks`, inside the
"Local writes on A" block, add:

```rust
            crate::db::day_notes::set(&conn, "2026-08-23", "a note that travels").unwrap();
```

and in the final C-side assertions:

```rust
            assert_eq!(
                crate::db::day_notes::get(&conn, "2026-08-23")
                    .unwrap()
                    .expect("day note forwarded to C")
                    .body,
                "a note that travels"
            );
```

- [ ] **Step 7: Run the gates**

Run: `cargo test` and `RUSTFLAGS="-D warnings" cargo build`
Expected: green, including the four new `apply_remote` tests and the
extended mesh test.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sync/types.rs src-tauri/src/db/day_notes.rs src-tauri/src/sync/ops.rs
git commit -m "feat(sync): carry day notes; mesh test pins forwarding

Wire-format break: ChangeSet gains a trailing day_notes field, so a 0.10
peer cannot decode a 0.9 changeset. Release as 0.10.0 and update both
devices together.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Tauri commands + frontend API surface

**Files:**
- Modify: `src-tauri/src/commands.rs` (four commands)
- Modify: `src-tauri/src/lib.rs` (registration)
- Modify: `src-tauri/src/db/thoughts.rs` (add `between`)
- Modify: `src/lib/api.ts` (four calls + types)
- Modify: `src/lib/types.ts` (`DayNote`)

**Interfaces:**
- Consumes: `day_notes::{set, get, between}`, `thoughts::between`.
- Produces:
  - commands `set_day_note`, `get_day_note`, `day_summaries`, `thoughts_between`
  - event `klaxon://day-notes-changed`
  - `api.setDayNote(day, body) => Promise<DayNote>`
  - `api.getDayNote(day) => Promise<DayNote | null>`
  - `api.daySummaries(fromDay, toDay, fromMs, toMs) => Promise<DaySummaryPayload>`
  - `api.thoughtsBetween(fromMs, toMs) => Promise<Thought[]>`
  - `DaySummaryPayload { days_with_notes: string[]; thought_times: number[] }`
  - `day_notes::days_with_notes(conn, from, to) -> AppResult<Vec<String>>` (added in Task 2)

- [ ] **Step 1: Add `thoughts::between`**

In `src-tauri/src/db/thoughts.rs`, after `list`:

```rust
/// Thoughts captured in a half-open time range, oldest first. The calendar
/// day panel needs them by date; `list` only filters by tag.
pub fn between(conn: &Connection, from_ms: i64, to_ms: i64) -> AppResult<Vec<Thought>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM thoughts
          WHERE created_at >= ?1 AND created_at < ?2
          ORDER BY created_at ASC"
    ))?;
    let rows = stmt.query_map(params![from_ms, to_ms], row_to_thought)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}
```

- [ ] **Step 2: Add the commands**

In `src-tauri/src/commands.rs`, after the thoughts commands:

```rust
#[tauri::command]
pub fn set_day_note(
    state: State<'_, AppState>,
    app: AppHandle,
    day: String,
    body: String,
) -> AppResult<crate::models::DayNote> {
    let note = {
        let conn = state.db.lock();
        crate::db::day_notes::set(&conn, &day, &body)?
    };
    let _ = app.emit("klaxon://day-notes-changed", ());
    nudge_write(&state);
    Ok(note)
}

#[tauri::command]
pub fn get_day_note(
    state: State<'_, AppState>,
    day: String,
) -> AppResult<Option<crate::models::DayNote>> {
    let conn = state.db.lock();
    crate::db::day_notes::get(&conn, &day)
}

/// Raw material for the calendar's per-day markers.
///
/// Deliberately NOT bucketed by day here: bucketing needs the user's local
/// calendar, and the backend must never form a second opinion about which
/// day a moment falls in (see the spec's data-model section). The caller
/// buckets `thought_times` with `localDayKey`. Reminder density is computed
/// in the frontend from data it already holds, so it is absent entirely.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DaySummaryPayload {
    pub days_with_notes: Vec<String>,
    pub thought_times: Vec<i64>,
}

#[tauri::command]
pub fn day_summaries(
    state: State<'_, AppState>,
    from_day: String,
    to_day: String,
    from_ms: i64,
    to_ms: i64,
) -> AppResult<DaySummaryPayload> {
    let conn = state.db.lock();
    Ok(DaySummaryPayload {
        days_with_notes: crate::db::day_notes::days_with_notes(&conn, &from_day, &to_day)?,
        thought_times: crate::db::thoughts::between(&conn, from_ms, to_ms)?
            .into_iter()
            .map(|t| t.created_at)
            .collect(),
    })
}

#[tauri::command]
pub fn thoughts_between(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
) -> AppResult<Vec<crate::models::Thought>> {
    let conn = state.db.lock();
    crate::db::thoughts::between(&conn, from_ms, to_ms)
}
```

Register all four in `src-tauri/src/lib.rs`'s `generate_handler!` list,
next to the thoughts commands:

```rust
            commands::set_day_note,
            commands::get_day_note,
            commands::day_summaries,
            commands::thoughts_between,
```

- [ ] **Step 3: Add the frontend API**

In `src/lib/types.ts`, after the `Thought` interface:

```ts
export interface DayNote {
  day: string;
  body: string;
  created_at: number;
  updated_at: number;
}
```

In `src/lib/api.ts`, after the thoughts group:

```ts
  // Day notes + calendar day detail (v0.10)
  setDayNote: (day: string, body: string) =>
    invoke<DayNote>("set_day_note", { day, body }),
  getDayNote: (day: string) =>
    invoke<DayNote | null>("get_day_note", { day }),
  daySummaries: (fromDay: string, toDay: string, fromMs: number, toMs: number) =>
    invoke<DaySummaryPayload>("day_summaries", { fromDay, toDay, fromMs, toMs }),
  thoughtsBetween: (fromMs: number, toMs: number) =>
    invoke<Thought[]>("thoughts_between", { fromMs, toMs }),
```

and the exported type:

```ts
export interface DaySummaryPayload {
  /// Days in range whose note has actual content. A cleared note leaves an
  /// empty row behind, which must not show a marker.
  days_with_notes: string[];
  /// Raw `created_at` values; the caller buckets them by local day.
  thought_times: number[];
}
```

Add `DayNote` to the existing `import type { ... } from "./types";` list at
the top of `api.ts`.

- [ ] **Step 4: Run the gates**

Run: `cargo test`, `RUSTFLAGS="-D warnings" cargo build`, then `npm run check`.
Expected: all green. `day_summaries` is complete as written — the bucketing
of `thought_times` into days happens in Task 7, where the calendar consumes
it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src-tauri/src/db/thoughts.rs src/lib/api.ts src/lib/types.ts
git commit -m "feat(calendar): commands for day notes, summaries, day thoughts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `localDayKey` — the single place a Date becomes a day key

**Files:**
- Create: `src/lib/day.ts`
- Create: `src/lib/day.test.ts`

**Interfaces:**
- Produces: `localDayKey(d: Date): string`, `dayBounds(d: Date): { startMs: number; endMs: number }` — used by Tasks 6 and 7.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/day.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { localDayKey, dayBounds } from "./day";

describe("localDayKey", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(localDayKey(new Date(2026, 7, 23, 14, 30))).toBe("2026-08-23");
  });

  // Zero-padding is what keeps lexical comparison chronological, which is
  // what the SQL range query relies on.
  it("zero-pads month and day", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  // The whole point of a LOCAL key: a moment late in the evening belongs to
  // that evening's date, not to tomorrow in UTC.
  it("uses the local date, not the UTC date", () => {
    const lateEvening = new Date(2026, 7, 23, 23, 30);
    expect(localDayKey(lateEvening)).toBe("2026-08-23");
  });

  it("sorts lexically in chronological order", () => {
    const keys = [
      localDayKey(new Date(2026, 8, 1)),
      localDayKey(new Date(2026, 7, 31)),
      localDayKey(new Date(2026, 7, 9)),
    ];
    expect([...keys].sort()).toEqual(["2026-08-09", "2026-08-31", "2026-09-01"]);
  });
});

describe("dayBounds", () => {
  it("spans local midnight to the next local midnight", () => {
    const { startMs, endMs } = dayBounds(new Date(2026, 7, 23, 14, 30));
    expect(new Date(startMs).getHours()).toBe(0);
    expect(new Date(startMs).getDate()).toBe(23);
    expect(endMs - startMs).toBe(86_400_000);
  });

  it("is half-open so an item at midnight belongs to one day only", () => {
    const a = dayBounds(new Date(2026, 7, 23));
    const b = dayBounds(new Date(2026, 7, 24));
    expect(a.endMs).toBe(b.startMs);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./day`.

- [ ] **Step 3: Write the helper**

Create `src/lib/day.ts`:

```ts
/// The one place a Date becomes a day key.
///
/// The backend never derives a calendar day from a timestamp — only the
/// frontend knows the user's local calendar, and two implementations would
/// eventually disagree about which day a moment belongs to. Everything that
/// needs a day key comes through here.

/// A local calendar date as 'YYYY-MM-DD'. Zero-padded so that lexical
/// ordering is chronological, which the SQL range query depends on.
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/// Half-open [startMs, endMs) covering the local day `d` falls in. Half-open
/// so an item landing exactly on midnight belongs to exactly one day.
export function dayBounds(d: Date): { startMs: number; endMs: number } {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}
```

- [ ] **Step 4: Run the gates**

Run: `npm test` and `npm run check`.
Expected: all green, including the six new `day.test.ts` cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/day.ts src/lib/day.test.ts
git commit -m "feat(calendar): localDayKey — one place a Date becomes a day key

The backend never derives a calendar day from a timestamp, so two
implementations can never disagree about which day a moment belongs to.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `DayPanel.svelte`

**Files:**
- Create: `src/lib/components/DayPanel.svelte`
- Create: `src/lib/components/DayPanel.test.ts`

**Interfaces:**
- Consumes: `localDayKey`, `dayBounds` (Task 5); `api.getDayNote`, `api.setDayNote`, `api.thoughtsBetween` (Task 4); `effectiveDueAt` from `../time`.
- Produces: a component with props `{ open: boolean; date: Date | null; reminders: Reminder[]; onClose: () => void; onSelect: (r: Reminder) => void; onCreateForDate: (ms: number, silent: boolean) => void }`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/components/DayPanel.test.ts`:

```ts
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

const getDayNote = vi.fn();
const setDayNote = vi.fn();
const thoughtsBetween = vi.fn();

vi.mock("../api", () => ({
  api: {
    getDayNote: (...a: unknown[]) => getDayNote(...a),
    setDayNote: (...a: unknown[]) => setDayNote(...a),
    thoughtsBetween: (...a: unknown[]) => thoughtsBetween(...a),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import DayPanel from "./DayPanel.svelte";

const DAY = new Date(2026, 7, 23, 12, 0);

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Pending thing",
    description: null,
    due_at: new Date(2026, 7, 23, 9, 0).getTime(),
    priority: "normal",
    sound_path: null,
    repeat_rule: null,
    state: "pending",
    snooze_until: null,
    created_at: 1,
    updated_at: 1,
    source: "local",
    external_id: null,
    last_synced_at: null,
    silent: false,
    tags: [],
    task_lane_id: null,
    task_sort_key: null,
    ...overrides,
  };
}

function mount(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onCreateForDate = vi.fn();
  const r = render(DayPanel, {
    props: {
      open: true,
      date: DAY,
      reminders: [reminder()],
      onClose,
      onSelect,
      onCreateForDate,
      ...props,
    },
  });
  return { ...r, onClose, onSelect, onCreateForDate };
}

const noteBox = () => screen.getByPlaceholderText("What happened?") as HTMLTextAreaElement;

describe("DayPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getDayNote.mockResolvedValue(null);
    setDayNote.mockResolvedValue({ day: "2026-08-23", body: "", created_at: 1, updated_at: 1 });
    thoughtsBetween.mockResolvedValue([]);
  });

  it("loads the note for the day it is opened on", async () => {
    getDayNote.mockResolvedValue({
      day: "2026-08-23",
      body: "shipped v0.9.0",
      created_at: 1,
      updated_at: 1,
    });
    mount();
    await waitFor(() => expect(noteBox().value).toBe("shipped v0.9.0"));
    expect(getDayNote).toHaveBeenCalledWith("2026-08-23");
  });

  // The whole point of showing a day: finished items count as "what
  // happened", so they must be listed, not filtered out like the grid does.
  it("lists both unfinished and finished items for the day", async () => {
    mount({
      reminders: [
        reminder({ id: "a", title: "Still pending" }),
        reminder({ id: "b", title: "Already done", state: "completed" }),
      ],
    });
    expect(await screen.findByText("Still pending")).toBeTruthy();
    expect(screen.getByText("Already done")).toBeTruthy();
  });

  it("ignores items belonging to other days", async () => {
    mount({
      reminders: [
        reminder({ id: "a", title: "Today's thing" }),
        reminder({
          id: "b",
          title: "Tomorrow's thing",
          due_at: new Date(2026, 7, 24, 9, 0).getTime(),
        }),
      ],
    });
    expect(await screen.findByText("Today's thing")).toBeTruthy();
    expect(screen.queryByText("Tomorrow's thing")).toBeNull();
  });

  it("opens a reminder when its row is clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount();
    await user.click(await screen.findByText("Pending thing"));
    expect(onSelect).toHaveBeenCalled();
  });

  // Autosave: one write after the pause, not one per keystroke.
  it("saves once after typing stops", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.type(noteBox(), "went well");
    expect(setDayNote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(setDayNote).toHaveBeenCalledTimes(1);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "went well");
  });

  // The flush that matters: an unflushed debounce discards the note.
  it("flushes a pending note when the panel closes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender, onClose } = mount();
    await user.type(noteBox(), "half typed");
    expect(setDayNote).not.toHaveBeenCalled();

    await screen.getByLabelText("Close day").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "half typed");
    expect(onClose).toHaveBeenCalled();
    void rerender;
  });

  // Switching days is as dangerous as closing: the panel swaps contents in
  // place, so an unflushed note would be replaced by the next day's body.
  it("flushes a pending note when switching to another day", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = mount();
    await user.type(noteBox(), "half typed");

    await rerender({
      open: true,
      date: new Date(2026, 7, 24, 12, 0),
      reminders: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onCreateForDate: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "half typed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — cannot resolve `./DayPanel.svelte`.

- [ ] **Step 3: Write the component**

Create `src/lib/components/DayPanel.svelte`:

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
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
  /// The day the current `note` belongs to. Plain `let`, not $state: it is
  /// written from the effect that reads it, and a reactive write would
  /// re-trigger that effect.
  let loadedDay: string | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /// Set while a save is pending, so flushing knows what to write even
  /// after `note` has been replaced by another day's body.
  let pending: { day: string; body: string } | null = null;

  function flushNote() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const p = pending;
    pending = null;
    if (!p) return;
    api.setDayNote(p.day, p.body).catch((e) => console.error("setDayNote failed", e));
  }

  function scheduleSave(day: string, body: string) {
    pending = { day, body };
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNote, AUTOSAVE_MS);
  }

  function onNoteInput(e: Event) {
    const body = (e.currentTarget as HTMLTextAreaElement).value;
    note = body;
    if (loadedDay) scheduleSave(loadedDay, body);
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
    const { startMs, endMs } = dayBounds(date);
    api
      .getDayNote(key)
      .then((n) => {
        if (loadedDay === key) note = n?.body ?? "";
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

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  let heading = $derived(
    date ? `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}` : "",
  );

  /// Everything due that local day, finished or not — the grid hides state,
  /// but "what happened" includes what already fired.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all seven DayPanel tests.

- [ ] **Step 5: Verify the flush tests actually catch the bug**

Temporarily change `close()` to call only `onClose()` (drop `flushNote()`),
and change the `$effect`'s `flushNote()` call to nothing. Run `npm test`.
Expected: "flushes a pending note when the panel closes" and "flushes a
pending note when switching to another day" both FAIL. Restore both lines
and re-run — all green. A flush test that passes without the flush is
worthless.

- [ ] **Step 6: Run the gates and commit**

Run: `npm test` and `npm run check`.

```bash
git add src/lib/components/DayPanel.svelte src/lib/components/DayPanel.test.ts
git commit -m "feat(calendar): DayPanel — day contents, thoughts, autosaved note

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire the panel into the calendar

**Files:**
- Modify: `src/lib/components/CalendarView.svelte`
- Create: `src/lib/components/CalendarView.test.ts`
- Modify: `src/App.svelte` (pass `onSelect`/`onCreateForDate` through — see Interfaces)

**Interfaces:**
- Consumes: `DayPanel` (Task 6), `localDayKey`/`dayBounds` (Task 5), `api.daySummaries` (Task 5).
- Produces: clickable calendar cells; `CalendarView` renders `DayPanel` itself, so `App.svelte` needs no new props.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/components/CalendarView.test.ts`:

```ts
import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

const daySummaries = vi.fn();
const getDayNote = vi.fn();
const thoughtsBetween = vi.fn();

vi.mock("../api", () => ({
  api: {
    daySummaries: (...a: unknown[]) => daySummaries(...a),
    getDayNote: (...a: unknown[]) => getDayNote(...a),
    setDayNote: vi.fn().mockResolvedValue(null),
    thoughtsBetween: (...a: unknown[]) => thoughtsBetween(...a),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import CalendarView from "./CalendarView.svelte";

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Inspect the thing",
    description: null,
    due_at: Date.now(),
    priority: "normal",
    sound_path: null,
    repeat_rule: null,
    state: "pending",
    snooze_until: null,
    created_at: 1,
    updated_at: 1,
    source: "local",
    external_id: null,
    last_synced_at: null,
    silent: false,
    tags: [],
    task_lane_id: null,
    task_sort_key: null,
    ...overrides,
  };
}

describe("CalendarView day selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daySummaries.mockResolvedValue({ days_with_notes: [], thought_times: [] });
    getDayNote.mockResolvedValue(null);
    thoughtsBetween.mockResolvedValue([]);
  });

  function mount() {
    return render(CalendarView, {
      props: { reminders: [reminder()], onSelect: vi.fn(), onCreateForDate: vi.fn() },
    });
  }

  it("opens the day panel when a day is clicked", async () => {
    const user = userEvent.setup();
    mount();
    const today = new Date();
    await user.click(screen.getByLabelText(`Open ${today.getDate()}`));
    expect(await screen.findByPlaceholderText("What happened?")).toBeTruthy();
  });

  it("asks the backend for that day's note", async () => {
    const user = userEvent.setup();
    mount();
    const today = new Date();
    await user.click(screen.getByLabelText(`Open ${today.getDate()}`));
    const { localDayKey } = await import("../day");
    expect(getDayNote).toHaveBeenCalledWith(localDayKey(today));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — no element labelled "Open <n>"; cells are plain divs.

- [ ] **Step 3: Make cells clickable and mount the panel**

In `src/lib/components/CalendarView.svelte`:

Add to the imports at the top of `<script>`:

```ts
  import { api } from "../api";
  import { localDayKey, dayBounds } from "../day";
  import DayPanel from "./DayPanel.svelte";
```

Add state and the summaries load, after the `cells` derivation:

```ts
  let selectedDate = $state<Date | null>(null);
  let panelOpen = $state(false);
  let daysWithNotes = $state<Set<string>>(new Set());
  let daysWithThoughts = $state<Set<string>>(new Set());

  function openDay(d: Date) {
    selectedDate = d;
    panelOpen = true;
  }

  /// Markers for the visible range. The backend hands back raw thought
  /// timestamps rather than per-day counts — bucketing needs the local
  /// calendar, which only the frontend has.
  $effect(() => {
    const first = cells[0]?.date;
    const last = cells[cells.length - 1]?.date;
    if (!first || !last) return;
    const from = localDayKey(first);
    const to = localDayKey(last);
    const { startMs } = dayBounds(first);
    const { endMs } = dayBounds(last);
    api
      .daySummaries(from, to, startMs, endMs)
      .then((s) => {
        daysWithNotes = new Set(s.days_with_notes);
        daysWithThoughts = new Set(
          s.thought_times.map((ms) => localDayKey(new Date(ms))),
        );
      })
      .catch((e) => console.error("daySummaries failed", e));
  });
```

Replace the cell wrapper. The old markup opened with
`<div class="cell" ... role="gridcell" tabindex="-1" oncontextmenu=...>`;
replace that opening tag and its `</div>` with a button:

```svelte
      <button
        class="cell"
        class:out={!cell.inMonth}
        class:today={cell.isToday}
        class:past={cell.isPast && !cell.isToday}
        class:selected={selectedDate !== null &&
          localDayKey(selectedDate) === localDayKey(cell.date)}
        aria-label={`Open ${cell.date.getDate()}`}
        onclick={() => openDay(cell.date)}
        oncontextmenu={(e) => handleCellContextMenu(cell.date, e)}
      >
```

Inside it, keep `day-num` and `day-items` as they are, but make the
per-item buttons stop propagation so clicking an item still opens the
editor rather than the day:

```svelte
              onclick={(e) => { e.stopPropagation(); onSelect(r); }}
```

and add the mobile markers row plus the note/thought glyphs after
`day-items`:

```svelte
        <div class="markers" aria-hidden="true">
          {#each cell.reminders.slice(0, 3) as r (r.id)}
            <span class="dot" class:done={r.state === "completed" || r.state === "dismissed" || r.state === "fired"}></span>
          {/each}
          {#if daysWithNotes.has(localDayKey(cell.date))}
            <span class="glyph note-glyph">▪</span>
          {/if}
          {#if daysWithThoughts.has(localDayKey(cell.date))}
            <span class="glyph thought-glyph">•</span>
          {/if}
        </div>
```

Mount the panel just before the closing `</section>`:

```svelte
  <DayPanel
    open={panelOpen}
    date={selectedDate}
    reminders={reminders}
    onClose={() => (panelOpen = false)}
    onSelect={(r) => { panelOpen = false; onSelect(r); }}
    onCreateForDate={(ms, silent) => { panelOpen = false; onCreateForDate?.(ms, silent); }}
  />
```

Add to the `<style>` block:

```css
  .cell {
    /* Was a div; as a button it needs the box model reset. */
    font-family: inherit;
    text-align: left;
    cursor: pointer;
  }
  .cell.selected {
    box-shadow: inset 0 0 0 1px var(--klaxon-dim);
  }
  .markers { display: none; gap: 3px; align-items: center; padding: 0 4px 4px; }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--klaxon);
  }
  .dot.done { background: var(--text-faint); }
  .glyph { font-size: 8px; line-height: 1; color: var(--text-muted); }
  .note-glyph { color: var(--klaxon-dim); }

  /* This component's first mobile rules. A 45px cell cannot render a title,
     so stop trying: show the day number and density markers, and let the
     panel carry the detail. */
  @media (max-width: 1024px) {
    .day-items { display: none; }
    .markers { display: flex; }
    .cell { min-height: 44px; }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. Then `npm run check` — 0 errors 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/lib/components/CalendarView.svelte src/lib/components/CalendarView.test.ts
git commit -m "feat(calendar): clickable days, day panel, mobile density markers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Refresh the panel when a note arrives by sync

**Files:**
- Modify: `src/lib/components/DayPanel.svelte`

**Interfaces:**
- Consumes: the `klaxon://day-notes-changed` event emitted by `set_day_note` (Task 4) and by sync applying a remote note.

- [ ] **Step 1: Add the listener**

In `DayPanel.svelte`, add to the imports:

```ts
  import { onMount } from "svelte";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
```

and after the existing `$effect`:

```ts
  let unlistenNotes: UnlistenFn | null = null;
  onMount(async () => {
    // A note edited on the other device should appear here without
    // reopening the day. Skip while a save is pending — our own write
    // triggers this event, and reloading mid-edit would overwrite what the
    // user is typing with what we just sent.
    unlistenNotes = await listen("klaxon://day-notes-changed", async () => {
      if (pending !== null || !loadedDay) return;
      const day = loadedDay;
      try {
        const n = await api.getDayNote(day);
        if (loadedDay === day) note = n?.body ?? "";
      } catch (e) {
        console.error("getDayNote refresh failed", e);
      }
    });
  });

  onDestroy(() => {
    if (unlistenNotes) unlistenNotes();
  });
```

Note there is already an `onDestroy(flushNote)` — keep both; Svelte allows
multiple `onDestroy` registrations.

- [ ] **Step 2: Emit the event when sync applies a note**

In `src-tauri/src/sync/ops.rs`, inside the `if let Some(app) = app` block
in `push`, after the existing `emit_thoughts_changed` call:

```rust
        if accepted_day_notes > 0 {
            let _ = app.emit("klaxon://day-notes-changed", ());
        }
```

Ensure `use tauri::Emitter;` is in scope in `ops.rs` (it already is, via
the existing emit calls; if not, add it).

- [ ] **Step 3: Run the gates**

Run: `npm test`, `npm run check`, and from `src-tauri/`: `cargo test`,
`RUSTFLAGS="-D warnings" cargo build`.
Expected: all green — the existing DayPanel tests still pass because the
mocked `listen` never fires.

- [ ] **Step 4: Commit**

```bash
git add src/lib/components/DayPanel.svelte src-tauri/src/sync/ops.rs
git commit -m "feat(calendar): day panel follows notes arriving by sync

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Release prep — v0.10.0 bump + changelog

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` (klaxon entry only), `src-tauri/tauri.conf.json` — all `0.9.0` → `0.10.0`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Bump the four version sites**

`"version": "0.10.0"` in `package.json` and `src-tauri/tauri.conf.json`;
`version = "0.10.0"` on line 3 of `src-tauri/Cargo.toml`; and the `version`
line directly under `name = "klaxon"` in `src-tauri/Cargo.lock` — that one
only, other packages that happen to be at 0.9.0 must not be touched.

- [ ] **Step 2: Changelog entry**

Prepend to `CHANGELOG.md`, adjusting the date to the release day:

```markdown
## [0.10.0] — 2026-08-XX

**Update both devices together** — the sync format changed, so a 0.9.x
device and a 0.10 device cannot exchange changes until both are upgraded.
Nothing is lost while they are mismatched; syncing simply pauses.

### Added

- **Click any day in the calendar to open it.** A busy day used to say
  "+3 more" and give you no way to see what those were. The day panel
  lists everything that touched that day — reminders and tasks, including
  ones that already fired or were completed, plus any thoughts you
  captured — and lets you add a new reminder or task on that date.
- **A note on each day.** Free text for what actually happened, saved as
  you type. It syncs between your devices like everything else.
- **The calendar is readable on a phone.** A month grid cannot fit item
  titles in a phone-width cell, so it no longer tries: each day shows its
  number and small markers for how much is on it, whether it has a note,
  and whether you captured thoughts. Tap for the detail.
```

- [ ] **Step 3: Run every gate**

From `src-tauri/`: `cargo test`, `RUSTFLAGS="-D warnings" cargo build`.
From the repo root: `npm test`, `npm run check`.
Expected: all green.

- [ ] **Step 4: Commit and push**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "v0.10.0: calendar day detail + day notes — version bump + changelog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin main
```

- [ ] **Step 5: STOP — hardware drill before publishing**

Do NOT publish the release yet. Build both artifacts (desktop
`npm run tauri build`; Android `npm run tauri -- android build --verbose`
with `JAVA_HOME` set to the Android Studio jbr), verify them per the
established ritual — including `apksigner verify --print-certs` rather than
looking for `META-INF/*.RSA`, which only detects v1 signing and reports a
correctly-signed APK as unsigned.

Then drill on hardware:
- Density markers legible and days distinguishable at phone width.
- Panel is full-screen on the Fold and dismissible.
- A note written on one device appears on the other after a sync.
- A note typed and immediately closed is not lost.
- Finished items appear in the day panel, distinguished from pending.

Only after the drill passes: `gh release create v0.10.0` with the contract
asset names (`Klaxon_0.10.0_x64-setup.exe`, `klaxon-0.10.0-arm64.apk`) and
notes leading with the update-both-devices warning.
