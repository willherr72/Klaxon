//! Restore staging. Import never touches live files: the decrypted
//! payload lands in `restore-staging/` with a marker, and the swap runs
//! on the next boot before the database opens. The displaced files go to
//! `restore-undo/` — one level of oops.

use std::path::Path;

use crate::backup::container::BackupPayload;
use crate::error::{AppError, AppResult};

const STAGING: &str = "restore-staging";
const UNDO: &str = "restore-undo";
const MARKER: &str = "restore-staging/READY";

pub fn staged_pending(app_dir: &Path) -> bool {
    app_dir.join(MARKER).exists()
}

/// Write the decrypted payload to staging. Live files untouched.
pub fn stage(app_dir: &Path, payload: &BackupPayload) -> AppResult<()> {
    let staging = app_dir.join(STAGING);
    std::fs::create_dir_all(&staging)
        .map_err(|e| AppError::Invalid(format!("create staging: {e}")))?;
    std::fs::write(staging.join("klaxon.db"), &payload.db)
        .map_err(|e| AppError::Invalid(format!("stage db: {e}")))?;
    std::fs::write(staging.join("klaxon-iroh-secret.bin"), &payload.iroh_secret)
        .map_err(|e| AppError::Invalid(format!("stage secret: {e}")))?;
    // Marker last: an interrupted stage leaves no marker → no swap.
    std::fs::write(app_dir.join(MARKER), b"1")
        .map_err(|e| AppError::Invalid(format!("stage marker: {e}")))?;
    Ok(())
}

/// Boot-time swap. Call BEFORE db::open. Returns whether a restore ran.
pub fn apply_staged_if_any(app_dir: &Path) -> AppResult<bool> {
    if !staged_pending(app_dir) {
        return Ok(false);
    }
    let staging = app_dir.join(STAGING);
    // A restore rewinds revision numbers. Prepare a fresh delivery history
    // before replacing live files, so a crash cannot expose the old epoch.
    // Also handles a READY directory staged by a pre-v0.10.3 app.
    {
        let conn = crate::db::open(&staging.join("klaxon.db"))?;
        crate::db::sync_log::reset_after_restore(&conn)?;
        // All preparation must be in the main file before it is renamed.
        conn.pragma_update(None, "journal_mode", "DELETE")?;
    }
    let undo = app_dir.join(UNDO);
    std::fs::create_dir_all(&undo).map_err(|e| AppError::Invalid(format!("create undo: {e}")))?;

    for name in ["klaxon.db", "klaxon-iroh-secret.bin"] {
        let live = app_dir.join(name);
        if live.exists() {
            // Overwrite any previous undo copy — one level of oops.
            let _ = std::fs::remove_file(undo.join(name));
            std::fs::rename(&live, undo.join(name))
                .map_err(|e| AppError::Invalid(format!("undo {name}: {e}")))?;
        }
        // WAL/SHM sidecars of a moved db are stale — remove, not move.
        if name == "klaxon.db" {
            let _ = std::fs::remove_file(app_dir.join("klaxon.db-wal"));
            let _ = std::fs::remove_file(app_dir.join("klaxon.db-shm"));
        }
        std::fs::rename(staging.join(name), &live)
            .map_err(|e| AppError::Invalid(format!("restore {name}: {e}")))?;
    }
    let _ = std::fs::remove_file(app_dir.join(MARKER));
    let _ = std::fs::remove_dir_all(&staging);
    log::info!("restore applied; previous files in {}", undo.display());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::container::{BackupManifest, BackupPayload};

    fn tmp() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("klx-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn payload() -> BackupPayload {
        let source = tmp();
        let path = source.join("payload.db");
        drop(crate::db::open(&path).unwrap());
        let db = std::fs::read(path).unwrap();
        std::fs::remove_dir_all(source).unwrap();
        BackupPayload {
            manifest: BackupManifest {
                schema_version: 1,
                app_version: "0.5.1".into(),
                device_name: "old-laptop".into(),
                created_ms: 1,
            },
            db,
            iroh_secret: b"NEW-SECRET-32-BYTES-PADDED......".to_vec(),
        }
    }

    #[test]
    fn restoring_a_database_starts_a_new_delivery_history() {
        let source = tmp();
        let db_path = source.join("klaxon.db");
        let conn = crate::db::open(&db_path).unwrap();
        let before = crate::db::sync_log::snapshot(&conn, None).unwrap().cursor;
        conn.execute("INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','phone','preserved',1)", []).unwrap();
        drop(conn);
        let mut backup = payload();
        backup.db = std::fs::read(&db_path).unwrap();
        let dest = tmp();
        stage(&dest, &backup).unwrap();
        apply_staged_if_any(&dest).unwrap();
        let restored = crate::db::open(&dest.join("klaxon.db")).unwrap();
        let after = crate::db::sync_log::snapshot(&restored, None)
            .unwrap()
            .cursor;
        assert_ne!(
            before.epoch, after.epoch,
            "restored revision numbers must not reuse the prior delivery history"
        );
        let secret: String = restored
            .query_row("SELECT shared_secret FROM peers WHERE id='p'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(secret, "preserved");
        drop(restored);
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(dest).unwrap();
    }

    #[test]
    fn swap_replaces_live_files_and_keeps_undo() {
        let dir = tmp();
        std::fs::write(dir.join("klaxon.db"), b"OLD-DB").unwrap();
        std::fs::write(dir.join("klaxon-iroh-secret.bin"), b"OLD-SECRET").unwrap();

        stage(&dir, &payload()).unwrap();
        assert!(staged_pending(&dir));
        assert!(apply_staged_if_any(&dir).unwrap(), "swap should run");

        let restored = crate::db::open(&dir.join("klaxon.db")).unwrap();
        assert!(
            crate::db::sync_log::snapshot(&restored, None)
                .unwrap()
                .changes
                .lanes
                .len()
                > 0
        );
        drop(restored);
        assert_eq!(
            std::fs::read(dir.join("restore-undo").join("klaxon.db")).unwrap(),
            b"OLD-DB",
            "previous db must survive in undo"
        );
        assert!(!staged_pending(&dir), "marker cleared");
        assert!(
            !apply_staged_if_any(&dir).unwrap(),
            "second boot is a no-op"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_marker_means_no_swap() {
        let dir = tmp();
        std::fs::write(dir.join("klaxon.db"), b"OLD-DB").unwrap();
        assert!(!apply_staged_if_any(&dir).unwrap());
        assert_eq!(std::fs::read(dir.join("klaxon.db")).unwrap(), b"OLD-DB");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fresh_install_swap_works_without_existing_files() {
        // Restoring onto a brand-new device: nothing to move to undo.
        let dir = tmp();
        stage(&dir, &payload()).unwrap();
        assert!(apply_staged_if_any(&dir).unwrap());
        let restored = crate::db::open(&dir.join("klaxon.db")).unwrap();
        assert!(
            crate::db::sync_log::snapshot(&restored, None)
                .unwrap()
                .changes
                .lanes
                .len()
                > 0
        );
        drop(restored);
        std::fs::remove_dir_all(&dir).ok();
    }
}
