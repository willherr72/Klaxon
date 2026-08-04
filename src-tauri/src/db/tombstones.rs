use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tombstone {
    pub id: String,
    pub deleted_at: i64,
}

pub fn create(conn: &Connection, id: &str, deleted_at: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tombstones (id, deleted_at) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at",
        params![id, deleted_at],
    )?;
    Ok(())
}

/// Tombstones to push to a peer, by the per-peer high-water mark.
///
/// Selection is by watermark alone (issues #1/#2): a delete
/// learned from one peer never forwarded to a second — at three devices,
/// a row deleted on the phone stayed alive on the desktop forever. The
/// cost is one idempotent echo back to the sender, same as reminders
/// and thoughts.
pub fn deleted_since(conn: &Connection, since_ms: i64) -> AppResult<Vec<Tombstone>> {
    let mut stmt = conn.prepare(
        "SELECT id, deleted_at FROM tombstones
         WHERE deleted_at > ?1
         ORDER BY deleted_at ASC",
    )?;
    let rows = stmt.query_map(params![since_ms], |r| {
        Ok(Tombstone {
            id: r.get(0)?,
            deleted_at: r.get(1)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn apply_remote(conn: &Connection, id: &str, deleted_at: i64) -> AppResult<()> {
    // Remote tombstones come in clean (we received them, no need to push back).
    conn.execute(
        "INSERT INTO tombstones (id, deleted_at) VALUES (?1, ?2)
         ON CONFLICT(id) DO UPDATE SET
           deleted_at = MAX(tombstones.deleted_at, excluded.deleted_at)",
        params![id, deleted_at],
    )?;
    // And remove the live row if it exists and is older.
    conn.execute(
        "DELETE FROM reminders WHERE id = ?1 AND updated_at <= ?2",
        params![id, deleted_at],
    )?;
    // The tombstones table is shared across entity types — a tombstone id
    // may name a reminder, a lane, or a thought.
    conn.execute(
        "DELETE FROM thoughts WHERE id = ?1 AND updated_at <= ?2",
        params![id, deleted_at],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_remote, deleted_since};

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    /// Issue #1 regression: a tombstone received from peer A lands clean
    /// but must still be pushed onward to peer B — otherwise a
    /// row deleted on the phone stays alive on a third device forever.
    #[test]
    fn received_tombstones_still_forward_to_other_peers() {
        let conn = test_conn();
        apply_remote(&conn, "gone-1", 100).unwrap();

        let pending = deleted_since(&conn, 50).unwrap();
        assert_eq!(pending.len(), 1, "clean tombstones must still forward");

        assert!(
            deleted_since(&conn, 100).unwrap().is_empty(),
            "high-water mark is exclusive"
        );
    }
}
