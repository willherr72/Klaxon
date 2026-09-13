//! Background sync task: every N seconds, walk paired peers and push/pull
//! changes against each one over the iroh transport. Errors are logged,
//! not surfaced.

use std::sync::Arc;
use std::time::{Duration, Instant};

use iroh::Endpoint;
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::db::peers;
use crate::sync::coordinator;
#[cfg(test)]
use crate::sync::coordinator::{FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT, SELF_TEST_COOLDOWN};
use crate::sync::iroh_client;
use crate::sync::trigger::{next_retry_delay, Nudge, DEBOUNCE};

/// Emit a "something changed about the reminders table" event so the
/// frontend re-fetches. Called from anywhere the backend mutates reminders
/// — sync push/pull, scheduler fire, AND the mutating commands themselves.
///
/// Commands used to stay silent on the theory that a user-initiated change
/// is the caller's job to redraw. That held only while every caller had a
/// refresh path: the Tasks board's star control didn't, so its writes
/// landed in SQLite and never appeared on screen. The alarm window and the
/// Android notification actions are separate callers with the same gap.
/// Announcing the change is the cheaper invariant.
pub fn emit_reminders_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://reminders-changed", ());
}

/// Separate from `emit_reminders_changed` because the Thoughts feed is its
/// own view with its own paging state — it reloads on this event alone, so
/// a sync that only carried thoughts still refreshes it.
pub fn emit_thoughts_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://thoughts-changed", ());
}

/// Separate again, same reasoning as `emit_thoughts_changed`: the day-detail
/// panel is its own view keyed to a single day — it reloads on this event
/// alone, so a sync that carried nothing but a day note still refreshes an
/// open panel instead of leaving it showing stale content.
pub fn emit_day_notes_changed(app: &AppHandle) {
    let _ = app.emit("klaxon://day-notes-changed", ());
}

const SYNC_INTERVAL: Duration = Duration::from_secs(20);

/// Hard per-peer wall-clock budget for a single sync attempt. iroh's
/// `connect` keeps trying to reach an offline node for a long time; without
/// this cap one unreachable peer stalls the whole pass — and on mobile it
/// holds the WorkManager background worker busy until the OS kills it.
///
/// Keep this ABOVE `iroh_client`'s own dial/RPC timeouts. When it was the
/// tighter of the two, it always won the race and flattened every failure
/// into "peer unreachable" — 42 hours of an incident with the specific iroh
/// error never once reaching a log line.
const SYNC_PEER_TIMEOUT: Duration = Duration::from_secs(30);

/// Outcome of syncing one peer under [`SYNC_PEER_TIMEOUT`].
enum PeerSyncResult {
    Ok,
    Failed(crate::error::AppError),
    TimedOut,
}

/// Run one peer's sync under a hard time budget. Dropping the future on
/// timeout cancels the in-flight work (including a hung iroh `connect`), so
/// an unreachable peer costs at most `budget` instead of blocking the pass.
/// Kept generic so deadline behavior can be tested without a network.
/// Real transport coverage lives in examples/sync_smoke.rs.
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
    /// Peers we never dialed — currently those paired before v0.3 that have
    /// no iroh node id. They report neither success nor failure, so the
    /// endpoint watchdog must exclude them: counted as successes they would
    /// hold its failure streak at zero forever.
    pub skipped: usize,
}

/// Is it time to spend a self-test on this run of failures?
///
/// The recovery decision can be tested independently of network availability.
#[cfg(test)]
fn should_self_test(failed_passes: u32, since_last_test: Option<Duration>) -> bool {
    coordinator::recovery_due(true, false, failed_passes, since_last_test)
}

