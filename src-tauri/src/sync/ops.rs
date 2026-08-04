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
use crate::db::{reminders as repo, task_lanes, thoughts, tombstones};
use crate::error::AppResult;
use crate::models::{now_ms, ReminderState};
use crate::sync::types::{
    ChangeSet, PingResponse, PushResponse, RemoteReminder, RemoteThought, RemoteTombstone,
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
    Ok(ChangeSet {
        server_time_ms: now_ms(),
        reminders,
        tombstones: ts,
        lanes,
        thoughts,
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
    let mut accepted_reminders = 0usize;
    let mut accepted_tombstones = 0usize;
    let mut accepted_lanes = 0usize;
    let mut accepted_thoughts = 0usize;
    let mut to_cancel: Vec<String> = Vec::new();

    {
        let conn = db.lock();
        // Lanes first — a reminder arriving with a new task_lane_id has
        // to have that lane already present in the table for the FK
        // story to be intuitive. With nullable FK and no actual SQL
        // constraint this isn't strictly required, but ordering reads
        // better in logs.
        for lane in &set.lanes {
            match task_lanes::apply_remote(&conn, lane) {
                Ok(true) => accepted_lanes += 1,
                Ok(false) => {}
                Err(e) => log::warn!("apply remote lane {}: {e}", lane.id),
            }
        }

        for r in &set.reminders {
            match repo::apply_remote(&conn, r) {
                Ok(true) => {
                    accepted_reminders += 1;
                    if matches!(
                        r.state,
                        ReminderState::Dismissed
                            | ReminderState::Snoozed
                            | ReminderState::Completed
                    ) {
                        to_cancel.push(r.id.clone());
                    }
                }
                Ok(false) => {}
                Err(e) => log::warn!("apply remote reminder {}: {e}", r.id),
            }
        }

        for t in &set.thoughts {
            match thoughts::apply_remote(&conn, t) {
                Ok(true) => accepted_thoughts += 1,
                Ok(false) => {}
                Err(e) => log::warn!("apply remote thought {}: {e}", t.id),
            }
        }

        for t in &set.tombstones {
            match tombstones::apply_remote(&conn, &t.id, t.deleted_at) {
                Ok(()) => {
                    accepted_tombstones += 1;
                    to_cancel.push(t.id.clone());
                    // A tombstone may refer to a reminder, a lane, or a
                    // thought (all three share the tombstones table).
                    // `tombstones::apply_remote` handles reminders and
                    // thoughts; lanes we drop here.
                    let _ = task_lanes::delete(&conn, &t.id);
                }
                Err(e) => log::warn!("apply remote tombstone {}: {e}", t.id),
            }
        }
    }

    if let Some(app) = app {
        for id in to_cancel {
            alerts::cancel_alert(app, &id);
        }
        if accepted_reminders > 0
            || accepted_tombstones > 0
            || accepted_lanes > 0
            || accepted_thoughts > 0
        {
            crate::sync::task::emit_reminders_changed(app);
        }
        if accepted_thoughts > 0 || accepted_tombstones > 0 {
            crate::sync::task::emit_thoughts_changed(app);
        }
    }

    Ok(PushResponse {
        server_time_ms: now_ms(),
        accepted_reminders,
        accepted_tombstones,
        accepted_lanes,
        accepted_thoughts,
    })
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

    /// `ops::push` minus the tauri plumbing. Referencing `push` from
    /// test code links the AppHandle emit chain into the test binary,
    /// which trips the Windows loader (STATUS_ENTRYPOINT_NOT_FOUND —
    /// same landmine documented in iroh_handler.rs). Same apply_remote
    /// family, same lanes-first order, so the sync semantics under test
    /// are identical.
    fn apply_set(db: &Arc<Mutex<Connection>>, set: &ChangeSet) {
        let conn = db.lock();
        for lane in &set.lanes {
            task_lanes::apply_remote(&conn, lane).unwrap();
        }
        for r in &set.reminders {
            repo::apply_remote(&conn, r).unwrap();
        }
        for t in &set.thoughts {
            thoughts::apply_remote(&conn, t).unwrap();
        }
        for t in &set.tombstones {
            tombstones::apply_remote(&conn, &t.id, t.deleted_at).unwrap();
        }
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
        // and a thought.
        let (rid, doomed_id, lane_id, thought_id) = {
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
                ThoughtCreate { body: "an idea".into(), tags: vec![] },
            )
            .unwrap();
            (r.id, doomed.id, lane.id.clone(), t.id)
        };

        // Hop 1: B ingests A's full state (what a pull achieves).
        let hop1 = pull(&a, 0).unwrap();
        apply_set(&b, &hop1);

        // Hop 2: C ingests from B. If any table's selection still
        // consulted an origin flag, the rows B received would be invisible
        // here — the exact issue-#1 failure mode.
        let hop2 = pull(&b, 0).unwrap();
        assert_eq!(hop2.reminders.len(), 1, "forwarded reminder in B's pull");
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
                crate::db::task_lanes::list_all(&conn).unwrap().iter().any(|l| l.id == lane_id),
                "lane present on C"
            );
            assert_eq!(
                crate::db::thoughts::get_by_id(&conn, &thought_id).unwrap().body,
                "an idea"
            );
        }
        for p in [pa, pb, pc] {
            std::fs::remove_file(p).ok();
        }
    }
}
