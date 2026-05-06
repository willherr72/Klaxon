use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tombstone {
    pub id: String,
    pub deleted_at: i64,
    pub dirty: bool,
}

pub fn create(conn: &Connection, id: &str, deleted_at: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO tombstones (id, deleted_at, dirty) VALUES (?1, ?2, 1)
         ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, dirty = 1",
        params![id, deleted_at],
    )?;
    Ok(())
}

pub fn dirty_since(conn: &Connection, since_ms: i64) -> AppResult<Vec<Tombstone>> {
    let mut stmt = conn.prepare(
        "SELECT id, deleted_at, dirty FROM tombstones
         WHERE dirty = 1 AND deleted_at > ?1
         ORDER BY deleted_at ASC",
    )?;
    let rows = stmt.query_map(params![since_ms], |r| {
        Ok(Tombstone {
            id: r.get(0)?,
            deleted_at: r.get(1)?,
            dirty: {
                let n: i32 = r.get(2)?;
                n != 0
            },
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
        "INSERT INTO tombstones (id, deleted_at, dirty) VALUES (?1, ?2, 0)
         ON CONFLICT(id) DO UPDATE SET
           deleted_at = MAX(tombstones.deleted_at, excluded.deleted_at)",
        params![id, deleted_at],
    )?;
    // And remove the live row if it exists and is older.
    conn.execute(
        "DELETE FROM reminders WHERE id = ?1 AND updated_at <= ?2",
        params![id, deleted_at],
    )?;
    Ok(())
}
