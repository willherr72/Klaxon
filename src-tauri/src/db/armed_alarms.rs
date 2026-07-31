//! Ring-once memory for the alarm planner. Device-local; never synced.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::error::AppResult;

pub fn armed_set(conn: &Connection) -> AppResult<HashSet<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT reminder_id, fire_at_ms FROM armed_alarms")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r?);
    }
    Ok(out)
}

pub fn log_armed(conn: &Connection, pairs: &[(String, i64)], now: i64) -> AppResult<()> {
    for (id, at) in pairs {
        conn.execute(
            "INSERT OR IGNORE INTO armed_alarms (reminder_id, fire_at_ms, armed_at)
             VALUES (?1, ?2, ?3)",
            params![id, at, now],
        )?;
    }
    Ok(())
}

/// Drop rows whose (reminder, fire time) is no longer live — the
/// reminder is gone, or its fire time moved (snooze/recurrence).
pub fn prune(conn: &Connection, live: &HashSet<(String, i64)>) -> AppResult<()> {
    let existing = armed_set(conn)?;
    for (id, at) in existing.difference(live) {
        conn.execute(
            "DELETE FROM armed_alarms WHERE reminder_id = ?1 AND fire_at_ms = ?2",
            params![id, at],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn log_read_prune_roundtrip() {
        let conn = test_conn();
        log_armed(&conn, &[("a".into(), 100), ("b".into(), 200)], 1).unwrap();
        // Double-log is a no-op, not an error.
        log_armed(&conn, &[("a".into(), 100)], 2).unwrap();
        assert_eq!(armed_set(&conn).unwrap().len(), 2);

        let mut live = std::collections::HashSet::new();
        live.insert(("a".to_string(), 100i64));
        prune(&conn, &live).unwrap();
        let left = armed_set(&conn).unwrap();
        assert_eq!(left.len(), 1);
        assert!(left.contains(&("a".to_string(), 100)));
    }
}
