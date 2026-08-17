//! v0.3 iroh transport — endpoint lifecycle.
//!
//! Each Klaxon device persists a 32-byte Ed25519 secret key in app data dir;
//! the matching public key is the device's `NodeId`, which is the stable
//! cross-network identifier peers exchange during pairing and use forever
//! after to reach each other regardless of which network they're on.
//!
//! Phase 1 scope: bring the endpoint up alongside the existing HTTPS sync
//! server, expose the NodeId for advertising over mDNS, and persist the
//! secret key so the identity is stable across restarts. No ALPN handlers
//! are registered yet — that lands in phase 2 with the RPC protocol.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use iroh::endpoint::presets;
pub use iroh::protocol::Router;
use iroh::{Endpoint, SecretKey, Watcher};
use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};
use crate::sync::discovery::DiscoveryHandle;
use crate::sync::iroh_handler::SyncHandler;
use crate::sync::pair_handler::PairHandler;
use crate::sync::proto::{ALPN_PAIR, ALPN_SYNC};
use crate::sync::{DeviceIdentity, PendingPairs};

/// Filename for the persisted Ed25519 secret key inside the app data dir.
/// Raw 32 bytes, not PEM — there's no interop need and binary keeps it tight.
const SECRET_FILE: &str = "klaxon-iroh-secret.bin";

/// Cap on how long a rebuild waits for the old endpoint to drain.
const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Cap on the self-test dial. A reachable endpoint answers in well under a
/// second (232ms measured over the relay on the incident machine); anything
/// slower than this is indistinguishable from unreachable for our purposes.
const SELF_TEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(6);

/// How long to give the probe endpoint to reach a relay before treating the
/// result as inconclusive. Measured ~3s on the incident machine, but this
/// must clear iroh's own `NET_REPORT_TIMEOUT` (10s) — `online()` waits on a
/// net report to pick a relay, so a shorter budget would call a merely slow
/// network "offline" and quietly disarm the watchdog on exactly the
/// degraded links it exists for.
const PROBE_RELAY_WAIT: std::time::Duration = std::time::Duration::from_secs(12);

/// Cap on `Endpoint::bind()`.
///
/// `bind()` is the most dangerous await in this codebase. It initializes
/// iroh's network monitor, which on Windows reaches
/// `netwatch::interfaces::windows::default_route()` → a WMI query. That
/// path has already produced two shipped hotfixes: v0.7.3 (deadlock at
/// `CoSetProxyBlanket`, window never appeared) and v0.7.4 (four days of
/// sync silence). `spawn_blocking` keeps it off the worker thread but puts
/// no bound on the wait.
///
/// At launch that risk is contained by running bring-up on its own task.
/// The watchdog has no such shelter: it awaits inline in the sync loop, and
/// only after five failed passes — exactly the network conditions where
/// netmon misbehaves. Unbounded here would mean no passes, no retries, no
/// watchdog, no log, restart-only: worse than the outage it exists to fix.
const BIND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone)]
pub struct IrohNode {
    pub endpoint: Endpoint,
    pub node_id: String,
}

/// Wrap an existing `Endpoint` in an iroh `Router` that dispatches incoming
/// connections on both `klaxon/sync/0` (authenticated RPC) and
/// `klaxon/pair/0` (pre-auth pair handshake) to the right handler. The
/// returned `Router` must be kept alive — dropping it aborts the accept
/// loop on both ALPNs.
pub fn spawn_sync_router(
    endpoint: Endpoint,
    sync_handler: SyncHandler,
    pair_handler: PairHandler,
) -> Router {
    Router::builder(endpoint)
        .accept(ALPN_SYNC, sync_handler)
        .accept(ALPN_PAIR, pair_handler)
        .spawn()
}

