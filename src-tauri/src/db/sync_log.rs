//! Durable delivery revisions, independent of conflict timestamps.
use super::{day_notes, reminders, task_lanes::Lane, thoughts};
use crate::error::{AppError, AppResult};
use crate::sync::types::{
    ChangeSet, RemoteDayNote, RemoteReminder, RemoteThought, RemoteTombstone,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    pub epoch: String,
    pub revision: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Batch {
    pub cursor: Cursor,
    pub changes: ChangeSet,
}

fn current(conn: &Connection) -> AppResult<Cursor> {
    Ok(conn.query_row("SELECT epoch, COALESCE((SELECT seq FROM sqlite_sequence WHERE name='sync_journal'),0) FROM sync_epoch WHERE singleton=1",[],|r|Ok(Cursor{epoch:r.get(0)?,revision:r.get(1)?}))?)
}

/// Bound both the journal and entity reads to one SQLite snapshot. The
/// returned cursor may be acknowledged after network I/O; later writes
/// always get higher revisions even when their conflict clocks go backwards.
pub fn snapshot(conn: &Connection, since: Option<&Cursor>) -> AppResult<Batch> {
    let tx = conn.unchecked_transaction()?;
    let cursor = current(&tx)?;
    let lower = since
        .filter(|s| s.epoch == cursor.epoch && s.revision >= 0 && s.revision <= cursor.revision)
        .map_or(0, |s| s.revision);
    fn rows<T>(
        conn: &Connection,
        table: &str,
        kind: &str,
        key: &str,
        lower: i64,
        upper: i64,
        map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> AppResult<Vec<T>> {
        let mut stmt=conn.prepare(&format!("SELECT e.* FROM {table} e JOIN sync_journal j ON j.entity_id=e.{key} AND j.kind=?1 WHERE j.revision>?2 AND j.revision<=?3 ORDER BY j.revision"))?;
        let out = stmt
            .query_map(params![kind, lower, upper], map)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(out)
    }
    let upper = cursor.revision;
    let changes = ChangeSet {
        server_time_ms: crate::models::now_ms(),
        reminders: rows(&tx, "reminders", "reminder", "id", lower, upper, |r| {
            Ok(RemoteReminder::from(&reminders::row_to_reminder(r)?))
        })?,
        thoughts: rows(&tx, "thoughts", "thought", "id", lower, upper, |r| {
            Ok(RemoteThought::from(&thoughts::row_to_thought(r)?))
        })?,
        day_notes: rows(&tx, "day_notes", "day_note", "day", lower, upper, |r| {
            Ok(RemoteDayNote::from(&day_notes::row_to_note(r)?))
        })?,
        lanes: rows(&tx, "task_lanes", "lane", "id", lower, upper, |r| {
            Ok(Lane {
                id: r.get("id")?,
                name: r.get("name")?,
                order_index: r.get("order_index")?,
                is_default: r.get::<_, i64>("is_default")? != 0,
                created_at: r.get("created_at")?,
                updated_at: r.get("updated_at")?,
            })
        })?,
        tombstones: rows(&tx, "tombstones", "tombstone", "id", lower, upper, |r| {
            Ok(RemoteTombstone {
                id: r.get("id")?,
                deleted_at: r.get("deleted_at")?,
            })
        })?,
    };
    tx.commit()?;
    Ok(Batch { cursor, changes })
}

pub fn cursors(conn: &Connection, peer: &str) -> AppResult<(Option<Cursor>, Option<Cursor>)> {
    Ok(conn.query_row("SELECT pull_epoch,pull_revision,push_epoch,push_revision FROM sync_peer_cursors WHERE peer_id=?1",[peer],|r|{
        let pull_epoch:Option<String>=r.get(0)?;
        let pull_revision:Option<i64>=r.get(1)?;
        let push_epoch:Option<String>=r.get(2)?;
        let push_revision:Option<i64>=r.get(3)?;
        Ok((pull_epoch.zip(pull_revision).map(|(epoch,revision)|Cursor{epoch,revision}),push_epoch.zip(push_revision).map(|(epoch,revision)|Cursor{epoch,revision})))
    }).optional()?.unwrap_or((None,None)))
}

pub fn mark_pushed(conn: &Connection, peer: &str, cursor: &Cursor) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    let head = current(&tx)?;
    if cursor.epoch != head.epoch || cursor.revision < 0 || cursor.revision > head.revision {
        return Err(AppError::Invalid(
            "invalid local revision acknowledgment".into(),
        ));
    }
    tx.execute("INSERT INTO sync_peer_cursors(peer_id,push_epoch,push_revision) VALUES (?1,?2,?3)
        ON CONFLICT(peer_id) DO UPDATE SET push_epoch=excluded.push_epoch,
        push_revision=CASE WHEN sync_peer_cursors.push_epoch=excluded.push_epoch AND sync_peer_cursors.push_revision<=?4 THEN MAX(COALESCE(sync_peer_cursors.push_revision,0),excluded.push_revision) ELSE excluded.push_revision END",params![peer,cursor.epoch,cursor.revision,head.revision])?;
    tx.execute(
        "UPDATE peers SET last_push_at=?2,last_seen_at=?2 WHERE id=?1",
        params![peer, crate::models::now_ms()],
    )?;
    tx.commit()?;
    Ok(())
}

/// Caller owns the transaction containing the received changes and serializes
/// pulls per peer. Adopt the returned cursor exactly: a restored peer can return
/// a full reconciliation whose head is below its previously acknowledged head.
pub(crate) fn mark_pulled(conn: &Connection, peer: &str, cursor: &Cursor) -> AppResult<()> {
    if cursor.epoch.is_empty() || cursor.revision < 0 {
        return Err(AppError::Invalid("invalid remote revision cursor".into()));
    }
    let (previous, _) = cursors(conn, peer)?;
    let reset = previous
        .as_ref()
        .is_none_or(|old| old.epoch != cursor.epoch || old.revision > cursor.revision);
    if reset {
        // Persist the outbound reset together with this pull. If the later push
        // fails or the process exits, its retry must still resend all local data.
        conn.execute(
            "UPDATE sync_peer_cursors SET push_epoch=NULL,push_revision=NULL WHERE peer_id=?1",
            [peer],
        )?;
    }
    conn.execute(
        "INSERT INTO sync_peer_cursors(peer_id,pull_epoch,pull_revision) VALUES (?1,?2,?3)
        ON CONFLICT(peer_id) DO UPDATE SET pull_epoch=excluded.pull_epoch,
        pull_revision=excluded.pull_revision",
        params![peer, cursor.epoch, cursor.revision],
    )?;
    conn.execute(
        "UPDATE peers SET last_pull_at=?2,last_seen_at=?2 WHERE id=?1",
        params![peer, crate::models::now_ms()],
    )?;
    Ok(())
}

/// Give an explicitly restored database a new delivery identity.
pub fn reset_after_restore(conn: &Connection) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE sync_epoch SET epoch=?1 WHERE singleton=1",
        [uuid::Uuid::new_v4().to_string()],
    )?;
    tx.execute("DELETE FROM sync_peer_cursors", [])?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::{storage, types::RemoteThought};
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }
    fn thought(conn: &Connection, id: &str, clock: i64) {
        crate::db::thoughts::apply_remote(
            conn,
            &RemoteThought {
                id: id.into(),
                body: id.into(),
                tags: vec![],
                created_at: clock,
                updated_at: clock,
            },
        )
        .unwrap();
    }
    #[test]
    fn late_mesh_import_after_nonzero_cursor_forwards_despite_old_clock() {
        let (a, b, c) = (db(), db(), db());
        thought(&b, "recent", 9000);
        let initial = snapshot(&b, None).unwrap();
        storage::apply(&c, &initial.changes).unwrap();
        thought(&a, "late", 2);
        storage::apply(&b, &snapshot(&a, None).unwrap().changes).unwrap();
        let delta = snapshot(&b, Some(&initial.cursor)).unwrap();
        assert_eq!(delta.changes.thoughts.len(), 1);
        assert_eq!(delta.changes.thoughts[0].id, "late");
        storage::apply(&c, &delta.changes).unwrap();
        assert_eq!(
            crate::db::thoughts::get_by_id(&c, "late").unwrap().body,
            "late"
        );
        storage::apply(&b, &delta.changes).unwrap();
        assert_eq!(
            snapshot(&b, Some(&delta.cursor)).unwrap().cursor,
            delta.cursor
        );
    }
    #[test]
    fn snapshot_ack_does_not_skip_writes_during_send_or_clock_rollback() {
        let conn = db();
        conn.execute(
            "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
            [],
        )
        .unwrap();
        thought(&conn, "x", 100);
        let sending = snapshot(&conn, None).unwrap();
        conn.execute("UPDATE thoughts SET body='equal clock' WHERE id='x'", [])
            .unwrap();
        mark_pushed(&conn, "p", &sending.cursor).unwrap();
        let (_, push) = cursors(&conn, "p").unwrap();
        let equal = snapshot(&conn, push.as_ref()).unwrap();
        assert_eq!(equal.changes.thoughts[0].body, "equal clock");
        conn.execute(
            "UPDATE thoughts SET body='clock rollback',updated_at=-2 WHERE id='x'",
            [],
        )
        .unwrap();
        let rollback = snapshot(&conn, Some(&equal.cursor)).unwrap();
        assert_eq!(rollback.changes.thoughts[0].body, "clock rollback");
        assert!(rollback.cursor.revision > equal.cursor.revision);
        assert_eq!(sending.changes.thoughts[0].body, "x");
    }
    #[test]
    fn every_synced_table_tracks_field_edits_and_ignores_local_metadata() {
        let conn = db();
        conn.execute_batch("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at) VALUES ('r','reminder',0,1,'pending',1,1);
            INSERT INTO thoughts(id,body,tags,created_at,updated_at) VALUES ('t','thought','[]',1,1);
            INSERT INTO day_notes(day,body,created_at,updated_at) VALUES ('2026-09-13','note',1,1);
            INSERT INTO tombstones(id,deleted_at) VALUES ('dead',1);").unwrap();
        let initial = snapshot(&conn, None).unwrap();
        assert_eq!(initial.changes.reminders.len(), 1);
        // Edits at identical timestamps still become available at newer revisions.
        conn.execute_batch(
            "UPDATE reminders SET task_sort_key=42 WHERE id='r';
            UPDATE thoughts SET body='changed thought' WHERE id='t';
            UPDATE task_lanes SET name='changed lane';
            UPDATE day_notes SET body='' WHERE day='2026-09-13';
            UPDATE tombstones SET deleted_at=2 WHERE id='dead';",
        )
        .unwrap();
        let delta = snapshot(&conn, Some(&initial.cursor)).unwrap();
        assert_eq!(delta.changes.reminders[0].task_sort_key, Some(42.0));
        assert_eq!(delta.changes.thoughts[0].body, "changed thought");
        assert_eq!(delta.changes.lanes[0].name, "changed lane");
        assert_eq!(delta.changes.day_notes[0].body, "");
        assert_eq!(delta.changes.tombstones[0].deleted_at, 2);
        conn.execute_batch(
            "UPDATE reminders SET last_synced_at=100, source='remote';
            UPDATE thoughts SET body=body; UPDATE tombstones SET deleted_at=deleted_at;",
        )
        .unwrap();
        assert_eq!(
            snapshot(&conn, Some(&delta.cursor)).unwrap().cursor,
            delta.cursor
        );
    }

    #[test]
    fn reconciliation_resets_a_cursor_beyond_a_restored_database_head() {
        let conn = db();
        conn.execute(
            "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
            [],
        )
        .unwrap();
        let full = snapshot(&conn, None).unwrap();
        conn.execute("INSERT INTO sync_peer_cursors(peer_id,pull_epoch,pull_revision,push_epoch,push_revision) VALUES ('p',?1,9999,?1,9999)",[&full.cursor.epoch]).unwrap();
        storage::apply_pulled(&conn, "p", &full).unwrap();
        mark_pushed(&conn, "p", &full.cursor).unwrap();
        assert_eq!(
            cursors(&conn, "p").unwrap(),
            (Some(full.cursor.clone()), Some(full.cursor))
        );
    }

    #[test]
    fn committed_cursor_updates_refresh_peer_diagnostics() {
        let conn = db();
        conn.execute(
            "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
            [],
        )
        .unwrap();
        let full = snapshot(&conn, None).unwrap();
        storage::apply_pulled(&conn, "p", &full).unwrap();
        mark_pushed(&conn, "p", &full.cursor).unwrap();
        let (pull, push, seen): (i64, i64, Option<i64>) = conn
            .query_row(
                "SELECT last_pull_at,last_push_at,last_seen_at FROM peers WHERE id='p'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(pull > 0, "committed pull refreshes diagnostics");
        assert!(push > 0, "committed push refreshes diagnostics");
        assert!(seen.is_some_and(|s| s >= pull && s >= push));
    }

    #[test]
    fn failed_diagnostic_update_rolls_back_acknowledgment() {
        let conn = db();
        conn.execute("INSERT INTO peers(id,name,shared_secret,created_at,last_pull_at,last_push_at,last_seen_at) VALUES ('p','peer','test',0,17,18,19)",[]).unwrap();
        let full = snapshot(&conn, None).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_peer_update BEFORE UPDATE ON peers BEGIN SELECT RAISE(ABORT,'diagnostic failure'); END;").unwrap();
        assert!(mark_pushed(&conn, "p", &full.cursor).is_err());
        assert!(storage::apply_pulled(&conn, "p", &full).is_err());
        assert_eq!(cursors(&conn, "p").unwrap(), (None, None));
        let diagnostic: (i64, i64, i64) = conn
            .query_row(
                "SELECT last_pull_at,last_push_at,last_seen_at FROM peers WHERE id='p'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(diagnostic, (17, 18, 19));
    }

    #[test]
    fn restore_rotates_epoch_and_discards_delivery_cursors_without_losing_data() {
        let conn = db();
        conn.execute(
            "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
            [],
        )
        .unwrap();
        thought(&conn, "retained", 1);
        let before = snapshot(&conn, None).unwrap();
        storage::apply_pulled(&conn, "p", &before).unwrap();
        mark_pushed(&conn, "p", &before.cursor).unwrap();
        reset_after_restore(&conn).unwrap();
        assert_eq!(cursors(&conn, "p").unwrap(), (None, None));
        let restored = snapshot(&conn, Some(&before.cursor)).unwrap();
        assert_ne!(restored.cursor.epoch, before.cursor.epoch);
        assert_eq!(restored.changes.thoughts[0].id, "retained");
        assert!(mark_pushed(&conn, "p", &before.cursor).is_err());
        let secret: String = conn
            .query_row("SELECT shared_secret FROM peers WHERE id='p'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(secret, "test");
    }

    #[test]
    fn remote_reset_invalidates_outbound_cursor_durably_before_retry() {
        let path =
            std::env::temp_dir().join(format!("klaxon-remote-reset-{}.db", uuid::Uuid::new_v4()));
        {
            let conn = crate::db::open(&path).unwrap();
            conn.execute(
                "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
                [],
            )
            .unwrap();
            thought(&conn, "must resend", 1);
            let mut remote = snapshot(&conn, None).unwrap();
            remote.cursor = Cursor {
                epoch: "remote-before".into(),
                revision: 100,
            };
            storage::apply_pulled(&conn, "p", &remote).unwrap();
            let local = snapshot(&conn, None).unwrap();
            mark_pushed(&conn, "p", &local.cursor).unwrap();
            remote.cursor = Cursor {
                epoch: "remote-after".into(),
                revision: 1,
            };
            remote.changes.thoughts.clear();
            storage::apply_pulled(&conn, "p", &remote).unwrap();
            // Simulate transport failure before push acknowledgment, then restart.
        }
        {
            let conn = crate::db::open(&path).unwrap();
            let (pull, push) = cursors(&conn, "p").unwrap();
            assert_eq!(pull.unwrap().epoch, "remote-after");
            assert_eq!(
                push, None,
                "retry must still perform a full outbound reconciliation"
            );
            assert_eq!(
                snapshot(&conn, push.as_ref()).unwrap().changes.thoughts[0].id,
                "must resend"
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_epoch_and_impossible_revision_reconcile_fully() {
        let conn = db();
        thought(&conn, "x", 0);
        let full = snapshot(&conn, None).unwrap();
        for bad in [
            Cursor {
                epoch: "replaced".into(),
                revision: full.cursor.revision,
            },
            Cursor {
                epoch: full.cursor.epoch.clone(),
                revision: i64::MAX,
            },
            Cursor {
                epoch: full.cursor.epoch.clone(),
                revision: -1,
            },
        ] {
            assert_eq!(
                snapshot(&conn, Some(&bad)).unwrap().changes.thoughts.len(),
                1
            );
            assert!(mark_pushed(&conn, "p", &bad).is_err());
        }
    }
}
