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
use crate::db::{reminders as repo, task_lanes, tombstones};
use crate::error::AppResult;
use crate::models::{now_ms, ReminderState};
use crate::sync::types::{
    ChangeSet, PingResponse, PushResponse, RemoteReminder, RemoteTombstone,
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
    let ts = tombstones::dirty_since(&conn, since)?
        .iter()
        .map(RemoteTombstone::from)
        .collect();
    let lanes = task_lanes::dirty_since(&conn, since)?;
    Ok(ChangeSet {
        server_time_ms: now_ms(),
        reminders,
        tombstones: ts,
        lanes,
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

        for t in &set.tombstones {
            match tombstones::apply_remote(&conn, &t.id, t.deleted_at) {
                Ok(()) => {
                    accepted_tombstones += 1;
                    to_cancel.push(t.id.clone());
                    // A tombstone may refer to either a reminder or a
                    // lane (both share the tombstones table). For lanes
                    // we just delete the row — sync apply already drops
                    // the row when tombstone is newer.
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
        if accepted_reminders > 0 || accepted_tombstones > 0 || accepted_lanes > 0 {
            crate::sync::task::emit_reminders_changed(app);
        }
    }

    Ok(PushResponse {
        server_time_ms: now_ms(),
        accepted_reminders,
        accepted_tombstones,
        accepted_lanes,
    })
}
