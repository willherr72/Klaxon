//! Storage for the Thoughts feed.
//!
//! A thought is free text with tags — no due date, no state, no lane. It
//! lives in its own table specifically so the scheduler can never see one.
//!
//! Sync semantics: `updated_at` is the LWW clock and deletes write to the
//! shared `tombstones` table. Unlike lanes, the push path does *not* filter
//! on `dirty` — see issue #1.

use rusqlite::{params, Connection, Row};

use crate::error::{AppError, AppResult};
use crate::models::{normalize_tags, now_ms, truncate_body, Thought, ThoughtCreate, ThoughtUpdate};

fn row_to_thought(row: &Row<'_>) -> rusqlite::Result<Thought> {
    let tags_json: String = row.get("tags").unwrap_or_else(|_| "[]".to_string());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let dirty_int: i32 = row.get("dirty")?;
    Ok(Thought {
        id: row.get("id")?,
        body: row.get("body")?,
        tags,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        dirty: dirty_int != 0,
    })
}

const COLUMNS: &str = "id, body, tags, created_at, updated_at, dirty";

pub fn create(conn: &Connection, input: ThoughtCreate) -> AppResult<Thought> {
    let body = truncate_body(&input.body);
    if body.is_empty() {
        return Err(AppError::Invalid("thought body required".into()));
    }
    let tags = normalize_tags(input.tags);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    conn.execute(
        "INSERT INTO thoughts (id, body, tags, created_at, updated_at, dirty)
         VALUES (?1, ?2, ?3, ?4, ?4, 1)",
        params![id, body, tags_json, now],
    )?;

    get_by_id(conn, &id)
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Thought> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM thoughts WHERE id = ?1"))?;
    let mut rows = stmt.query_map(params![id], row_to_thought)?;
    match rows.next() {
        Some(row) => Ok(row?),
        None => Err(AppError::NotFound(format!("thought {id}"))),
    }
}

/// Newest first. `limit`/`offset` drive the feed's infinite scroll —
/// thoughts accumulate permanently, so the feed never loads all of them.
pub fn list(conn: &Connection, limit: i64, offset: i64) -> AppResult<Vec<Thought>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM thoughts
         ORDER BY created_at DESC, id DESC
         LIMIT ?1 OFFSET ?2"
    ))?;
    let rows = stmt.query_map(params![limit, offset], row_to_thought)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Patch semantics: `None` leaves a field untouched. Always bumps
/// `updated_at` and marks dirty.
pub fn update(conn: &Connection, id: &str, patch: ThoughtUpdate) -> AppResult<Thought> {
    let current = get_by_id(conn, id)?;

    let body = match patch.body {
        Some(raw) => {
            let trimmed = truncate_body(&raw);
            if trimmed.is_empty() {
                return Err(AppError::Invalid("thought body required".into()));
            }
            trimmed
        }
        None => current.body,
    };
    let tags = match patch.tags {
        Some(t) => normalize_tags(t),
        None => current.tags,
    };
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "UPDATE thoughts
            SET body = ?2, tags = ?3, updated_at = ?4, dirty = 1
          WHERE id = ?1",
        params![id, body, tags_json, now_ms()],
    )?;

    get_by_id(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM thoughts WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{create, delete, get_by_id, list, update};
    use crate::models::{ThoughtCreate, ThoughtUpdate};

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn create_then_read_roundtrips() {
        let conn = test_conn();
        let made = create(
            &conn,
            ThoughtCreate {
                body: "  ship the thing  ".into(),
                tags: vec!["Work".into(), "work".into(), "  IDEA ".into()],
            },
        )
        .unwrap();

        assert_eq!(made.body, "ship the thing", "body should be trimmed");
        assert_eq!(
            made.tags,
            vec!["work".to_string(), "idea".to_string()],
            "tags should be normalized and deduped"
        );
        assert!(made.dirty);

        let fetched = get_by_id(&conn, &made.id).unwrap();
        assert_eq!(fetched.body, made.body);
        assert_eq!(fetched.tags, made.tags);
    }

    #[test]
    fn empty_body_is_rejected() {
        let conn = test_conn();
        let err = create(&conn, ThoughtCreate { body: "   ".into(), tags: vec![] });
        assert!(err.is_err(), "whitespace-only body must not be stored");
    }

    #[test]
    fn list_is_newest_first_and_pages() {
        let conn = test_conn();
        for i in 0..5 {
            create(
                &conn,
                ThoughtCreate { body: format!("thought {i}"), tags: vec![] },
            )
            .unwrap();
            // created_at comes from now_ms(); nudge rows apart so ordering
            // is deterministic rather than dependent on clock resolution.
            conn.execute(
                "UPDATE thoughts SET created_at = ?1 WHERE body = ?2",
                rusqlite::params![1_000 + i as i64, format!("thought {i}")],
            )
            .unwrap();
        }

        let first_page = list(&conn, 2, 0).unwrap();
        assert_eq!(first_page.len(), 2);
        assert_eq!(first_page[0].body, "thought 4", "newest first");
        assert_eq!(first_page[1].body, "thought 3");

        let second_page = list(&conn, 2, 2).unwrap();
        assert_eq!(second_page[0].body, "thought 2", "offset should skip");
    }

    #[test]
    fn update_changes_body_and_bumps_the_clock() {
        let conn = test_conn();
        let made =
            create(&conn, ThoughtCreate { body: "draft".into(), tags: vec![] }).unwrap();
        conn.execute(
            "UPDATE thoughts SET updated_at = 1 WHERE id = ?1",
            rusqlite::params![made.id],
        )
        .unwrap();

        let edited = update(
            &conn,
            &made.id,
            ThoughtUpdate { body: Some("final".into()), tags: None },
        )
        .unwrap();

        assert_eq!(edited.body, "final");
        assert!(edited.updated_at > 1, "updated_at must advance");
        assert_eq!(edited.tags, made.tags, "omitted field must be left alone");
    }

    #[test]
    fn delete_removes_the_row() {
        let conn = test_conn();
        let made =
            create(&conn, ThoughtCreate { body: "gone".into(), tags: vec![] }).unwrap();
        delete(&conn, &made.id).unwrap();
        assert!(get_by_id(&conn, &made.id).is_err());
    }
}
