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

/// Hard per-peer wall-clock budget for a single sync attempt. iroh's
/// `connect` keeps trying to reach an offline node for a long time; without
/// this cap one unreachable peer stalls the whole pass — and on mobile it
/// holds the WorkManager background worker busy until the OS kills it.
const SYNC_PEER_TIMEOUT: Duration = Duration::from_secs(10);

/// Outcome of syncing one peer under [`SYNC_PEER_TIMEOUT`].
enum PeerSyncResult {
    Ok,
    Failed(crate::error::AppError),
    TimedOut,
}

/// Run one peer's sync under a hard time budget. Dropping the future on
/// timeout cancels the in-flight work (including a hung iroh `connect`), so
/// an unreachable peer costs at most `budget` instead of blocking the pass.
/// Kept generic over the future so the timeout handling is unit-testable
/// without binding a real iroh endpoint (which can't be done under
/// `#[cfg(test)]` on Windows — see `sync/iroh_handler.rs`).
async fn with_peer_timeout<F>(fut: F, budget: Duration) -> PeerSyncResult
where
    F: std::future::Future<Output = crate::error::AppResult<()>>,
{
    match tokio::time::timeout(budget, fut).await {
        Ok(Ok(())) => PeerSyncResult::Ok,
        Ok(Err(e)) => PeerSyncResult::Failed(e),
        Err(_) => PeerSyncResult::TimedOut,
    }
}

pub async fn run(db: Arc<Mutex<Connection>>, app: AppHandle) {
    log::info!("sync task online");
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    tick.tick().await; // first tick fires immediately; skip
    loop {
        tick.tick().await;
        run_one_pass(&db, &app).await;
    }
}

/// Run a single sync pass against every paired peer. Extracted from the
/// loop above so the `sync_now` command can trigger an immediate pass
/// (used on mobile when the app comes back to the foreground — without
/// this the user waits up to SYNC_INTERVAL to see fresh data).
pub async fn run_one_pass(db: &Arc<Mutex<Connection>>, app: &AppHandle) {
    if !crate::sync::read_enabled(db) {
        return;
    }
    let peer_list = {
        let conn = db.lock();
        match peers::list_all(&conn) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("sync task list peers: {e}");
                return;
            }
        }
    };
    let iroh_endpoint = app
        .try_state::<crate::AppState>()
        .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.endpoint.clone()));
    let Some(endpoint) = iroh_endpoint else {
        log::debug!("sync pass: iroh endpoint not ready, skipping");
        return;
    };
    for peer in peer_list {
        match with_peer_timeout(sync_one(db, app, &endpoint, &peer), SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                log::debug!("sync with {} ({}) failed: {e}", peer.name, peer.id);
            }
            PeerSyncResult::TimedOut => {
                log::warn!(
                    "sync with {} ({}) timed out after {}s — peer unreachable; skipping",
                    peer.name,
                    peer.id,
                    SYNC_PEER_TIMEOUT.as_secs(),
                );
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

#[cfg(test)]
mod tests {
    use super::{with_peer_timeout, PeerSyncResult, SYNC_PEER_TIMEOUT};
    use crate::error::{AppError, AppResult};
    use std::time::Duration;

    /// The whole point of the fix: a peer whose sync never completes (iroh
    /// hanging on an offline node, modelled here by a never-resolving future)
    /// must hit the budget rather than block forever. If `with_peer_timeout`
    /// failed to apply the cap, this test would hang.
    #[tokio::test]
    async fn unreachable_peer_times_out_within_budget() {
        let outcome = with_peer_timeout(
            std::future::pending::<AppResult<()>>(),
            Duration::from_millis(50),
        )
        .await;
        assert!(matches!(outcome, PeerSyncResult::TimedOut));
    }

    /// A peer that completes inside the budget reports success — the cap must
    /// not penalise healthy (even if slightly slow) syncs.
    #[tokio::test]
    async fn successful_sync_passes_through() {
        let outcome = with_peer_timeout(async { Ok(()) }, SYNC_PEER_TIMEOUT).await;
        assert!(matches!(outcome, PeerSyncResult::Ok));
    }

    /// A real sync error (not a timeout) is preserved so it still gets logged
    /// distinctly — the cap must not flatten every failure into "timed out".
    #[tokio::test]
    async fn sync_error_is_distinct_from_timeout() {
        let outcome = with_peer_timeout(
            async { Err(AppError::Invalid("boom".into())) },
            SYNC_PEER_TIMEOUT,
        )
        .await;
        assert!(matches!(outcome, PeerSyncResult::Failed(_)));
    }
}
