//! Background sync task: every N seconds, walk paired peers and push/pull
//! changes against each one over the iroh transport. Errors are logged,
//! not surfaced.

use std::sync::Arc;
use std::time::Duration;

use iroh::Endpoint;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::alerts;
use crate::db::{peers, reminders as repo, task_lanes, thoughts, tombstones};
use crate::models::ReminderState;
use crate::sync::iroh_client;
use crate::sync::trigger::{next_retry_delay, Nudge, DEBOUNCE};
use crate::sync::types::{ChangeSet, RemoteReminder, RemoteThought, RemoteTombstone};

/// Emit a "something changed about the reminders table" event so the
/// frontend re-fetches. Called from anywhere the backend mutates reminders
/// without a user-initiated command (sync push/pull, scheduler fire).
pub fn emit_reminders_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://reminders-changed", ());
}

/// Separate from `emit_reminders_changed` because the Thoughts feed is its
/// own view with its own paging state — it reloads on this event alone, so
/// a sync that only carried thoughts still refreshes it.
pub fn emit_thoughts_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://thoughts-changed", ());
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

/// Outcome of one pass: how many peers we attempted and how many failed.
/// The trigger loop uses `failed > 0` to decide whether to schedule a retry.
pub struct PassOutcome {
    pub attempted: usize,
    pub failed: usize,
}

pub async fn run(
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
    mut nudges: UnboundedReceiver<Nudge>,
    nudge_tx: UnboundedSender<Nudge>,
) {
    log::info!("sync task online (event-driven)");
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    tick.tick().await; // first tick fires immediately; skip
    loop {
        let triggered: Option<Nudge> = tokio::select! {
            _ = tick.tick() => None,
            n = nudges.recv() => match n {
                Some(n) => Some(n),
                None => return, // channel closed — app shutting down
            },
        };

        let mut network_changed = false;
        let retry_attempt = if let Some(nudge) = triggered {
            // Coalesce the burst: wait out the debounce window, then drain
            // whatever else arrived. Retry nudges skip the debounce — their
            // delay already happened. Track Resume/NetworkChange across the
            // whole drained burst — a Write arriving after a NetworkChange
            // must not swallow the rebind.
            if !matches!(nudge, Nudge::Retry(_)) {
                tokio::time::sleep(DEBOUNCE).await;
            }
            network_changed = matches!(nudge, Nudge::Resume | Nudge::NetworkChange);
            let mut latest = nudge;
            while let Ok(n) = nudges.try_recv() {
                network_changed |=
                    matches!(n, Nudge::Resume | Nudge::NetworkChange);
                latest = n;
            }
            match latest {
                Nudge::Retry(n) => n,
                _ => 0,
            }
        } else {
            0
        };

        // Issue #3: after sleep or a network migration, tell iroh to
        // re-evaluate sockets/paths/relay before dialing — a stale
        // binding otherwise times out on every dial until app restart.
        if network_changed {
            let ep = app
                .try_state::<crate::AppState>()
                .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.endpoint.clone()));
            if let Some(ep) = ep {
                log::info!("network-change/resume — notifying iroh endpoint");
                ep.network_change().await;
            }
        }

        let outcome = run_one_pass(&db, &app).await;

        // Only nudge-triggered passes retry; the 20s tick is its own retry.
        if triggered.is_some() && outcome.failed > 0 {
            if let Some(delay) = next_retry_delay(retry_attempt) {
                let tx = nudge_tx.clone();
                let next = retry_attempt + 1;
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = tx.send(Nudge::Retry(next));
                });
            } else {
                log::debug!("sync retries exhausted; waiting for next trigger");
            }
        }
    }
}

