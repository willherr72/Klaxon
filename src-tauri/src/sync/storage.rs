//! Transactional sync application, with effects returned only after commit.
use crate::db::{
    day_notes, reminders,
    sync_log::{self, Batch},
    task_lanes, thoughts, tombstones,
};
use crate::error::AppResult;
use crate::models::{now_ms, ReminderState};
use crate::sync::types::{ChangeSet, PushResponse};
use rusqlite::Connection;

#[derive(Debug)]
pub struct Applied {
    pub response: PushResponse,
    pub to_cancel: Vec<String>,
    pub reminders_changed: bool,
    pub thoughts_changed: bool,
    pub day_notes_changed: bool,
}

pub fn apply(conn: &Connection, set: &ChangeSet) -> AppResult<Applied> {
    let tx = conn.unchecked_transaction()?;
    let applied = apply_in_transaction(&tx, set)?;
    tx.commit()?;
    Ok(applied)
}

pub fn apply_pulled(conn: &Connection, peer: &str, batch: &Batch) -> AppResult<Applied> {
    let tx = conn.unchecked_transaction()?;
    let applied = apply_in_transaction(&tx, &batch.changes)?;
    sync_log::mark_pulled(&tx, peer, &batch.cursor)?;
    tx.commit()?;
    Ok(applied)
}

