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
}