/// Run a single sync pass against every paired peer. Extracted from the
/// loop above so the `sync_now` command can trigger an immediate pass
/// (used on mobile when the app comes back to the foreground — without
/// this the user waits up to SYNC_INTERVAL to see fresh data).
pub async fn run_one_pass(db: &Arc<Mutex<Connection>>, app: &AppHandle) -> PassOutcome {
    const NONE: PassOutcome = PassOutcome { attempted: 0, failed: 0 };
    if !crate::sync::read_enabled(db) {
        return NONE;
    }
    let peer_list = {
        let conn = db.lock();
        match peers::list_all(&conn) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("sync task list peers: {e}");
                return NONE;
            }
        }
    };
    let iroh_endpoint = app
        .try_state::<crate::AppState>()
        .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.endpoint.clone()));
    let Some(endpoint) = iroh_endpoint else {
        log::debug!("sync pass: iroh endpoint not ready, skipping");
        return NONE;
    };
    let mut attempted = 0usize;
    let mut failed = 0usize;
    for peer in peer_list {
        attempted += 1;
        match with_peer_timeout(sync_one(db, app, &endpoint, &peer), SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                log::debug!("sync with {} ({}) failed: {e}", peer.name, peer.id);
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    &e.to_string(),
                    crate::models::now_ms(),
                );
            }
            PeerSyncResult::TimedOut => {
                failed += 1;
                log::warn!(
                    "sync with {} ({}) timed out after {}s — peer unreachable; skipping",
                    peer.name,
                    peer.id,
                    SYNC_PEER_TIMEOUT.as_secs(),
                );
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    "timed out after 10s — peer unreachable",
                    crate::models::now_ms(),
                );
            }
        }
    }
    PassOutcome { attempted, failed }
}

/// App-process side effects a completed pass wants performed. In the app
/// they cancel alerts and refresh the UI; the headless worker (cold
/// Android process) drops them — nothing is ringing and there is no
/// webview to refresh.
#[derive(Default)]
pub struct PassEffects {
    pub to_cancel: Vec<String>,
    pub reminders_changed: bool,
    pub thoughts_changed: bool,
}