fn apply_in_transaction(conn: &Connection, set: &ChangeSet) -> AppResult<Applied> {
    let mut response = PushResponse {
        server_time_ms: now_ms(),
        accepted_reminders: 0,
        accepted_tombstones: 0,
        accepted_lanes: 0,
        accepted_thoughts: 0,
        accepted_day_notes: 0,
    };
    let mut to_cancel = Vec::new();
    // Deletions first: older live rows in this very batch must not resurrect.
    // Entity writes also consult existing tombstones from earlier batches.
    for t in &set.tombstones {
        if tombstones::apply_remote(conn, &t.id, t.deleted_at)? {
            response.accepted_tombstones += 1;
            to_cancel.push(t.id.clone());
        }
    }
    for lane in &set.lanes {
        if task_lanes::apply_remote(conn, lane)? {
            response.accepted_lanes += 1;
        }
    }
    for r in &set.reminders {
        if reminders::apply_remote(conn, r)? {
            response.accepted_reminders += 1;
            if matches!(
                r.state,
                ReminderState::Dismissed | ReminderState::Snoozed | ReminderState::Completed
            ) {
                to_cancel.push(r.id.clone());
            }
        }
    }
    for t in &set.thoughts {
        if thoughts::apply_remote(conn, t)? {
            response.accepted_thoughts += 1;
        }
    }
    for n in &set.day_notes {
        if day_notes::apply_remote(conn, n)? {
            response.accepted_day_notes += 1;
        }
    }
    // A stale tombstone may coexist with a newer active reminder. Cancel
    // only if the committed row is absent or in a silent state.
    let mut cancel_committed = Vec::new();
    for id in to_cancel {
        let active:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM reminders WHERE id=?1 AND state NOT IN ('dismissed','snoozed','completed'))",[&id],|r|r.get(0))?;
        if !active {
            cancel_committed.push(id);
        }
    }
    cancel_committed.sort();
    cancel_committed.dedup();
    Ok(Applied {
        reminders_changed: response.accepted_reminders
            + response.accepted_tombstones
            + response.accepted_lanes
            > 0,
        thoughts_changed: response.accepted_thoughts + response.accepted_tombstones > 0,
        day_notes_changed: response.accepted_day_notes > 0,
        response,
        to_cancel: cancel_committed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{
        self,
        sync_log::{self, Cursor},
    };
    use crate::sync::types::{RemoteThought, RemoteTombstone};
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('p','peer','test',0)",
            [],
        )
        .unwrap();
        conn
    }
    fn set() -> ChangeSet {
        ChangeSet {
            server_time_ms: 0,
            reminders: vec![],
            tombstones: vec![],
            lanes: vec![],
            thoughts: vec![],
            day_notes: vec![],
        }
    }
    fn thought(id: &str, clock: i64) -> RemoteThought {
        RemoteThought {
            id: id.into(),
            body: id.into(),
            tags: vec![],
            created_at: 1,
            updated_at: clock,
        }
    }
    #[test]
    fn failure_rolls_back_rows_journal_and_pull_cursor_then_retry_commits() {
        let conn = db();
        let before = sync_log::snapshot(&conn, None).unwrap().cursor;
        let mut changes = set();
        changes.thoughts = vec![thought("first", 10), thought("second", 10)];
        let batch = Batch {
            cursor: Cursor {
                epoch: "remote".into(),
                revision: 42,
            },
            changes,
        };
        conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON thoughts WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        assert!(apply_pulled(&conn, "p", &batch).is_err());
        assert!(db::thoughts::get_by_id(&conn, "first").is_err());
        assert_eq!(sync_log::snapshot(&conn, None).unwrap().cursor, before);
        assert_eq!(sync_log::cursors(&conn, "p").unwrap().0, None);
        let diagnostic: (i64, Option<i64>) = conn
            .query_row(
                "SELECT last_pull_at,last_seen_at FROM peers WHERE id='p'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            diagnostic,
            (0, None),
            "failed batches do not report successful delivery"
        );

        conn.execute_batch("DROP TRIGGER reject_second;").unwrap();
        let result = apply_pulled(&conn, "p", &batch).unwrap();
        assert_eq!(result.response.accepted_thoughts, 2);
        assert_eq!(
            sync_log::cursors(&conn, "p").unwrap().0,
            Some(batch.cursor.clone())
        );
        let committed = sync_log::snapshot(&conn, None).unwrap().cursor;
        assert_eq!(
            apply_pulled(&conn, "p", &batch)
                .unwrap()
                .response
                .accepted_thoughts,
            0
        );
        assert_eq!(sync_log::snapshot(&conn, None).unwrap().cursor, committed);
    }
    #[test]
    fn failure_recording_pull_cursor_rolls_back_the_applied_batch() {
        let conn = db();
        let mut changes = set();
        changes.thoughts = vec![thought("first", 10)];
        let batch = Batch {
            cursor: Cursor {
                epoch: "peer-epoch".into(),
                revision: 9,
            },
            changes,
        };
        let before = sync_log::snapshot(&conn, None).unwrap().cursor;
        conn.execute_batch("CREATE TRIGGER reject_cursor BEFORE INSERT ON sync_peer_cursors BEGIN SELECT RAISE(ABORT,'cursor failure'); END;").unwrap();
        assert!(apply_pulled(&conn, "p", &batch).is_err());
        assert!(db::thoughts::get_by_id(&conn, "first").is_err());
        assert_eq!(sync_log::snapshot(&conn, None).unwrap().cursor, before);
        conn.execute_batch("DROP TRIGGER reject_cursor;").unwrap();
        assert_eq!(
            apply_pulled(&conn, "p", &batch)
                .unwrap()
                .response
                .accepted_thoughts,
            1
        );
        assert_eq!(sync_log::cursors(&conn, "p").unwrap().0, Some(batch.cursor));
    }

    #[test]
    fn push_failure_is_retryable_and_committed_effects_match_winning_rows() {
        let conn = db();
        let mut changes = set();
        changes.thoughts = vec![thought("first", 10), thought("second", 10)];
        conn.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON thoughts WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'write failure'); END;").unwrap();
        assert!(apply(&conn, &changes).is_err());
        assert!(db::thoughts::get_by_id(&conn, "first").is_err());
        conn.execute_batch("DROP TRIGGER reject_second;").unwrap();
        let result = apply(&conn, &changes).unwrap();
        assert!(result.thoughts_changed);
        assert_eq!(result.response.accepted_thoughts, 2);
        let unchanged = apply(&conn, &changes).unwrap();
        assert!(!unchanged.thoughts_changed);
        assert!(unchanged.to_cancel.is_empty());
    }

    #[test]
    fn tombstones_are_idempotent_and_prevent_stale_thought_and_lane_resurrection() {
        let conn = db();
        let mut deleted = set();
        deleted.tombstones = vec![RemoteTombstone {
            id: "gone".into(),
            deleted_at: 20,
        }];
        apply(&conn, &deleted).unwrap();
        let before = sync_log::snapshot(&conn, None).unwrap().cursor;
        assert_eq!(
            apply(&conn, &deleted).unwrap().response.accepted_tombstones,
            0
        );
        assert_eq!(sync_log::snapshot(&conn, None).unwrap().cursor, before);
        let mut stale = set();
        stale.thoughts = vec![thought("gone", 10)];
        stale.lanes = vec![db::task_lanes::Lane {
            id: "gone".into(),
            name: "gone".into(),
            order_index: 0,
            is_default: false,
            created_at: 1,
            updated_at: 10,
        }];
        let result = apply(&conn, &stale).unwrap();
        assert_eq!(result.response.accepted_thoughts, 0);
        assert_eq!(result.response.accepted_lanes, 0);
        assert!(db::thoughts::get_by_id(&conn, "gone").is_err());
        assert!(db::task_lanes::get_by_id(&conn, "gone").unwrap().is_none());
        stale.lanes[0].updated_at = 30;
        apply(&conn, &stale).unwrap();
        apply(&conn, &deleted).unwrap();
        assert!(db::task_lanes::get_by_id(&conn, "gone").unwrap().is_some());
    }
}
