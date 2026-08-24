//! Storage for the Thoughts feed.
//!
//! A thought is free text with tags — no due date, no state, no lane. It
//! lives in its own table specifically so the scheduler can never see one.
//!
//! Sync semantics: `updated_at` is the LWW clock and deletes write to the
//! shared `tombstones` table. Unlike lanes, the push path does *not* filter
//! on any origin flag — watermarks only (issues #1/#2).

use rusqlite::{params, Connection, Row};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::models::{
    extract_tags, normalize_tags, now_ms, truncate_body, Thought, ThoughtCreate, ThoughtUpdate,
};
use crate::sync::types::RemoteThought;

fn row_to_thought(row: &Row<'_>) -> rusqlite::Result<Thought> {
    let tags_json: String = row.get("tags").unwrap_or_else(|_| "[]".to_string());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(Thought {
        id: row.get("id")?,
        body: row.get("body")?,
        tags,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

const COLUMNS: &str = "id, body, tags, created_at, updated_at";

/// A thought's tags are whatever `#tag`s appear in its body, plus any the
/// caller passed explicitly (the Android share-target will want that).
///
/// The body is the source of truth: deleting `#idea` from the text while
/// editing removes the tag. There is no way to attach a tag that isn't
/// written in the body, which is what makes the round trip predictable —
/// what you see in the text is what you get in the chips.
fn tags_for(body: &str, explicit: Vec<String>) -> Vec<String> {
    let mut all = normalize_tags(explicit);
    for tag in extract_tags(body) {
        if !all.contains(&tag) {
            all.push(tag);
        }
    }
    all
}

pub fn create(conn: &Connection, input: ThoughtCreate) -> AppResult<Thought> {
    let body = truncate_body(&input.body);
    if body.is_empty() {
        return Err(AppError::Invalid("thought body required".into()));
    }
    let tags = tags_for(&body, input.tags);
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();

    conn.execute(
        "INSERT INTO thoughts (id, body, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
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

/// Patch semantics: `None` leaves a field untouched. Always bumps
/// `updated_at` (the sync watermark).
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
    // Re-derive from the (possibly edited) body so removing a #tag while
    // editing actually drops the chip.
    let tags = tags_for(&body, patch.tags.unwrap_or_default());
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "UPDATE thoughts
            SET body = ?2, tags = ?3, updated_at = ?4
          WHERE id = ?1",
        params![id, body, tags_json, now_ms()],
    )?;

    get_by_id(conn, id)
}

/// Delete a thought and record a tombstone so paired devices drop their
/// copy too. Mirrors `reminders::delete` — the tombstone lives here rather
/// than in the command so no future caller can forget it.
///
/// Not used by the sync-apply path: an incoming tombstone is handled by
/// `tombstones::apply_remote`, which drops the row without writing a
/// fresh tombstone that would echo straight back.
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM thoughts WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("thought {id}")));
    }
    super::tombstones::create(conn, id, now_ms())?;
    Ok(())
}

/// Apply a thought that arrived over sync. Last-write-wins by
/// `updated_at`; older incoming rows are ignored. Returns whether anything
/// changed.
pub fn apply_remote(conn: &Connection, t: &RemoteThought) -> AppResult<bool> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM thoughts WHERE id = ?1",
            params![t.id],
            |r| r.get(0),
        )
        .ok();
    if let Some(existing) = existing {
        if t.updated_at <= existing {
            return Ok(false);
        }
    }

    let tags = normalize_tags(t.tags.clone());
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    conn.execute(
        "INSERT INTO thoughts (id, body, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            body = excluded.body,
            tags = excluded.tags,
            updated_at = excluded.updated_at",
        params![t.id, truncate_body(&t.body), tags_json, t.created_at, t.updated_at],
    )?;
    Ok(true)
}

