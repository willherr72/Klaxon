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
    // 010 — sync reliability (v0.5.1 M1).
    //
    // `endpoint_addrs` is the peer's last-known-good iroh addresses
    // (JSON Vec<TransportAddr>: direct socket addrs + relay URL), seeded
    // into Endpoint::connect() so the first dial after launch aims at a
    // concrete target instead of waiting on iroh's address lookup — which
    // we have watched fail ("Address Lookup failed" in the logs).
    //
    // `last_sync_ok_at` / `last_sync_error{,_at}` drive the per-peer
    // status in Sync settings: evidence, not vibes.
    r#"
    ALTER TABLE peers ADD COLUMN endpoint_addrs TEXT;
    ALTER TABLE peers ADD COLUMN addrs_updated_at INTEGER;
    ALTER TABLE peers ADD COLUMN last_sync_ok_at INTEGER;
    ALTER TABLE peers ADD COLUMN last_sync_error TEXT;
    ALTER TABLE peers ADD COLUMN last_sync_error_at INTEGER;
    "#,
    // 011 — cold alarms (v0.6): ring-once memory for late arrivals.
    //
    // "Ring if recently due" is the first arming rule that isn't
    // naturally idempotent — an immediately-firing entry would re-fire
    // on every reconcile. This table remembers (reminder, fire time)
    // pairs this device has armed. Deliberately DEVICE-LOCAL and never
    // synced: whether this phone rang is not shared state.
    r#"
    CREATE TABLE armed_alarms (
        reminder_id TEXT NOT NULL,
        fire_at_ms  INTEGER NOT NULL,
        armed_at    INTEGER NOT NULL,
        PRIMARY KEY (reminder_id, fire_at_ms)
    );
    "#,
    // 012 — v0.7.1: peer app-version exchange (Hello RPC). NULL means
    // "never learned": a pre-0.7.1 peer, or no sync since this device
    // upgraded. Surfaced in Settings as version + outdated warnings.
    "ALTER TABLE peers ADD COLUMN last_app_version TEXT;",
    // 013 — v0.7.2: the dirty flag is vestigial. Since the issue-#1 fix,
    // every synced table is selected by updated_at/deleted_at against
    // per-peer cursors — which IS the per-peer forwarding state (#2).
    // Partial indexes referencing the column must go first: SQLite
    // refuses DROP COLUMN while an index mentions it.
    r#"
    DROP INDEX IF EXISTS idx_reminders_dirty;
    DROP INDEX IF EXISTS idx_tombstones_dirty;
    DROP INDEX IF EXISTS idx_task_lanes_dirty;
    DROP INDEX IF EXISTS idx_thoughts_dirty;
    ALTER TABLE reminders  DROP COLUMN dirty;
    ALTER TABLE tombstones DROP COLUMN dirty;
    ALTER TABLE task_lanes DROP COLUMN dirty;
    ALTER TABLE thoughts   DROP COLUMN dirty;
    "#,
    // 014 — v0.8: persistent manual card order on the Tasks board.
    //
    // Lanes render ascending by task_sort_key (smallest on top). Drops
    // write a midpoint between the new neighbors, so one row changes
    // per drag. Backfill follows the pre-0.8 visible order
    // (updated_at DESC) so the board looks identical after upgrade.
    // NULL on non-task rows.
    r#"
    ALTER TABLE reminders ADD COLUMN task_sort_key REAL;

    UPDATE reminders SET task_sort_key = (
        SELECT rn * 1024.0 FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY task_lane_id
                ORDER BY updated_at DESC, id
            ) AS rn
            FROM reminders WHERE task_lane_id IS NOT NULL
        ) ranked WHERE ranked.id = reminders.id
    )
    WHERE task_lane_id IS NOT NULL;
    "#,
];

pub fn run(conn: &Connection) -> AppResult<()> {
    run_list(conn, MIGRATIONS)
}

