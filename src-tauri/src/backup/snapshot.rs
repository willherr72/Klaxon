//! Automatic local snapshots.
//!
//! On launch, if the newest snapshot is older than 24 h, copy the live
//! database via SQLite's online-backup API — safe under WAL, where a
//! plain file copy is not — and keep the newest 7. Snapshots are plain
//! SQLite files on purpose: restorable with nothing but a file manager.

use std::path::{Path, PathBuf};

use rusqlite::backup::Backup;
use rusqlite::Connection;

use crate::error::{AppError, AppResult};

pub const SNAPSHOT_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;
pub const SNAPSHOT_KEEP: usize = 7;

/// Millis timestamp of the newest snapshot, parsed from the filename
/// (`klaxon-<ms>.db`). Filename-carried so it survives copy tools that
/// rewrite file mtimes.
pub fn latest_snapshot_ms(backups_dir: &Path) -> Option<i64> {
    std::fs::read_dir(backups_dir)
        .ok()?
        .flatten()
        .filter_map(|e| parse_snapshot_ms(&e.file_name().to_string_lossy()))
        .max()
}

fn parse_snapshot_ms(name: &str) -> Option<i64> {
    name.strip_prefix("klaxon-")?.strip_suffix(".db")?.parse().ok()
}

/// Take a snapshot if the newest one is older than the interval.
/// Uses SQLite's online-backup API: consistent even mid-write under WAL.
pub fn snapshot_if_due(
    conn: &Connection,
    backups_dir: &Path,
    now_ms: i64,
) -> AppResult<Option<PathBuf>> {
    if let Some(last) = latest_snapshot_ms(backups_dir) {
        if now_ms - last <= SNAPSHOT_INTERVAL_MS {
            return Ok(None);
        }
    }
    std::fs::create_dir_all(backups_dir)
        .map_err(|e| AppError::Invalid(format!("create backups dir: {e}")))?;

    let dest_path = backups_dir.join(format!("klaxon-{now_ms}.db"));
    let mut dest = Connection::open(&dest_path)?;
    {
        let bk = Backup::new(conn, &mut dest)?;
        bk.run_to_completion(64, std::time::Duration::from_millis(5), None)?;
    }
    drop(dest);

    rotate(backups_dir);
    log::info!("snapshot written: {}", dest_path.display());
    Ok(Some(dest_path))
}

/// Delete all but the newest SNAPSHOT_KEEP snapshots. Best-effort: a
/// failed delete is logged, never fatal.
fn rotate(backups_dir: &Path) {
    let mut stamps: Vec<i64> = std::fs::read_dir(backups_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| parse_snapshot_ms(&e.file_name().to_string_lossy()))
        .collect();
    stamps.sort_unstable_by(|a, b| b.cmp(a)); // newest first
    for stale in stamps.into_iter().skip(SNAPSHOT_KEEP) {
        let p = backups_dir.join(format!("klaxon-{stale}.db"));
        if let Err(e) = std::fs::remove_file(&p) {
            log::warn!("snapshot rotation: {}: {e}", p.display());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db(dir: &std::path::Path) -> rusqlite::Connection {
        let conn = crate::db::open(&dir.join("klaxon.db")).unwrap();
        conn.execute(
            "INSERT INTO thoughts (id, body, tags, created_at, updated_at)
             VALUES ('t1', 'snapshot me', '[]', 1, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn tmp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("klx-snap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn first_snapshot_is_always_due_and_openable() {
        let dir = tmp();
        let conn = test_db(&dir);
        let out = snapshot_if_due(&conn, &dir.join("backups"), 1_000_000).unwrap();
        let path = out.expect("no prior snapshot → due");

        // The copy must be a valid database containing the source rows.
        let copy = rusqlite::Connection::open(&path).unwrap();
        let n: i64 = copy
            .query_row("SELECT COUNT(*) FROM thoughts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        drop(copy);
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fresh_snapshot_suppresses_the_next_for_24h() {
        let dir = tmp();
        let conn = test_db(&dir);
        let backups = dir.join("backups");
        snapshot_if_due(&conn, &backups, 1_000_000).unwrap().unwrap();

        let hour_later = 1_000_000 + 3_600_000;
        assert!(
            snapshot_if_due(&conn, &backups, hour_later).unwrap().is_none(),
            "not due an hour later"
        );

        let day_later = 1_000_000 + SNAPSHOT_INTERVAL_MS + 1;
        assert!(
            snapshot_if_due(&conn, &backups, day_later).unwrap().is_some(),
            "due after the interval"
        );
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotation_keeps_exactly_the_newest_seven() {
        let dir = tmp();
        let conn = test_db(&dir);
        let backups = dir.join("backups");
        // 10 snapshots, one "day" apart.
        for i in 0..10i64 {
            snapshot_if_due(&conn, &backups, 1_000_000 + i * (SNAPSHOT_INTERVAL_MS + 1))
                .unwrap()
                .unwrap();
        }
        let count = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(count, SNAPSHOT_KEEP, "rotation must cap the set");
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