/// Ask whether our own transport is still reachable, and rebuild it if not.
/// Returns true when a rebuild actually happened.
///
/// The decision rests on a real dial of our own endpoint id rather than on
/// the endpoint's opinion of itself. That distinction is the whole design:
/// with one paired phone asleep in Android's freezer, EVERY pass fails all
/// night, so any rule based on failure count alone would rebuild on a loop
/// until morning. The self-test answers "can anything reach us" directly,
/// so an asleep peer costs one 6-second dial per cooldown and nothing else.
async fn maybe_rebuild_endpoint(
    app: &AppHandle,
    failed_passes: u32,
    last_self_test: &mut Option<Instant>,
) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return false;
    };
    if !crate::sync::read_enabled(&state.db)
        || !coordinator::recovery_due(
            cfg!(desktop),
            coordinator::is_foreground(),
            failed_passes,
            last_self_test.map(|at| at.elapsed()),
        )
    {
        return false;
    }

    // Clone what we need out; never hold the lock across an await.
    let node = state
        .iroh_node
        .lock()
        .as_ref()
        .map(|n| (n.node_id.clone(), n.endpoint.clone()));
    *last_self_test = Some(Instant::now());

    let our_id = match &node {
        Some((id, _)) => id.clone(),
        None => {
            // No transport at all. Reachable only if a previous rebuild
            // failed after emptying the state — recover by standing one up
            // rather than waiting for a restart, which nothing else does.
            log::warn!("sync failing with no iroh endpoint present — attempting bring-up");
            return rebuild_now(app, &state, "no endpoint present").await;
        }
    };

    let verdict = tokio::select! {
        verdict = crate::sync::iroh_node::self_reachable(&our_id) => verdict,
        _ = coordinator::wait_until_background(), if !cfg!(desktop) => {
            log::info!("activity paused — canceling endpoint health probe");
            return false;
        }
    };
    match verdict {
        Some(true) => {
            log::info!(
                "{failed_passes} failed passes, but our endpoint answered its own dial — \
                 the peers are away, not us"
            );
            false
        }
        Some(false) => {
            // A pause can race the probe's result. Never initiate a mobile
            // rebuild after the activity has left the foreground.
            if !cfg!(desktop) && !coordinator::is_foreground() {
                return false;
            }
            let relay = node
                .as_ref()
                .map(|(_, ep)| crate::sync::iroh_node::relay_connected(ep))
                .unwrap_or(false);
            log::warn!(
                "our endpoint did not answer its own dial after {failed_passes} failed \
                 passes (relay home: {}) — transport is dead, rebuilding",
                if relay { "up" } else { "DOWN" }
            );
            rebuild_now(app, &state, "self-test failed").await
        }
        None => {
            log::warn!("endpoint self-test could not run — skipping this round");
            false
        }
    }
}

