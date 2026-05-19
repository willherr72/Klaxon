//! Background sync task: every N seconds, walk paired peers and push/pull
//! changes against each one. Errors are logged, not surfaced.
//!
//! Transport selection per-peer:
//!   - If the peer has an `iroh_node_id` (paired on v0.3+) AND our local
//!     iroh endpoint is up, sync runs over the iroh transport.
//!   - Otherwise we fall back to the v0.2 LAN HTTPS path. This keeps
//!     existing pairs working until the user re-pairs.

use std::sync::Arc;
use std::time::Duration;

use iroh::Endpoint;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use crate::alerts;
use crate::db::{peers, reminders as repo, tombstones};
use crate::models::ReminderState;
use crate::sync::client::SyncClient;
use crate::sync::iroh_client;
use crate::sync::types::{ChangeSet, PushResponse, RemoteReminder, RemoteTombstone};

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
        for peer in peer_list {
            if let Err(e) = sync_one(&db, &app, iroh_endpoint.as_ref(), &peer).await {
                log::debug!("sync with {} ({}) failed: {e}", peer.name, peer.id);
            }
        }
    }
}

async fn sync_one(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    iroh_endpoint: Option<&Endpoint>,
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<()> {
    let use_iroh = iroh_endpoint.is_some() && peer.iroh_node_id.is_some();

    // Pull
    let pulled = if use_iroh {
        let ep = iroh_endpoint.expect("iroh endpoint checked above");
        let nid = peer.iroh_node_id.as_deref().expect("node_id checked above");
        iroh_client::pull(ep, nid, &peer.shared_secret, peer.last_pull_at).await?
    } else {
        let fp = peer.cert_fingerprint.as_deref().unwrap_or("");
        let client = SyncClient::new(peer.url.clone(), peer.shared_secret.clone(), fp)?;
        client.pull(peer.last_pull_at).await?
    };
    let mut max_pulled = peer.last_pull_at;
    let mut to_cancel: Vec<String> = Vec::new();
    {
        let conn = db.lock();
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
            // reason to keep ringing about it.
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
    if !pulled.reminders.is_empty() || !pulled.tombstones.is_empty() {
        emit_reminders_changed(app);
    }

    // Push
    let (rems, tombs) = {
        let conn = db.lock();
        let rs = repo::updated_since(&conn, peer.last_push_at)?;
        let ts = tombstones::dirty_since(&conn, peer.last_push_at)?;
        (
            rs.iter().map(RemoteReminder::from).collect::<Vec<_>>(),
            ts.iter().map(RemoteTombstone::from).collect::<Vec<_>>(),
        )
    };
    if rems.is_empty() && tombs.is_empty() {
        return Ok(());
    }
    let max_pushed = rems
        .iter()
        .map(|r| r.updated_at)
        .chain(tombs.iter().map(|t| t.deleted_at))
        .max()
        .unwrap_or(peer.last_push_at);
    let set = ChangeSet {
        server_time_ms: crate::models::now_ms(),
        reminders: rems,
        tombstones: tombs,
    };
    let resp: PushResponse = if use_iroh {
        let ep = iroh_endpoint.expect("iroh endpoint checked above");
        let nid = peer.iroh_node_id.as_deref().expect("node_id checked above");
        iroh_client::push(ep, nid, &peer.shared_secret, set).await?
    } else {
        let fp = peer.cert_fingerprint.as_deref().unwrap_or("");
        let client = SyncClient::new(peer.url.clone(), peer.shared_secret.clone(), fp)?;
        client.push(&set).await?
    };
    {
        let conn = db.lock();
        let watermark = resp.server_time_ms.max(max_pushed);
        peers::mark_pushed(&conn, &peer.id, watermark)?;
    }
    log::debug!(
        "synced with {} via {}: pulled {}r/{}t, pushed {}r/{}t",
        peer.name,
        if use_iroh { "iroh" } else { "https" },
        pulled.reminders.len(),
        pulled.tombstones.len(),
        resp.accepted_reminders,
        resp.accepted_tombstones,
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