/// Start the iroh endpoint, loading or generating the local secret key as
/// needed. The returned `IrohNode` holds a cloneable `Endpoint` handle —
/// every clone refers to the same underlying socket and dialer.
pub async fn start(app_dir: &Path) -> AppResult<IrohNode> {
    let secret = load_or_generate_secret(app_dir)?;

    // `presets::N0` enables the n0-operated relay network + address
    // discovery — what we want for cross-network reachability. We can
    // swap to a self-hosted setup later by changing the preset.
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .bind()
        .await
        .map_err(|e| AppError::Invalid(format!("iroh endpoint bind: {e}")))?;

    // iroh 1.0 renamed NodeId → EndpointId; same Ed25519 pubkey concept.
    // We surface it to Klaxon users / mDNS as "node_id" — easier to map onto
    // the existing v0.2 mental model of "the other device".
    let node_id = endpoint.id().to_string();
    log::info!("iroh endpoint online — node_id={}", short(&node_id));

    Ok(IrohNode { endpoint, node_id })
}

/// Everything needed to stand the iroh transport up.
///
/// Bundled into one struct so launch and the watchdog's rebuild go through
/// exactly the same code path. A rebuild that drifted from launch — a
/// forgotten router, an unregistered ALPN, discovery left down — would
/// produce an endpoint that looks alive and answers nothing, which is
/// precisely the failure this whole mechanism exists to end.
#[derive(Clone)]
pub struct BringUp {
    pub db: Arc<Mutex<Connection>>,
    pub app: AppHandle,
    pub app_dir: PathBuf,
    pub identity: DeviceIdentity,
    pub pending_pairs: PendingPairs,
    pub node_state: Arc<Mutex<Option<IrohNode>>>,
    pub router_state: Arc<Mutex<Option<Router>>>,
    pub discovery_state: Arc<Mutex<Option<DiscoveryHandle>>>,
}

/// Bind the endpoint, attach the router, advertise over mDNS, and publish
/// all three into the shared state. Returns the endpoint id.
///
/// Caller must be on a tokio runtime and OFF the main thread — `start`
/// initializes iroh's Windows network monitor, whose WMI calls deadlock on
/// a COM-STA thread that isn't pumping messages (the v0.7.3 launch hang).
pub async fn bring_up(cfg: &BringUp) -> AppResult<String> {
    let node = start(&cfg.app_dir).await?;
    *cfg.node_state.lock() = Some(node.clone());

    let sync_handler = SyncHandler {
        db: cfg.db.clone(),
        identity: cfg.identity.clone(),
        app: Some(cfg.app.clone()),
    };
    let pair_handler = PairHandler {
        db: cfg.db.clone(),
        identity: cfg.identity.clone(),
        pending_pairs: cfg.pending_pairs.clone(),
        app: cfg.app.clone(),
        local_node_id: node.node_id.clone(),
    };
    *cfg.router_state.lock() = Some(spawn_sync_router(
        node.endpoint.clone(),
        sync_handler,
        pair_handler,
    ));
    log::info!(
        "iroh router attached: ALPNs {} + {}",
        String::from_utf8_lossy(ALPN_SYNC),
        String::from_utf8_lossy(ALPN_PAIR),
    );

    // mDNS carries the iroh QUIC port so LAN peers dial direct instead of
    // going through address lookup.
    let iroh_port = node.endpoint.bound_sockets().first().map(|sa| sa.port());
    match crate::sync::discovery::start(
        cfg.identity.clone(),
        Some(node.node_id.clone()),
        iroh_port,
    ) {
        Ok(h) => {
            // Swap, don't clear-then-fill: on a rebuild the old daemon must
            // survive until its replacement exists, or a discovery failure
            // (no non-loopback IP — very likely during the network trouble
            // that triggered the rebuild) would leave LAN dialing dead
            // until the next restart.
            let previous = cfg.discovery_state.lock().replace(h);
            if let Some(old) = previous {
                old.shutdown();
            }
        }
        Err(e) => log::warn!(
            "mDNS discovery failed to start: {e} — keeping the previous \
             registration rather than going dark on the LAN"
        ),
    }

    Ok(node.node_id)
}

