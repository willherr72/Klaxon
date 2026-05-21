//! Background sync task: every N seconds, walk paired peers and push/pull
//! changes against each one over the iroh transport. Errors are logged,
//! not surfaced.

use std::sync::Arc;
use std::time::Duration;

use iroh::Endpoint;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use crate::alerts;
use crate::db::{peers, reminders as repo, task_lanes, tombstones};
use crate::models::ReminderState;
use crate::sync::iroh_client;
use crate::sync::types::{ChangeSet, RemoteReminder, RemoteTombstone};

/// Emit a "something changed about the reminders table" event so the
/// frontend re-fetches. Called from anywhere the backend mutates reminders
/// without a user-initiated command (sync push/pull, scheduler fire).
pub fn emit_reminders_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://reminders-changed", ());
}

const SYNC_INTERVAL: Duration = Duration::from_secs(20);

pub async fn run(db: Arc<Mutex<Connection>>, app: AppHandle) {
    log::info!("sync task online");
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    tick.tick().await; // first tick fires immediately; skip
    loop {
        tick.tick().await;
        if !crate::sync::read_enabled(&db) {
            continue;
        }
        let peer_list = {
            let conn = db.lock();
            match peers::list_all(&conn) {
                Ok(p) => p,
                Err(e) => {
                    log::warn!("sync task list peers: {e}");
                    continue;
                }
            }
        };
        let iroh_endpoint = app
            .try_state::<crate::AppState>()
            .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.endpoint.clone()));
        let Some(endpoint) = iroh_endpoint else {
            log::debug!("sync tick: iroh endpoint not ready, skipping");
            continue;
        };
        for peer in peer_list {
            if let Err(e) = sync_one(&db, &app, &endpoint, &peer).await {
                log::debug!("sync with {} ({}) failed: {e}", peer.name, peer.id);
            }
        }
    }
}

async fn sync_one(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    endpoint: &Endpoint,
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<()> {
    let Some(node_id) = peer.iroh_node_id.as_deref() else {
        log::debug!(
            "skipping sync with {} — no iroh_node_id (re-pair required)",
            peer.name
        );
        return Ok(());
    };

    // Pull
    let pulled =
        iroh_client::pull(endpoint, node_id, &peer.shared_secret, peer.last_pull_at).await?;
    let mut max_pulled = peer.last_pull_at;
    let mut to_cancel: Vec<String> = Vec::new();
    {
        let conn = db.lock();
        // Lanes before reminders so an arriving reminder with a freshly-
        // created task_lane_id sees its lane row already present.
        for lane in &pulled.lanes {
            let _ = task_lanes::apply_remote(&conn, lane);
            if lane.updated_at > max_pulled {
                max_pulled = lane.updated_at;
            }
        }
        for r in &pulled.reminders {
            if matches!(repo::apply_remote(&conn, r), Ok(true))
                && silences_alert(r.state)
            {
                to_cancel.push(r.id.clone());
            }
            if r.updated_at > max_pulled {
                max_pulled = r.updated_at;
            }
        }
        for t in &pulled.tombstones {
            let _ = tombstones::apply_remote(&conn, &t.id, t.deleted_at);
            // Tombstones unconditionally cancel — the reminder is gone, no
            // reason to keep ringing about it. Same id might also belong
            // to a deleted lane; deleting a non-existent row is a no-op.
            let _ = task_lanes::delete(&conn, &t.id);
            to_cancel.push(t.id.clone());
            if t.deleted_at > max_pulled {
                max_pulled = t.deleted_at;
            }
        }
        // Trust the peer's clock for the watermark.
        let watermark = pulled.server_time_ms.max(max_pulled);
        peers::mark_pulled(&conn, &peer.id, watermark)?;
    }
    // Cancel local alerts after dropping the DB lock.
    for id in to_cancel {
        alerts::cancel_alert(app, &id);
    }
    if !pulled.reminders.is_empty() || !pulled.tombstones.is_empty() || !pulled.lanes.is_empty() {
        emit_reminders_changed(app);
    }

    // Push
    let (rems, tombs, lanes) = {
        let conn = db.lock();
        let rs = repo::updated_since(&conn, peer.last_push_at)?;
        let ts = tombstones::dirty_since(&conn, peer.last_push_at)?;
        let ls = task_lanes::dirty_since(&conn, peer.last_push_at)?;
        (
            rs.iter().map(RemoteReminder::from).collect::<Vec<_>>(),
            ts.iter().map(RemoteTombstone::from).collect::<Vec<_>>(),
            ls,
        )
    };
    if rems.is_empty() && tombs.is_empty() && lanes.is_empty() {
        return Ok(());
    }
    let max_pushed = rems
        .iter()
        .map(|r| r.updated_at)
        .chain(tombs.iter().map(|t| t.deleted_at))
        .chain(lanes.iter().map(|l| l.updated_at))
        .max()
        .unwrap_or(peer.last_push_at);
    let set = ChangeSet {
        server_time_ms: crate::models::now_ms(),
        reminders: rems,
        tombstones: tombs,
        lanes,
    };
    let resp = iroh_client::push(endpoint, node_id, &peer.shared_secret, set).await?;
    {
        let conn = db.lock();
        let watermark = resp.server_time_ms.max(max_pushed);
        peers::mark_pushed(&conn, &peer.id, watermark)?;
    }
    log::debug!(
        "synced with {}: pulled {}r/{}t/{}l, pushed {}r/{}t/{}l",
        peer.name,
        pulled.reminders.len(),
        pulled.tombstones.len(),
        pulled.lanes.len(),
        resp.accepted_reminders,
        resp.accepted_tombstones,
        resp.accepted_lanes,
    );
    Ok(())
}

/// Reminders in these states should silence any local alert that's still ringing.
fn silences_alert(state: ReminderState) -> bool {
    matches!(
        state,
        ReminderState::Dismissed | ReminderState::Snoozed | ReminderState::Completed
    )
}
