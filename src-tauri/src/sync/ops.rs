//! Transport-agnostic sync operations.
//!
//! Both the HTTPS sync server (`sync::server`) and the iroh ProtocolHandler
//! (`sync::iroh_handler`) dispatch into these functions so the actual
//! "what does Ping / Pull / Push do" lives in exactly one place. Tests
//! also call into here directly.
//!
//! The functions take just what they need (db, identity, optional
//! AppHandle for event emission) — no transport-specific state.

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;

use crate::alerts;
use crate::db::{day_notes, reminders as repo, task_lanes, thoughts, tombstones};
use crate::error::AppResult;
use crate::models::now_ms;
use crate::sync::types::{
    ChangeSet, PingResponse, PushResponse, RemoteDayNote, RemoteReminder, RemoteThought,
    RemoteTombstone,
};
use crate::sync::DeviceIdentity;

pub fn ping(identity: &DeviceIdentity) -> PingResponse {
    PingResponse {
        device_id: identity.device_id.clone(),
        device_name: identity.device_name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        server_time_ms: now_ms(),
    }
}

pub fn pull(db: &Arc<Mutex<Connection>>, since: i64) -> AppResult<ChangeSet> {
    let conn = db.lock();
    let reminders = repo::updated_since(&conn, since)?
        .iter()
        .map(RemoteReminder::from)
        .collect();
    let ts = tombstones::deleted_since(&conn, since)?
        .iter()
        .map(RemoteTombstone::from)
        .collect();
    let lanes = task_lanes::updated_since(&conn, since)?;
    let thoughts = thoughts::updated_since(&conn, since)?
        .iter()
        .map(RemoteThought::from)
        .collect();
    let day_notes = day_notes::updated_since(&conn, since)?
        .iter()
        .map(RemoteDayNote::from)
        .collect();
    Ok(ChangeSet {
        server_time_ms: now_ms(),
        reminders,
        tombstones: ts,
        lanes,
        thoughts,
        day_notes,
    })
}