/// Does the endpoint currently hold a live relay home?
///
/// This is the signal that separates "the peer is away" from "our own
/// transport is dead". A relay-less endpoint cannot be dialed by anyone and
/// its own dials have nowhere to go, yet nothing else about the process
/// looks wrong: the sync loop keeps running and keeps reporting the peer
/// unreachable, forever. Field incident 2026-08-12..14 ran 42 hours in
/// exactly that state.
pub fn relay_connected(endpoint: &Endpoint) -> bool {
    endpoint
        .home_relay_status()
        .get()
        .iter()
        .any(|status| status.is_connected())
}

/// Can anything actually reach us right now?
///
/// Binds a throwaway endpoint and dials our OWN endpoint id. This is
/// positive evidence rather than inference: a healthy transport answers its
/// own dial in milliseconds (232ms measured), while the dead one from the
/// 2026-08-12..14 incident timed out even over loopback. That gap is what
/// separates "our peer is asleep" — the ordinary overnight case, which must
/// never cost a rebuild — from "we are unreachable and will stay that way".
///
/// Deliberately does NOT trust `relay_connected()` alone: a wedged
/// component reporting itself healthy is exactly what a self-report cannot
/// catch, and this call cannot be fooled that way.
///
/// The dial is deliberately UNSEEDED: it resolves our id and comes back at
/// us over a relay, which is strictly HARDER than a real peer's dial (those
/// carry persisted and mDNS seeds). That is the point — by the time this
/// runs, the seeded paths have already failed five passes running. Seeding
/// it with our own addresses would be a much weaker
/// test — it would reach our router over loopback and prove only that the
/// socket is bound and the accept loop alive, both of which were TRUE
/// throughout the 42-hour outage. A test that passes during the failure it
/// exists to detect is worse than no test: it disarms the watchdog
/// silently.
///
/// The probe's own relay connection is the control that keeps an offline
/// machine from looking like a dead endpoint. If the probe cannot reach a
/// relay either, this machine has no working internet and nothing can be
/// concluded about our endpoint — so the answer is `None`, not `false`.
///
/// Returns `None` when the test could not run at all (no probe endpoint
/// bound in time, or no connectivity to judge against), which is not
/// evidence either way. Measured on the incident machine: 232ms when
/// healthy, 30s timeout when dead.
pub async fn self_reachable(our_id: &str) -> Option<bool> {
    use std::str::FromStr;

    // Drill hook. The rebuild path is the one part of this mechanism that
    // cannot be unit-tested (it needs a live AppHandle and a real socket),
    // so there has to be SOME way to make it run on demand — an untested
    // recovery path is not a recovery path. Debug builds only: this cannot
    // exist in anything that ships.
    #[cfg(debug_assertions)]
    if std::env::var("KLAXON_DEBUG_FORCE_DEAD_ENDPOINT").is_ok() {
        log::warn!("self-test: FORCED failure via KLAXON_DEBUG_FORCE_DEAD_ENDPOINT");
        return Some(false);
    }

    let id = iroh::EndpointId::from_str(our_id).ok()?;
    let probe = tokio::time::timeout(BIND_TIMEOUT, Endpoint::builder(presets::N0).bind())
        .await
        .map_err(|_| log::warn!("self-test: binding a probe endpoint timed out"))
        .ok()?
        .ok()?;

    // Control: can a brand-new endpoint reach a relay at all? If not, our
    // own endpoint's silence tells us nothing about its health.
    let online = tokio::time::timeout(PROBE_RELAY_WAIT, probe.online())
        .await
        .is_ok();

    let verdict = if online {
        Some(matches!(
            tokio::time::timeout(SELF_TEST_TIMEOUT, probe.connect(id, ALPN_SYNC)).await,
            Ok(Ok(_))
        ))
    } else {
        // Offline, or a network that blocks n0's relays — we cannot tell
        // which, and neither lets us judge our own endpoint.
        log::warn!(
            "self-test inconclusive: a fresh endpoint could not reach a relay either \
             within {PROBE_RELAY_WAIT:?} — not blaming ours"
        );
        None
    };

    // Best-effort teardown; the probe is disposable either way.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, probe.close()).await;
    verdict
}