/// Stand a fresh transport up, reusing the launch path.
async fn rebuild_now(
    app: &AppHandle,
    state: &tauri::State<'_, crate::AppState>,
    reason: &str,
) -> bool {
    let app_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            log::error!("endpoint rebuild: cannot resolve app data dir: {e}");
            return false;
        }
    };
    let cfg = crate::sync::iroh_node::BringUp {
        db: state.db.clone(),
        app: app.clone(),
        app_dir,
        identity: crate::sync::read_identity(&state.db),
        pending_pairs: state.pending_pairs.clone(),
        node_state: state.iroh_node.clone(),
        router_state: state.iroh_router.clone(),
        discovery_state: state.discovery.clone(),
    };
    match crate::sync::iroh_node::rebuild(&cfg).await {
        Ok(_) => true,
        Err(e) => {
            // The state arcs are empty now. `maybe_rebuild_endpoint`'s
            // no-endpoint branch above is what gets us out of this on a
            // later pass — without it a failed rebuild would strand the
            // app with no transport until restart, and a rebuild is most
            // likely to fail during exactly the network trouble that
            // triggered it.
            log::error!("iroh endpoint rebuild failed ({reason}): {e}");
            false
        }
    }
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
    let mut consecutive_failed_passes: u32 = 0;
    let mut last_self_test: Option<Instant> = None;
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
                network_changed |= matches!(n, Nudge::Resume | Nudge::NetworkChange);
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
        //
        // Detached, never awaited inline: iroh's Windows netmon services
        // this via WMI, which can wedge indefinitely on some networks —
        // the same pathology as the v0.7.3 launch-hang fix. Awaiting it
        // here held this loop hostage for four days (field incident
        // 2026-08-05..08): no passes, no errors, pure silence. The pass
        // proceeds regardless; a wedged call now costs one warning line
        // instead of the sync subsystem.
        if network_changed {
            let ep = app
                .try_state::<crate::AppState>()
                .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.endpoint.clone()));
            if let Some(ep) = ep {
                log::info!("network-change/resume — notifying iroh endpoint");
                tokio::spawn(async move {
                    let notified =
                        tokio::time::timeout(Duration::from_secs(10), ep.network_change()).await;
                    if notified.is_err() {
                        log::warn!(
                            "iroh network_change did not return within 10s — \
                             netmon likely wedged (WMI); dials continue on old paths"
                        );
                    }
                });
            }
        }

        // Warm workers acquire this same gate. Keep it through recovery so
        // no pass uses the endpoint while the watchdog replaces it.
        let pass_guard = coordinator::acquire_pass().await;
        let outcome = run_one_pass_locked(&db, &app).await;

        // Endpoint watchdog: desktop always, mobile while foreground only.
        // A pass where every peer failed is normal — the other device is
        // usually just asleep. A long RUN of them can also mean the
        // transport underneath us has died: nothing can reach us and our
        // dials go nowhere, while the process and this loop look perfectly
        // healthy. iroh does not recover from that and neither did we, so
        // the loop retried a corpse every 20 seconds for 42 hours (field
        // incident 2026-08-12..14). `maybe_rebuild_endpoint` tells the two
        // apart by dialing our own endpoint id.
        //
        // Background mobile passes never spend worker time on health probes.
        if cfg!(desktop) || coordinator::is_foreground() {
            // A peer with no iroh node id is reported Ok but never dialed;
            // counting it as a success would pin the streak at zero and
            // disable the watchdog for exactly the user who needs it.
            let dialed = outcome.attempted.saturating_sub(outcome.skipped);
            if dialed > 0 {
                if outcome.failed == dialed {
                    consecutive_failed_passes = consecutive_failed_passes.saturating_add(1);
                } else {
                    consecutive_failed_passes = 0;
                }
            } else {
                // Disabled sync, no peers, old peers without node ids, or
                // a peer-list error must disarm recovery. Missing endpoints
                // with eligible peers are counted as failures by the pass.
                consecutive_failed_passes = 0;
            }
            if maybe_rebuild_endpoint(&app, consecutive_failed_passes, &mut last_self_test).await {
                consecutive_failed_passes = 0;
                // Try the fresh transport at once rather than waiting out
                // the tick. (Launch and Retry(0) both start the retry
                // chain from zero; Launch just takes the debounce, which
                // is fine here — nothing is racing it.)
                let _ = nudge_tx.send(Nudge::Launch);
            }
        } else {
            consecutive_failed_passes = 0;
        }
        drop(pass_guard);

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
                log::warn!("sync retries exhausted; waiting for next trigger");
            }
        }
    }
}

/// Warm workers wait for their pass to finish using the scheduler's gate.
#[cfg_attr(not(mobile), allow(dead_code))]
pub async fn run_one_pass(db: &Arc<Mutex<Connection>>, app: &AppHandle) -> PassOutcome {
    let _pass = coordinator::acquire_pass().await;
    run_one_pass_locked(db, app).await
}