/// Apply every migration newer than the recorded schema version.
///
/// Split from `run` so tests can drive it with a synthetic list — the real
/// `MIGRATIONS` are append-only and can't express "this one fails".
///
/// Each migration's SQL and its `schema_version` row commit together. They
/// used to be two independent statements, so a process death in between
/// (power loss, OOM kill, Android reaping a background sync) left the
/// schema changed but the version unrecorded — the next launch re-ran the
/// same migration and any `ALTER TABLE ... ADD COLUMN` in it failed
/// permanently with "duplicate column name", with no in-app recovery.
/// SQLite has transactional DDL, so one transaction closes that window.
///
/// Consequence for future migrations: their SQL now runs inside an open
/// transaction, so it must not contain `BEGIN`/`COMMIT` or `VACUUM`, and
/// a `PRAGMA` that only takes effect outside one (`foreign_keys` is the
/// realistic trap — a 12-step table rebuild would need it) will silently
/// no-op rather than error. None of the existing entries do this.
fn run_list(conn: &Connection, migrations: &[&str]) -> AppResult<()> {
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

    for (idx, sql) in migrations.iter().enumerate() {
        let version = (idx + 1) as i64;
        if version <= current {
            continue;
        }
        log::info!("applying migration {version}");
        // `unchecked_transaction` because callers hold only `&Connection`
        // (the app shares one behind a mutex). Dropping it without a commit
        // rolls back, so an error below leaves neither the partial schema
        // change nor the version row.
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version(version) VALUES (?1)",
            [version],
        )?;
        tx.commit()?;
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

    /// Issue #5: a migration and its `schema_version` row must land as one
    /// atomic unit. When the SQL fails part-way, neither the partial schema
    /// change nor the version record may survive — otherwise the next
    /// launch re-runs the same migration and an `ALTER TABLE ... ADD
    /// COLUMN` inside it fails forever with "duplicate column name",
    /// leaving an app that cannot open its own database.
    #[test]
    fn a_failed_migration_rolls_back_and_can_be_retried() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let good = "CREATE TABLE kept (id TEXT PRIMARY KEY);";
        // Valid DDL followed by a statement that fails: the shape of a
        // migration dying half-way through.
        let broken = "CREATE TABLE later (id TEXT PRIMARY KEY);
                      INSERT INTO no_such_table (id) VALUES ('x');";

        assert!(
            super::run_list(&conn, &[good, broken]).is_err(),
            "the broken migration must surface its error"
        );

        let table_count = |name: &str| -> i64 {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap()
        };
        let recorded = |c: &rusqlite::Connection| -> i64 {
            c.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        assert_eq!(table_count("later"), 0, "failed migration's DDL must roll back");
        assert_eq!(recorded(&conn), 1, "only the migration that fully applied is recorded");
        assert_eq!(table_count("kept"), 1, "rollback is scoped to the failing migration");

        // The payoff: a corrected build retries cleanly instead of hitting
        // "table already exists" on the half-applied statement.
        let fixed = "CREATE TABLE later (id TEXT PRIMARY KEY);";
        super::run_list(&conn, &[good, fixed]).unwrap();
        assert_eq!(table_count("later"), 1);
        assert_eq!(recorded(&conn), 2, "retry records the version it applied");
    }

    /// The other half of issue #5, and the half the test above cannot
    /// see: the version row must commit WITH the schema change, not merely
    /// after it. An implementation that committed the DDL and then wrote
    /// the version separately would satisfy every assertion above while
    /// still leaving the crash-in-the-gap window wide open. Force the
    /// version insert itself to fail and require the already-successful
    /// DDL to roll back with it.
    #[test]
    fn the_version_row_commits_with_its_migration() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
             CREATE TRIGGER block_v1 BEFORE INSERT ON schema_version
             WHEN new.version = 1 BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;",
        )
        .unwrap();

        assert!(
            super::run_list(&conn, &["CREATE TABLE t (id TEXT PRIMARY KEY);"]).is_err(),
            "the blocked version insert must surface its error"
        );

        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 't'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            tables, 0,
            "DDL must roll back when recording its version fails"
        );
    }

    fn fts_hits(conn: &rusqlite::Connection, term: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM thoughts_fts WHERE thoughts_fts MATCH ?1",
            [term],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Migration 010: the sync loop records per-peer outcomes and
    /// last-known-good addresses. A success must clear a previous error —
    /// stale failure text in Settings would read as "still broken".
    #[test]
    fn migration_010_peer_sync_state_roundtrips() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO peers (id, name, shared_secret, created_at)
             VALUES ('p1', 'Phone', 's3cret', 1)",
            [],
        )
        .unwrap();

        crate::db::peers::record_sync_err(&conn, "p1", "dial timed out", 100).unwrap();
        let p = crate::db::peers::list_all(&conn)
            .unwrap()
            .into_iter()
            .find(|p| p.id == "p1")
            .unwrap();
        assert_eq!(p.last_sync_error.as_deref(), Some("dial timed out"));
        assert_eq!(p.last_sync_error_at, Some(100));

        crate::db::peers::record_sync_ok(&conn, "p1", Some("[\"fake-addr\"]"), 200).unwrap();
        let p = crate::db::peers::list_all(&conn)
            .unwrap()
            .into_iter()
            .find(|p| p.id == "p1")
            .unwrap();
        assert_eq!(p.last_sync_ok_at, Some(200));
        assert_eq!(p.endpoint_addrs_json.as_deref(), Some("[\"fake-addr\"]"));
        assert!(p.last_sync_error.is_none(), "success must clear the error");
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

    /// Migration 014: tasks get gapped sort keys per lane, assigned in
    /// the pre-migration visible order (updated_at DESC) — the board
    /// must not visibly reshuffle on upgrade. Runs all migrations
    /// EXCEPT the last, seeds rows, then applies the last one.
    #[test]
    fn migration_014_backfills_sort_keys_in_visible_order() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);",
        )
        .unwrap();
        for (idx, sql) in super::MIGRATIONS
            .iter()
            .enumerate()
            .take(super::MIGRATIONS.len() - 1)
        {
            conn.execute_batch(sql).unwrap();
            conn.execute(
                "INSERT INTO schema_version(version) VALUES (?1)",
                [(idx + 1) as i64],
            )
            .unwrap();
        }
        // Three tasks in the seed Todo lane. r1 is newest → today it
        // renders on top → it must get the smallest key.
        for (id, up) in [("r1", 3000), ("r2", 2000), ("r3", 1000)] {
            conn.execute(
                "INSERT INTO reminders
                 (id, title, due_at, priority, state, created_at, updated_at, silent, tags, task_lane_id)
                 VALUES (?1, 'task', 0, 1, 'pending', 1, ?2, 1, '[]',
                         '00000000-0000-4000-8000-000000000001')",
                rusqlite::params![id, up],
            )
            .unwrap();
        }
        // A non-task reminder must stay NULL.
        conn.execute(
            "INSERT INTO reminders
             (id, title, due_at, priority, state, created_at, updated_at, silent, tags)
             VALUES ('ring', 'rings', 0, 1, 'pending', 1, 1, 0, '[]')",
            [],
        )
        .unwrap();

        super::run(&conn).unwrap();

        let key = |id: &str| -> Option<f64> {
            conn.query_row(
                "SELECT task_sort_key FROM reminders WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(key("r1"), Some(1024.0));
        assert_eq!(key("r2"), Some(2048.0));
        assert_eq!(key("r3"), Some(3072.0));
        assert_eq!(key("ring"), None, "non-tasks keep NULL");
    }
}
