use rusqlite::Connection;

use crate::error::AppResult;

const MIGRATIONS: &[&str] = &[
    // 001 — initial schema
    r#"
    CREATE TABLE reminders (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT,
        due_at          INTEGER NOT NULL,
        priority        INTEGER NOT NULL,
        sound_path      TEXT,
        repeat_rule     TEXT,
        state           TEXT NOT NULL,
        snooze_until    INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        source          TEXT NOT NULL DEFAULT 'local',
        external_id     TEXT,
        last_synced_at  INTEGER,
        dirty           INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX idx_reminders_pending_due
        ON reminders(due_at) WHERE state = 'pending';

    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE sync_state (
        peer_id       TEXT PRIMARY KEY,
        last_pull_at  INTEGER NOT NULL,
        last_push_at  INTEGER NOT NULL
    );
    "#,
    // 002 — sync foundation: peers + tombstones
    r#"
    DROP TABLE IF EXISTS sync_state;

    CREATE TABLE peers (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        url             TEXT NOT NULL,
        shared_secret   TEXT NOT NULL,
        last_pull_at    INTEGER NOT NULL DEFAULT 0,
        last_push_at    INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL,
        last_seen_at    INTEGER
    );

    CREATE TABLE tombstones (
        id              TEXT PRIMARY KEY,
        deleted_at      INTEGER NOT NULL,
        dirty           INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_reminders_dirty ON reminders(updated_at) WHERE dirty = 1;
    CREATE INDEX idx_tombstones_dirty ON tombstones(deleted_at) WHERE dirty = 1;
    "#,
    // 003 — TLS: pinned cert fingerprint per peer
    r#"
    ALTER TABLE peers ADD COLUMN cert_fingerprint TEXT;
    "#,
    // 004 — silent "task" reminders that don't trigger the alarm
    r#"
    ALTER TABLE reminders ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
    "#,
    // 005 — tags: comma-free labels stored as a JSON array of lowercase strings
    r#"
    ALTER TABLE reminders ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
    "#,
    // 006 — v0.3 iroh transport: each peer has a stable iroh EndpointId
    // (Ed25519 pubkey, base32 string). Captured during pairing alongside
    // the existing TLS cert fingerprint so the LAN HTTPS path keeps
    // working until the cutover. Nullable for graceful upgrade from v0.2
    // (where peers paired before iroh existed and have no node_id).
    r#"
    ALTER TABLE peers ADD COLUMN iroh_node_id TEXT;
    "#,
    // 007 — drop the v0.2 HTTPS transport columns now that iroh is the
    // only transport. Peers with no `iroh_node_id` after this migration
    // will simply fail to sync until re-paired.
    r#"
    ALTER TABLE peers DROP COLUMN url;
    ALTER TABLE peers DROP COLUMN cert_fingerprint;
    "#,
    // 008 — v0.3.1 swim-lane Tasks board.
    //
    // Each silent "task" reminder belongs to a user-defined lane. Lanes
    // are first-class rows so the user can create / rename / reorder /
    // delete them, and so the set syncs between paired devices.
    //
    // The seed `Todo` lane has a deterministic UUID — when two devices
    // both upgrade to v0.3.1 they create rows with the same `id`, so
    // their first sync resolves to a single Todo lane via the usual
    // last-write-wins semantics instead of producing two duplicates.
    //
    // `is_default = 1` marks the cascade target for lane deletion (the
    // user can rename the default lane but not delete it). All existing
    // silent reminders get pointed at it as part of the migration.
    r#"
    CREATE TABLE task_lanes (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        order_index  INTEGER NOT NULL,
        is_default   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        dirty        INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX idx_task_lanes_order ON task_lanes(order_index);
    CREATE INDEX idx_task_lanes_dirty ON task_lanes(updated_at) WHERE dirty = 1;

    ALTER TABLE reminders ADD COLUMN task_lane_id TEXT;

    INSERT INTO task_lanes
        (id, name, order_index, is_default, created_at, updated_at, dirty)
    VALUES (
        '00000000-0000-4000-8000-000000000001',
        'Todo',
        0,
        1,
        unixepoch() * 1000,
        unixepoch() * 1000,
        1
    );

    UPDATE reminders
       SET task_lane_id = '00000000-0000-4000-8000-000000000001'
     WHERE silent = 1;
    "#,
    // 009 — Thoughts: a permanent, tag-organized, searchable idea feed.
    //
    // Deliberately its own table rather than a third mode on `reminders`:
    // a thought has no time and no lifecycle, and keeping it out of
    // `reminders` means the scheduler structurally cannot ring one.
    //
    // `thoughts_fts` is an FTS5 external-content index — it stores no copy
    // of the text, just the inverted index, and the three triggers below
    // keep it in step with the base table. Because they are SQL triggers
    // rather than Rust code, writes applied by sync maintain the index
    // exactly as local edits do.
    //
    // `dirty` is carried for symmetry with reminders/lanes and set on
    // write, but no query filters on it: the push path selects on the
    // per-peer high-water mark. See issue #1 — lanes and tombstones do
    // filter on `dirty`, which stops rows forwarding past the peer that
    // received them. Thoughts deliberately do not inherit that.
    r#"
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
        body,
        tags,
        content='thoughts',
        content_rowid='rowid'
    );

    CREATE TRIGGER thoughts_ai AFTER INSERT ON thoughts BEGIN
        INSERT INTO thoughts_fts(rowid, body, tags)
        VALUES (new.rowid, new.body, new.tags);
    END;

    CREATE TRIGGER thoughts_ad AFTER DELETE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, body, tags)
        VALUES ('delete', old.rowid, old.body, old.tags);
    END;

    CREATE TRIGGER thoughts_au AFTER UPDATE ON thoughts BEGIN
        INSERT INTO thoughts_fts(thoughts_fts, rowid, body, tags)
        VALUES ('delete', old.rowid, old.body, old.tags);
        INSERT INTO thoughts_fts(rowid, body, tags)
        VALUES (new.rowid, new.body, new.tags);
    END;
    "#,
];

pub fn run(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
    )?;

    let current: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    for (idx, sql) in MIGRATIONS.iter().enumerate() {
        let version = (idx + 1) as i64;
        if version <= current {
            continue;
        }
        log::info!("applying migration {version}");
        conn.execute_batch(sql)?;
        conn.execute(
            "INSERT INTO schema_version(version) VALUES (?1)",
            [version],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        conn
    }

    fn fts_hits(conn: &rusqlite::Connection, term: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM thoughts_fts WHERE thoughts_fts MATCH ?1",
            [term],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The FTS index is external-content, so it only stays correct if the
    /// triggers fire on every write. Insert, update, and delete through the
    /// base table and confirm the index agrees each time.
    #[test]
    fn migration_009_fts_triggers_track_the_base_table() {
        let conn = test_conn();

        conn.execute(
            "INSERT INTO thoughts (id, body, tags, created_at, updated_at)
             VALUES ('t1', 'sourdough starter needs feeding', '[\"recipe\"]', 1, 1)",
            [],
        )
        .unwrap();

        assert_eq!(fts_hits(&conn, "sourdough"), 1, "insert should populate the index");
        // Tags are indexed too — the JSON punctuation tokenizes away.
        assert_eq!(fts_hits(&conn, "recipe"), 1, "tags column should be searchable");

        conn.execute(
            "UPDATE thoughts SET body = 'bread machine broke' WHERE id = 't1'",
            [],
        )
        .unwrap();

        assert_eq!(fts_hits(&conn, "sourdough"), 0, "update must remove old terms");
        assert_eq!(fts_hits(&conn, "bread"), 1, "update must index new terms");

        conn.execute("DELETE FROM thoughts WHERE id = 't1'", []).unwrap();

        assert_eq!(fts_hits(&conn, "bread"), 0, "delete must clear the index row");
    }
}
