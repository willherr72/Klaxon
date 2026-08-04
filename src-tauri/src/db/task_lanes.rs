//! Swim-lane storage for the Tasks board (v0.3.1).
//!
//! Each silent reminder belongs to exactly one lane via
//! `reminders.task_lane_id`. Lanes themselves are first-class rows so the
//! user can create/rename/reorder/delete them.
//!
//! Sync semantics mirror reminders: `updated_at` is the LWW clock, the
//! `updated_at` watermarks carry sync selection, and lane
//! deletes write to the shared `tombstones` table so peers learn to
//! drop their copy.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// Deterministic UUID for the seed `Todo` lane — see migration 008.
/// Hardcoded so two freshly-upgraded devices converge on a single
/// default lane after their first sync.
pub const DEFAULT_LANE_ID: &str = "00000000-0000-4000-8000-000000000001";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lane {
    pub id: String,
    pub name: String,
    pub order_index: i64,
    pub is_default: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<Lane>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, order_index, is_default, created_at, updated_at
         FROM task_lanes
         ORDER BY order_index ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Lane {
            id: r.get(0)?,
            name: r.get(1)?,
            order_index: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Option<Lane>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, order_index, is_default, created_at, updated_at
         FROM task_lanes WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |r| {
        Ok(Lane {
            id: r.get(0)?,
            name: r.get(1)?,
            order_index: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    if let Some(row) = rows.next() {
        Ok(Some(row?))
    } else {
        Ok(None)
    }
}

pub fn default_lane(conn: &Connection) -> AppResult<Lane> {
    // The `is_default = 1` row is guaranteed by migration 008.
    let mut stmt = conn.prepare(
        "SELECT id, name, order_index, is_default, created_at, updated_at
         FROM task_lanes WHERE is_default = 1 LIMIT 1",
    )?;
    Ok(stmt.query_row([], |r| {
        Ok(Lane {
            id: r.get(0)?,
            name: r.get(1)?,
            order_index: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?)
}

/// Insert a brand-new lane (caller picks a fresh UUID); `updated_at` makes
/// the next sync push includes it.
pub fn insert(conn: &Connection, lane: &Lane) -> AppResult<()> {
    conn.execute(
        "INSERT INTO task_lanes
            (id, name, order_index, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            lane.id,
            lane.name,
            lane.order_index,
            if lane.is_default { 1 } else { 0 },
            lane.created_at,
            lane.updated_at,
        ],
    )?;
    Ok(())
}

/// Update an existing lane's mutable fields. Bumps `updated_at` and
/// bumps `updated_at` so the change pushes on the next sync tick.
pub fn update(
    conn: &Connection,
    id: &str,
    name: &str,
    order_index: i64,
    updated_at: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE task_lanes
            SET name = ?2,
                order_index = ?3,
                updated_at = ?4
          WHERE id = ?1",
        params![id, name, order_index, updated_at],
    )?;
    Ok(())
}

/// Apply a lane that arrived over sync. Last-write-wins by
/// `updated_at`; older incoming rows are ignored. New rows insert; the
/// the wire value is accepted as
/// canonical.
pub fn apply_remote(conn: &Connection, lane: &Lane) -> AppResult<bool> {
    let existing_updated: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM task_lanes WHERE id = ?1",
            params![lane.id],
            |r| r.get(0),
        )
        .ok();
    if let Some(existing) = existing_updated {
        if lane.updated_at <= existing {
            return Ok(false);
        }
    }
    conn.execute(
        "INSERT INTO task_lanes
            (id, name, order_index, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            order_index = excluded.order_index,
            updated_at = excluded.updated_at",
        params![
            lane.id,
            lane.name,
            lane.order_index,
            if lane.is_default { 1 } else { 0 },
            lane.created_at,
            lane.updated_at,
        ],
    )?;
    Ok(true)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM task_lanes WHERE id = ?1", params![id])?;
    Ok(())
}

/// Lanes to push to a peer, by the per-peer high-water mark.
///
/// Selection is by watermark alone (issues #1/#2): a lane learned
/// from one peer never forwarded to a second — tasks arriving on a third
/// device pointed at a lane it didn't have. The cost is one idempotent
/// echo back to the sender, same as reminders and thoughts.
pub fn updated_since(conn: &Connection, since: i64) -> AppResult<Vec<Lane>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, order_index, is_default, created_at, updated_at
         FROM task_lanes
         WHERE updated_at > ?1
         ORDER BY updated_at ASC",
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok(Lane {
            id: r.get(0)?,
            name: r.get(1)?,
            order_index: r.get(2)?,
            is_default: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Mark a lane clean — called after a successful push.
#[allow(dead_code)]

#[cfg(test)]
mod tests {
    use super::{apply_remote, updated_since, Lane};

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    /// Issue #1 regression: a lane received from peer A lands clean
    /// but must still be pushed onward to peer B — otherwise a
    /// task syncing to a third device points at a lane that device never
    /// receives.
    #[test]
    fn received_lanes_still_forward_to_other_peers() {
        let conn = test_conn();
        apply_remote(
            &conn,
            &Lane {
                id: "lane-from-phone".into(),
                name: "Errands".into(),
                order_index: 5,
                is_default: false,
                created_at: 100,
                updated_at: 100,
            },
        )
        .unwrap();

        let pending: Vec<_> = updated_since(&conn, 50)
            .unwrap()
            .into_iter()
            .filter(|l| l.id == "lane-from-phone")
            .collect();
        assert_eq!(pending.len(), 1, "clean lanes must still forward");

        assert!(
            updated_since(&conn, 100)
                .unwrap()
                .iter()
                .all(|l| l.id != "lane-from-phone"),
            "high-water mark is exclusive"
        );
    }
}
