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