async fn run_one_pass_locked(db: &Arc<Mutex<Connection>>, app: &AppHandle) -> PassOutcome {
    const NONE: PassOutcome = PassOutcome {
        attempted: 0,
        failed: 0,
        skipped: 0,
    };
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
        log::warn!("sync pass: iroh endpoint not ready, skipping");
        let skipped = peer_list
            .iter()
            .filter(|peer| peer.iroh_node_id.is_none())
            .count();
        return PassOutcome {
            attempted: peer_list.len(),
            failed: peer_list.len() - skipped,
            skipped,
        };
    };
    let mut attempted = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    for peer in peer_list {
        attempted += 1;
        // Never dialed — see PassOutcome::skipped.
        if peer.iroh_node_id.is_none() {
            skipped += 1;
        }
        match with_peer_timeout(sync_one(db, app, &endpoint, &peer), SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                log::warn!("sync with {} ({}) failed: {e}", peer.name, peer.id);
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
                    "sync with {} ({}) exceeded {}s; retrying",
                    peer.name,
                    peer.id,
                    SYNC_PEER_TIMEOUT.as_secs(),
                );
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    "sync pass exceeded 30s; retrying",
                    crate::models::now_ms(),
                );
            }
        }
    }
    PassOutcome {
        attempted,
        failed,
        skipped,
    }
}

/// App-process side effects a completed pass wants performed. In the app
/// they cancel alerts and refresh the UI; the headless worker (cold
/// Android process) drops them — nothing is ringing and there is no
/// webview to refresh.
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
    sync_one_core(db, endpoint, &extra, peer, |applied| {
        crate::sync::iroh_handler::publish_applied(app, applied);
    })
    .await
}

