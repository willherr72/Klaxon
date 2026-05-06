use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::error::AppResult;

pub fn ensure_defaults(conn: &Connection) -> AppResult<()> {
    let defaults: &[(&str, &str)] = &[
        ("repeat_count_low", "1"),
        ("repeat_count_normal", "5"),
        ("repeat_count_high", "30"),
        ("repeat_interval_secs_low", "0"),
        ("repeat_interval_secs_normal", "8"),
        ("repeat_interval_secs_high", "4"),
        ("default_sound_low", ""),
        ("default_sound_normal", ""),
        ("default_sound_high", ""),
        ("autostart_enabled", "false"),
        ("theme", "industrial"),
        ("global_hotkey_new", "Ctrl+Alt+KeyN"),
    ];

    for (k, v) in defaults {
        conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES (?1, ?2)",
            params![k, v],
        )?;
    }
    Ok(())
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query_map(params![key], |r| r.get::<_, String>(0))?;
    Ok(rows.next().transpose()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn list_all(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = HashMap::new();
    for r in rows {
        let (k, v) = r?;
        out.insert(k, v);
    }
    Ok(out)
}