/// App-process wrapper: gather mDNS-fresh seeds, run the core, apply the
/// effects (cancel alerts, poke the webview).
async fn sync_one(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    endpoint: &Endpoint,
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<()> {
    let mut extra: Vec<iroh::TransportAddr> = Vec::new();
    if let Some(node_id) = peer.iroh_node_id.as_deref() {
        if let Some(st) = app.try_state::<crate::AppState>() {
            if let Some(disc) = st.discovery.lock().as_ref() {
                extra.extend(
                    disc.addrs_for_node(node_id)
                        .into_iter()
                        .map(iroh::TransportAddr::Ip),
                );
            }
        }
    }
    let effects = sync_one_core(db, endpoint, &extra, peer).await?;
    for id in &effects.to_cancel {
        alerts::cancel_alert(app, id);
    }
    if effects.reminders_changed {
        emit_reminders_changed(app);
    }
    if effects.thoughts_changed {
        emit_thoughts_changed(app);
    }
    Ok(())
}

/// The sync pass proper — pull, apply, push — with no app-process
/// dependencies, so the cold Android worker can run it headless.
async fn sync_one_core(
    db: &Arc<Mutex<Connection>>,
    endpoint: &Endpoint,
    extra_seeds: &[iroh::TransportAddr],
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<PassEffects> {
    let Some(node_id) = peer.iroh_node_id.as_deref() else {
        log::debug!(
            "skipping sync with {} — no iroh_node_id (re-pair required)",
            peer.name
        );
        return Ok(PassEffects::default());
    };

    // Seed = persisted last-known-good ∪ caller-supplied extras (the app
    // passes mDNS-fresh LAN addresses; the headless worker has none).
    // Either source alone is enough to skip iroh's address lookup.
    let mut seed: Vec<iroh::TransportAddr> = peer
        .endpoint_addrs_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    for addr in extra_seeds {
        if !seed.contains(addr) {
            seed.push(addr.clone());
        }
    }

    // Version exchange (v0.7.1). Best-effort and recorded either way:
    // None must overwrite a stale value — a peer reinstalled with an
    // older build shouldn't keep claiming a modern version.
    let peer_version =
        iroh_client::hello(endpoint, node_id, &seed, &peer.shared_secret).await;
    {
        let conn = db.lock();
        let _ = crate::db::peers::set_app_version(&conn, &peer.id, peer_version.as_deref());
    }

    // Pull
    let (pulled, dial) =
        iroh_client::pull(endpoint, node_id, &seed, &peer.shared_secret, peer.last_pull_at)
            .await?;
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
        for t in &pulled.thoughts {
            let _ = thoughts::apply_remote(&conn, t);
            if t.updated_at > max_pulled {
                max_pulled = t.updated_at;
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
        // The dial succeeded — record it, and persist the connection's
        // live remote addresses as the next dial's seed.
        let _ = peers::record_sync_ok(
            &conn,
            &peer.id,
            dial.remote_addrs_json.as_deref(),
            crate::models::now_ms(),
        );
    }
    // Side effects are the caller's job — the app cancels alerts and pokes
    // the webview; the headless worker drops these.
    let effects = PassEffects {
        to_cancel,
        reminders_changed: !pulled.reminders.is_empty()
            || !pulled.tombstones.is_empty()
            || !pulled.lanes.is_empty(),
        thoughts_changed: !pulled.thoughts.is_empty() || !pulled.tombstones.is_empty(),
    };

    // Push
    let (rems, tombs, lanes, thts) = {
        let conn = db.lock();
        let rs = repo::updated_since(&conn, peer.last_push_at)?;
        let ts = tombstones::deleted_since(&conn, peer.last_push_at)?;
        let ls = task_lanes::updated_since(&conn, peer.last_push_at)?;
        // Watermark selection only — see issues #1/#2.
        let th = thoughts::updated_since(&conn, peer.last_push_at)?;
        (
            rs.iter().map(RemoteReminder::from).collect::<Vec<_>>(),
            ts.iter().map(RemoteTombstone::from).collect::<Vec<_>>(),
            ls,
            th.iter().map(RemoteThought::from).collect::<Vec<_>>(),
        )
    };
    if rems.is_empty() && tombs.is_empty() && lanes.is_empty() && thts.is_empty() {
        return Ok(effects);
    }
    let max_pushed = rems
        .iter()
        .map(|r| r.updated_at)
        .chain(tombs.iter().map(|t| t.deleted_at))
        .chain(lanes.iter().map(|l| l.updated_at))
        .chain(thts.iter().map(|t| t.updated_at))
        .max()
        .unwrap_or(peer.last_push_at);
    let set = ChangeSet {
        server_time_ms: crate::models::now_ms(),
        reminders: rems,
        tombstones: tombs,
        lanes,
        thoughts: thts,
    };
    let (resp, _push_dial) =
        iroh_client::push(endpoint, node_id, &seed, &peer.shared_secret, set).await?;
    {
        let conn = db.lock();
        let watermark = resp.server_time_ms.max(max_pushed);
        peers::mark_pushed(&conn, &peer.id, watermark)?;
    }
    log::debug!(
        "synced with {}: pulled {}r/{}t/{}l/{}th, pushed {}r/{}t/{}l/{}th",
        peer.name,
        pulled.reminders.len(),
        pulled.tombstones.len(),
        pulled.lanes.len(),
        pulled.thoughts.len(),
        resp.accepted_reminders,
        resp.accepted_tombstones,
        resp.accepted_lanes,
        resp.accepted_thoughts,
    );
    Ok(effects)
}

/// One pass with no app process: same peer walk, same per-peer budget,
/// effects dropped. Used by the cold Android WorkManager path — and by
/// nothing else, so it lives behind the same rules (sync_enabled gate,
/// error recording) as the app loop. Compiled on the host too so it
/// breaks loudly instead of rotting behind a cfg.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub async fn run_one_pass_headless(
    db: &Arc<Mutex<Connection>>,
    endpoint: &Endpoint,
) -> PassOutcome {
    const NONE: PassOutcome = PassOutcome { attempted: 0, failed: 0 };
    if !crate::sync::read_enabled(db) {
        return NONE;
    }
    let peer_list = {
        let conn = db.lock();
        match peers::list_all(&conn) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("headless sync list peers: {e}");
                return NONE;
            }
        }
    };
    let mut attempted = 0usize;
    let mut failed = 0usize;
    for peer in peer_list {
        attempted += 1;
        let fut = async { sync_one_core(db, endpoint, &[], &peer).await.map(|_| ()) };
        match with_peer_timeout(fut, SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                log::debug!("headless sync with {} failed: {e}", peer.name);
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    &e.to_string(),
                    crate::models::now_ms(),
                );
            }
            PeerSyncResult::TimedOut => {
                failed += 1;
                log::warn!("headless sync with {} timed out", peer.name);
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    "timed out after 10s — peer unreachable",
                    crate::models::now_ms(),
                );
            }
        }
    }
    PassOutcome { attempted, failed }
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