/// Rows to push to a peer, by the per-peer high-water mark.
///
/// Selection is by watermark alone, matching `reminders`. Lanes
/// and tombstones do filter, which is why a row learned from one peer
/// never reaches a second — issue #1. The cost here is that a row echoes
/// back once to the peer it came from, which is idempotent under LWW.
pub fn updated_since(conn: &Connection, since: i64) -> AppResult<Vec<Thought>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM thoughts
          WHERE updated_at > ?1
          ORDER BY updated_at ASC"
    ))?;
    let rows = stmt.query_map(params![since], row_to_thought)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
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
        "SELECT t.id, t.body, t.tags, t.created_at, t.updated_at,
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

        let fetched = get_by_id(&conn, &made.id).unwrap();
        assert_eq!(fetched.body, made.body);
        assert_eq!(fetched.tags, made.tags);
    }

    #[test]
    fn inline_hashtags_in_the_body_become_tags() {
        let conn = test_conn();
        let made = create(
            &conn,
            ThoughtCreate {
                body: "book idea about #lighthouses #Writing".into(),
                tags: vec![],
            },
        )
        .unwrap();

        assert_eq!(
            made.tags,
            vec!["lighthouses".to_string(), "writing".to_string()],
            "inline #tags should be extracted and lowercased"
        );
        assert!(
            made.body.contains("#lighthouses"),
            "the #tag text must stay in the body — nothing the user typed is rewritten"
        );
    }

    #[test]
    fn editing_out_a_hashtag_drops_the_tag() {
        let conn = test_conn();
        let made = create(
            &conn,
            ThoughtCreate { body: "ship it #urgent".into(), tags: vec![] },
        )
        .unwrap();
        assert_eq!(made.tags, vec!["urgent".to_string()]);

        let edited = update(
            &conn,
            &made.id,
            ThoughtUpdate { body: Some("ship it".into()), tags: None },
        )
        .unwrap();
        assert!(edited.tags.is_empty(), "body is the source of truth for tags");
    }

    #[test]
    fn a_bare_hash_is_not_a_tag() {
        let conn = test_conn();
        let made = create(
            &conn,
            ThoughtCreate { body: "the # sign alone".into(), tags: vec![] },
        )
        .unwrap();
        assert!(made.tags.is_empty());
    }

    #[test]
    fn inline_tags_are_searchable() {
        let conn = test_conn();
        create(
            &conn,
            ThoughtCreate { body: "sourdough notes #recipe".into(), tags: vec![] },
        )
        .unwrap();
        // The tag was never typed as a standalone word, so this only works
        // if extraction ran before the row hit the FTS triggers.
        assert_eq!(search(&conn, "recipe", None, 50, 0).unwrap().len(), 1);
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
    fn delete_removes_the_row_and_writes_a_tombstone() {
        let conn = test_conn();
        let made =
            create(&conn, ThoughtCreate { body: "gone".into(), tags: vec![] }).unwrap();
        delete(&conn, &made.id).unwrap();
        assert!(get_by_id(&conn, &made.id).is_err());

        // Without the tombstone, a paired device would resurrect the row on
        // the next sync instead of dropping its copy.
        let tombstoned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tombstones WHERE id = ?1",
                rusqlite::params![made.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tombstoned, 1);
    }

    #[test]
    fn deleting_a_missing_thought_is_an_error() {
        let conn = test_conn();
        assert!(delete(&conn, "nope").is_err());
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

    use super::{apply_remote, updated_since};
    use crate::sync::types::RemoteThought;

    fn remote(id: &str, body: &str, updated_at: i64) -> RemoteThought {
        RemoteThought {
            id: id.into(),
            body: body.into(),
            tags: vec!["synced".into()],
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn apply_remote_inserts_a_new_thought() {
        let conn = test_conn();
        assert!(apply_remote(&conn, &remote("r1", "from the phone", 100)).unwrap());
        assert_eq!(get_by_id(&conn, "r1").unwrap().body, "from the phone");
    }

    #[test]
    fn apply_remote_is_last_write_wins() {
        let conn = test_conn();
        apply_remote(&conn, &remote("r1", "older", 100)).unwrap();

        assert!(apply_remote(&conn, &remote("r1", "newer", 200)).unwrap());
        assert_eq!(get_by_id(&conn, "r1").unwrap().body, "newer");

        assert!(
            !apply_remote(&conn, &remote("r1", "stale", 150)).unwrap(),
            "an older incoming row must be ignored"
        );
        assert_eq!(get_by_id(&conn, "r1").unwrap().body, "newer");
    }

    #[test]
    fn apply_remote_keeps_the_search_index_current() {
        let conn = test_conn();
        apply_remote(&conn, &remote("r1", "remote sourdough note", 100)).unwrap();
        assert_eq!(search(&conn, "sourdough", None, 50, 0).unwrap().len(), 1);
    }

    #[test]
    fn updated_since_forwards_peer_received_rows() {
        let conn = test_conn();
        // A row received from a peer must still be forwardable to a third
        // device — watermark selection, no origin bookkeeping (issues #1/#2).
        apply_remote(&conn, &remote("r1", "from peer A", 100)).unwrap();
        let pending = updated_since(&conn, 50).unwrap();
        assert_eq!(pending.len(), 1, "clean rows must still be pushed onward");

        assert!(
            updated_since(&conn, 100).unwrap().is_empty(),
            "high-water mark is exclusive"
        );
    }

    #[test]
    fn tombstone_apply_removes_a_thought_and_its_index_entry() {
        let conn = test_conn();
        let made = create(
            &conn,
            ThoughtCreate { body: "delete me sourdough".into(), tags: vec![] },
        )
        .unwrap();

        crate::db::tombstones::apply_remote(&conn, &made.id, crate::models::now_ms())
            .unwrap();

        assert!(get_by_id(&conn, &made.id).is_err(), "row should be gone");
        assert!(
            search(&conn, "sourdough", None, 50, 0).unwrap().is_empty(),
            "FTS index should be gone too"
        );
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
