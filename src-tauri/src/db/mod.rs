pub mod migrations;
pub mod peers;
pub mod reminders;
pub mod settings;
pub mod task_lanes;
pub mod tombstones;

use std::path::Path;

use rusqlite::Connection;

use crate::error::AppResult;

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;

    migrations::run(&conn)?;
    settings::ensure_defaults(&conn)?;

    Ok(conn)
}
