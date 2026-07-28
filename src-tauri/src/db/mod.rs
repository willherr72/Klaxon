pub mod migrations;
pub mod peers;
pub mod reminders;
pub mod settings;
pub mod task_lanes;
pub mod thoughts;
pub mod tombstones;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    // Two processes write this file on Android: the app, and the share
    // activity that receives an Android share while the app may be cold.
    // Without a busy timeout the loser of a race fails immediately with
    // SQLITE_BUSY rather than waiting for the other's transaction.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    migrations::run(&conn)?;
    settings::ensure_defaults(&conn)?;

    Ok(conn)
}