/// Both directions share a connection; delivery cursors only advance after
/// their corresponding storage transaction or remote acknowledgment commits.
async fn sync_one_core(
    db: &Arc<Mutex<Connection>>,
    endpoint: &Endpoint,
    extra_seeds: &[iroh::TransportAddr],
    peer: &crate::db::peers::Peer,
    on_pulled: impl FnOnce(&crate::sync::storage::Applied),
) -> crate::error::AppResult<()> {
    use crate::db::sync_log;
    let Some(node_id) = peer.iroh_node_id.as_deref() else {
        return Ok(());
    };
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
    let session =
        iroh_client::Session::connect(endpoint, node_id, &seed, &peer.shared_secret).await?;
    let (pull_cursor, _) = {
        let conn = db.lock();
        peers::set_app_version(&conn, &peer.id, Some(&session.peer_version))?;
        sync_log::cursors(&conn, &peer.id)?
    };
    let pulled = session.pull(pull_cursor).await?;
    let applied = crate::sync::storage::apply_pulled(&db.lock(), &peer.id, &pulled)?;
    // A committed receive still updates the UI/alerts if the later send fails.
    on_pulled(&applied);
    // Applying a restored peer's new history invalidates its old outbound
    // acknowledgment in the same transaction. Read that decision after commit.
    let (_, push_cursor) = sync_log::cursors(&db.lock(), &peer.id)?;
    let outgoing = sync_log::snapshot(&db.lock(), push_cursor.as_ref())?;
    // Also acknowledge empty snapshots: this initializes migration cursors and
    // proves both directions work before reporting complete sync success.
    let ack = session.push(outgoing).await?;
    {
        let conn = db.lock();
        sync_log::mark_pushed(&conn, &peer.id, &ack)?;
        peers::record_sync_ok(
            &conn,
            &peer.id,
            session.dial.remote_addrs_json.as_deref(),
            crate::models::now_ms(),
        )?;
    }
    log::debug!(
        "synced with {}: one connection, {}ms dial, path={}",
        peer.name,
        session.dial.duration_ms,
        if session.dial.used_relay {
            "relay"
        } else {
            "direct"
        }
    );
    Ok(())
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
    const NONE: PassOutcome = PassOutcome {
        attempted: 0,
        failed: 0,
        skipped: 0,
    };
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
    let mut skipped = 0usize;
    for peer in peer_list {
        attempted += 1;
        // Never dialed — see PassOutcome::skipped.
        if peer.iroh_node_id.is_none() {
            skipped += 1;
        }
        let fut = async { sync_one_core(db, endpoint, &[], &peer, |_| {}).await };
        match with_peer_timeout(fut, SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                log::warn!("headless sync with {} failed: {e}", peer.name);
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
                    "sync pass exceeded 30s; retrying",
                    crate::models::now_ms(),
                );
            }
        }
    }
    PassOutcome {
        attempted,
        failed,
        skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        should_self_test, with_peer_timeout, PeerSyncResult, FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT,
        SELF_TEST_COOLDOWN, SYNC_PEER_TIMEOUT,
    };
    use crate::error::{AppError, AppResult};
    use crate::sync::types::{ChangeSet, RemoteDayNote};
    use std::time::Duration;

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn empty_change_set() -> ChangeSet {
        ChangeSet {
            server_time_ms: 0,
            reminders: vec![],
            tombstones: vec![],
            lanes: vec![],
            thoughts: vec![],
            day_notes: vec![],
        }
    }

    /// A short run of failures is just a peer that hasn't woken up yet, and
    /// must not cost even a self-test.
    #[test]
    fn a_brief_run_of_failures_is_not_enough_to_suspect_ourselves() {
        assert!(!should_self_test(0, None));
        assert!(!should_self_test(
            FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT - 1,
            None
        ));
    }

    /// Once failures persist, spend one self-test to find out whose fault
    /// it is. What that test *returns* decides the rebuild; this only
    /// decides whether to ask.
    #[test]
    fn a_sustained_run_of_failures_earns_a_self_test() {
        assert!(should_self_test(
            FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT,
            None
        ));
        assert!(should_self_test(
            FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT + 100,
            None
        ));
    }

    /// The cooldown is what keeps an asleep peer cheap. Every pass fails
    /// all night while the phone sits in Android's freezer, so without this
    /// the watchdog would bind a throwaway endpoint every 20 seconds until
    /// morning.
    #[test]
    fn the_cooldown_rate_limits_self_tests_while_a_peer_sleeps() {
        let many = FAILED_PASSES_BEFORE_ENDPOINT_SUSPECT + 500;
        assert!(!should_self_test(many, Some(Duration::from_secs(0))));
        assert!(!should_self_test(
            many,
            Some(SELF_TEST_COOLDOWN - Duration::from_secs(1))
        ));
        assert!(should_self_test(many, Some(SELF_TEST_COOLDOWN)));
    }

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

    /// A committed day-note batch refreshes only its own view.
    #[test]
    fn a_pulled_day_note_applies_and_flips_only_its_own_flag() {
        let conn = test_conn();
        let mut set = empty_change_set();
        set.day_notes.push(RemoteDayNote {
            day: "2026-08-23".into(),
            body: "pulled from a peer".into(),
            created_at: 1,
            updated_at: 2,
        });

        let effects = crate::sync::storage::apply(&conn, &set).unwrap();
        assert!(
            effects.to_cancel.is_empty(),
            "a day note never cancels an alert"
        );
        assert_eq!(
            crate::db::day_notes::get(&conn, "2026-08-23")
                .unwrap()
                .unwrap()
                .body,
            "pulled from a peer"
        );

        assert!(effects.day_notes_changed, "the day panel must refresh");
        assert!(
            !effects.reminders_changed,
            "a day note alone must not trigger the reminders board's refresh"
        );
        assert!(!effects.thoughts_changed);
    }

    /// An empty pull is the common case — nothing changed since last time —
    /// and must not fire any refresh event.
    #[test]
    fn an_empty_pull_sets_no_effects() {
        let conn = test_conn();
        let set = empty_change_set();

        let effects = crate::sync::storage::apply(&conn, &set).unwrap();
        assert!(effects.to_cancel.is_empty());

        assert!(!effects.reminders_changed);
        assert!(!effects.thoughts_changed);
        assert!(!effects.day_notes_changed);
    }
}
