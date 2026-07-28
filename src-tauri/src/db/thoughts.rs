//! Storage for the Thoughts feed.
//!
//! A thought is free text with tags — no due date, no state, no lane. It
//! lives in its own table specifically so the scheduler can never see one.
//!
//! Sync semantics: `updated_at` is the LWW clock and deletes write to the
//! shared `tombstones` table. Unlike lanes, the push path does *not* filter
//! on `dirty` — see issue #1.

use rusqlite::{params, Connection, Row};
use serde::Serialize;

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

/// A search result: the thought plus an FTS5-generated excerpt with the
/// matched terms wrapped in `<mark>`.
#[derive(Debug, Clone, Serialize)]
pub struct ThoughtHit {
    pub thought: Thought,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

/// Full-text search, optionally narrowed to a single tag.
///
/// Ordered by FTS5 `rank` (best match first) rather than recency — when
/// you are searching you want relevance; the unsearched feed is the place
/// for chronology. Returns an empty vec when the query has no usable
/// tokens; callers show the plain feed in that case.
pub fn search(
    conn: &Connection,
    query: &str,
    tag: Option<&str>,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ThoughtHit>> {
    let Some(match_query) = crate::search::to_match_query(query) else {
        return Ok(Vec::new());
    };

    // `?4` is the tag filter: NULL means "no filter". Tags are a JSON array
    // of normalized lowercase strings, so an exact element match via
    // json_each is precise — no LIKE substring false positives.
    let mut stmt = conn.prepare(
        "SELECT t.id, t.body, t.tags, t.created_at, t.updated_at, t.dirty,
                snippet(thoughts_fts, 0, '<mark>', '</mark>', '…', 12) AS snip
           FROM thoughts_fts
           JOIN thoughts t ON t.rowid = thoughts_fts.rowid
          WHERE thoughts_fts MATCH ?1
            AND (?4 IS NULL OR EXISTS (
                  SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?4
                ))
          ORDER BY rank
          LIMIT ?2 OFFSET ?3",
    )?;
    let rows = stmt.query_map(params![match_query, limit, offset, tag], |row| {
        Ok(ThoughtHit {
            thought: row_to_thought(row)?,
            snippet: row.get("snip")?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// The feed filtered to one tag, with no search query. Newest first,
/// matching `list`.
pub fn list_by_tag(
    conn: &Connection,
    tag: &str,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Thought>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM thoughts t
          WHERE EXISTS (
                SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?1
              )
          ORDER BY created_at DESC, id DESC
          LIMIT ?2 OFFSET ?3"
    ))?;
    let rows = stmt.query_map(params![tag, limit, offset], row_to_thought)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Every tag in use on a thought, with how many thoughts carry it.
/// Most-used first, then alphabetical — drives the tag browser.
pub fn tag_counts(conn: &Connection) -> AppResult<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT json_each.value AS tag, COUNT(*) AS n
           FROM thoughts, json_each(thoughts.tags)
          GROUP BY json_each.value
          ORDER BY n DESC, tag ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TagCount { tag: r.get("tag")?, count: r.get("n")? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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

    use super::{list_by_tag, search, tag_counts};

    fn seed(conn: &rusqlite::Connection) {
        create(
            conn,
            ThoughtCreate {
                body: "sourdough starter needs feeding".into(),
                tags: vec!["recipe".into()],
            },
        )
        .unwrap();
        create(
            conn,
            ThoughtCreate {
                body: "book idea about lighthouses".into(),
                tags: vec!["writing".into(), "idea".into()],
            },
        )
        .unwrap();
    }

    #[test]
    fn search_matches_body_text() {
        let conn = test_conn();
        seed(&conn);
        let hits = search(&conn, "sourdough", None, 50, 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].thought.body, "sourdough starter needs feeding");
        assert!(
            hits[0].snippet.contains("<mark>"),
            "snippet should mark the match, got {:?}",
            hits[0].snippet
        );
    }

    #[test]
    fn search_matches_tags_too() {
        let conn = test_conn();
        seed(&conn);
        let hits = search(&conn, "writing", None, 50, 0).unwrap();
        assert_eq!(hits.len(), 1, "a tag-only match should still be found");
        assert_eq!(hits[0].thought.body, "book idea about lighthouses");
    }

    #[test]
    fn search_matches_on_a_prefix_as_you_type() {
        let conn = test_conn();
        seed(&conn);
        assert_eq!(search(&conn, "sour", None, 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn search_treats_operators_as_literal_text() {
        let conn = test_conn();
        seed(&conn);
        // Must not raise an FTS5 syntax error, and must not be read as an
        // OR query (which would match both seeded rows).
        let hits = search(&conn, "cats OR dogs", None, 50, 0).unwrap();
        assert!(hits.is_empty(), "no thought contains that literal phrase");

        assert!(search(&conn, "\"", None, 50, 0).is_ok(), "lone quote must not error");
        assert!(search(&conn, "foo-bar", None, 50, 0).is_ok(), "hyphen must not error");
    }

    #[test]
    fn search_reflects_edits_and_deletes() {
        let conn = test_conn();
        seed(&conn);
        let hit = search(&conn, "sourdough", None, 50, 0).unwrap().remove(0);

        update(
            &conn,
            &hit.thought.id,
            ThoughtUpdate { body: Some("bread machine broke".into()), tags: None },
        )
        .unwrap();
        assert!(search(&conn, "sourdough", None, 50, 0).unwrap().is_empty());
        assert_eq!(search(&conn, "bread", None, 50, 0).unwrap().len(), 1);

        delete(&conn, &hit.thought.id).unwrap();
        assert!(search(&conn, "bread", None, 50, 0).unwrap().is_empty());
    }

    #[test]
    fn search_composes_with_a_tag_filter() {
        let conn = test_conn();
        seed(&conn);
        create(
            &conn,
            ThoughtCreate {
                body: "another lighthouse thought".into(),
                tags: vec!["recipe".into()],
            },
        )
        .unwrap();

        let all = search(&conn, "lighthouse", None, 50, 0).unwrap();
        assert_eq!(all.len(), 2);

        let filtered = search(&conn, "lighthouse", Some("writing"), 50, 0).unwrap();
        assert_eq!(filtered.len(), 1, "tag filter should narrow the search");
        assert_eq!(filtered[0].thought.body, "book idea about lighthouses");
    }

    #[test]
    fn list_by_tag_returns_only_that_tag() {
        let conn = test_conn();
        seed(&conn);
        let rows = list_by_tag(&conn, "idea", 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].body, "book idea about lighthouses");
    }

    #[test]
    fn tag_counts_are_aggregated_and_ordered() {
        let conn = test_conn();
        seed(&conn);
        create(&conn, ThoughtCreate { body: "third".into(), tags: vec!["idea".into()] })
            .unwrap();

        let counts = tag_counts(&conn).unwrap();
        let idea = counts.iter().find(|c| c.tag == "idea").unwrap();
        assert_eq!(idea.count, 2);
        assert_eq!(counts[0].tag, "idea", "most-used tag comes first");
    }
}