/// Tear the transport down and stand it back up from scratch.
///
/// The endpoint id is stable across this — it comes from the persisted
/// secret key — so peers keep reaching us at the same address and no
/// re-pairing is needed.
pub async fn rebuild(cfg: &BringUp) -> AppResult<String> {
    log::warn!("rebuilding iroh endpoint — transport looked dead");

    // Take the handles out under the lock, then drop/close them OUTSIDE it:
    // `close()` is async and these are parking_lot mutexes, which must never
    // be held across an await. Discovery is left alone here — `bring_up`
    // swaps it only once a replacement exists.
    let old_router = cfg.router_state.lock().take();
    let old_node = cfg.node_state.lock().take();

    // Dropping the Router aborts its accept loop; closing the endpoint frees
    // the UDP sockets so the new bind doesn't race the old one for a port.
    drop(old_router);
    if let Some(node) = old_node {
        // BOUNDED. `Endpoint::close()` waits for all connections to drain
        // with no timeout of its own, and we only get here when the
        // transport already looks dead — the exact state where draining may
        // never finish. Awaiting it unbounded would hang the sync loop with
        // both state arcs already emptied: no transport, no recovery, no
        // log, restart-only. That is the v0.7.4 shape and it is strictly
        // worse than the outage this function exists to end. A timed-out
        // close leaks a socket until process exit; that is the cheaper bug.
        if tokio::time::timeout(CLOSE_TIMEOUT, node.endpoint.close())
            .await
            .is_err()
        {
            log::warn!(
                "endpoint close did not finish within {CLOSE_TIMEOUT:?} — \
                 abandoning the old socket and rebinding anyway"
            );
        }
    }

    // Bounded for the same reason as the teardown above: this reaches
    // `Endpoint::bind()`, and we are inline in the sync loop with both
    // state arcs already emptied. A hang here is the one outcome strictly
    // worse than the outage — and a timed-out bring-up is already a
    // recoverable state (the watchdog's no-endpoint branch retries).
    let id = tokio::time::timeout(BIND_TIMEOUT, bring_up(cfg))
        .await
        .map_err(|_| {
            AppError::Invalid(format!("iroh bring-up did not finish within {BIND_TIMEOUT:?}"))
        })??;
    log::warn!("iroh endpoint rebuilt — id={} (unchanged)", short(&id));
    Ok(id)
}

/// Read the secret key from `app_dir/klaxon-iroh-secret.bin`, generating and
/// persisting a fresh one if absent. The file is binary — exactly 32 bytes.
fn load_or_generate_secret(app_dir: &Path) -> AppResult<SecretKey> {
    let path = secret_path(app_dir);

    if path.exists() {
        let bytes = std::fs::read(&path)
            .map_err(|e| AppError::Invalid(format!("read iroh secret: {e}")))?;
        let arr: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            AppError::Invalid(format!(
                "iroh secret at {} has wrong length ({} bytes, expected 32)",
                path.display(),
                bytes.len()
            ))
        })?;
        return Ok(SecretKey::from_bytes(&arr));
    }

    let secret = SecretKey::generate();
    let bytes = secret.to_bytes();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, bytes)
        .map_err(|e| AppError::Invalid(format!("persist iroh secret: {e}")))?;
    log::info!("generated iroh secret at {}", path.display());
    Ok(secret)
}

fn secret_path(app_dir: &Path) -> PathBuf {
    app_dir.join(SECRET_FILE)
}

/// Short prefix of a NodeId hex/base32 string for log lines.
pub fn short(node_id: &str) -> String {
    node_id.chars().take(12).collect()
}