/// Apply an incoming ChangeSet. Returns the same shape the HTTPS path
/// returns. If `app` is `Some`, we cancel any in-flight alerts for ids
/// whose new state is silent (Dismissed/Snoozed/Completed) or that got
/// tombstoned, and emit the `klaxon://reminders-changed` event so the
/// frontend re-fetches.
pub fn push(
    db: &Arc<Mutex<Connection>>,
    app: Option<&AppHandle>,
    set: ChangeSet,
) -> AppResult<PushResponse> {
    let applied = {
        let conn = db.lock();
        super::storage::apply(&conn, &set)?
    };
    if let Some(app) = app {
        for id in &applied.to_cancel {
            alerts::cancel_alert(app, id);
        }
        if applied.reminders_changed {
            crate::sync::task::emit_reminders_changed(app);
        }
        if applied.thoughts_changed {
            crate::sync::task::emit_thoughts_changed(app);
        }
        if applied.day_notes_changed {
            crate::sync::task::emit_day_notes_changed(app);
        }
    }
    Ok(applied.response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Priority, ReminderCreate, ThoughtCreate};

    fn temp_db() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("klaxon-mesh-test-{}.db", uuid::Uuid::new_v4()));
        p
    }

    fn open(p: &std::path::Path) -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(crate::db::open(p).unwrap()))
    }

    // Exercise the production transactional operation without linking UI effects.
    fn apply_set(db: &Arc<Mutex<Connection>>, set: &ChangeSet) {
        super::super::storage::apply(&db.lock(), set).unwrap();
    }

    /// Issue #2's design guarantee: forwarding is carried entirely by
    /// updated_at/deleted_at watermarks — a change that arrives FROM a
    /// peer must forward onward to a
    /// third device unchanged. A→B→C through the real pull/push ops.
    #[test]
    fn changes_forward_across_three_devices_via_watermarks() {
        let (pa, pb, pc) = (temp_db(), temp_db(), temp_db());
        let a = open(&pa);
        let b = open(&pb);
        let c = open(&pc);

        // Local writes on A: a reminder, a delete (tombstone), a lane,
        // a thought, and a silent task (lands in the seed default lane).
        let (rid, doomed_id, lane_id, thought_id, task_id) = {
            let conn = a.lock();
            let mk = |title: &str| ReminderCreate {
                title: title.into(),
                description: None,
                due_at: now_ms() + 60_000,
                priority: Priority::Normal,
                sound_path: None,
                repeat_rule: None,
                silent: false,
                tags: vec![],
                task_lane_id: None,
            };
            let r = crate::db::reminders::create(&conn, mk("travels the mesh")).unwrap();
            let doomed = crate::db::reminders::create(&conn, mk("doomed")).unwrap();
            crate::db::reminders::delete(&conn, &doomed.id).unwrap();
            let now = now_ms();
            let lane = crate::db::task_lanes::Lane {
                id: uuid::Uuid::new_v4().to_string(),
                name: "mesh lane".into(),
                order_index: 99,
                is_default: false,
                created_at: now,
                updated_at: now,
            };
            crate::db::task_lanes::insert(&conn, &lane).unwrap();
            let t = crate::db::thoughts::create(
                &conn,
                ThoughtCreate {
                    body: "an idea".into(),
                    tags: vec![],
                },
            )
            .unwrap();
            let task = crate::db::reminders::create(
                &conn,
                ReminderCreate {
                    title: "ordered task".into(),
                    description: None,
                    due_at: 0,
                    priority: Priority::High,
                    sound_path: None,
                    repeat_rule: None,
                    silent: true,
                    tags: vec![],
                    task_lane_id: None, // default lane
                },
            )
            .unwrap();
            assert_eq!(task.task_sort_key, Some(1024.0));
            crate::db::day_notes::set(&conn, "2026-08-23", "a note that travels").unwrap();
            (r.id, doomed.id, lane.id.clone(), t.id, task.id)
        };

        // Hop 1: B ingests A's full state (what a pull achieves).
        let hop1 = pull(&a, 0).unwrap();
        apply_set(&b, &hop1);

        // Hop 2: C ingests from B. If any table's selection still
        // consulted an origin flag, the rows B received would be invisible
        // here — the exact issue-#1 failure mode.
        let hop2 = pull(&b, 0).unwrap();
        assert_eq!(hop2.reminders.len(), 2, "forwarded reminders in B's pull");
        assert_eq!(hop2.tombstones.len(), 1, "forwarded tombstone in B's pull");
        assert!(
            hop2.lanes.iter().any(|l| l.id == lane_id),
            "forwarded lane in B's pull"
        );
        assert_eq!(hop2.thoughts.len(), 1, "forwarded thought in B's pull");
        apply_set(&c, &hop2);

        {
            let conn = c.lock();
            let got = crate::db::reminders::get_by_id(&conn, &rid).unwrap();
            assert_eq!(got.title, "travels the mesh");
            assert!(
                crate::db::reminders::get_by_id(&conn, &doomed_id).is_err(),
                "tombstone applied on C"
            );
            assert!(
                crate::db::task_lanes::list_all(&conn)
                    .unwrap()
                    .iter()
                    .any(|l| l.id == lane_id),
                "lane present on C"
            );
            assert_eq!(
                crate::db::thoughts::get_by_id(&conn, &thought_id)
                    .unwrap()
                    .body,
                "an idea"
            );
            let got_task = crate::db::reminders::get_by_id(&conn, &task_id).unwrap();
            assert_eq!(
                got_task.task_sort_key,
                Some(1024.0),
                "sort key must forward through the mesh unchanged"
            );
            assert_eq!(got_task.priority, Priority::High);
            assert_eq!(
                crate::db::day_notes::get(&conn, "2026-08-23")
                    .unwrap()
                    .expect("day note forwarded to C")
                    .body,
                "a note that travels"
            );
        }
        for p in [pa, pb, pc] {
            std::fs::remove_file(p).ok();
        }
    }
}
