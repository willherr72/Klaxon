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
        Ok(h) => *cfg.discovery_state.lock() = Some(h),
        Err(e) => log::warn!("mDNS discovery failed to start: {e}"),
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

/// Tear the transport down and stand it back up from scratch.
///
/// The endpoint id is stable across this — it comes from the persisted
/// secret key — so peers keep reaching us at the same address and no
/// re-pairing is needed.
pub async fn rebuild(cfg: &BringUp) -> AppResult<String> {
    log::warn!("rebuilding iroh endpoint — transport looked dead");

    // Take the handles out under the lock, then drop/close them OUTSIDE it:
    // `close()` is async and these are parking_lot mutexes, which must never
    // be held across an await.
    let old_router = cfg.router_state.lock().take();
    let old_node = cfg.node_state.lock().take();
    *cfg.discovery_state.lock() = None;

    // Dropping the Router aborts its accept loop; closing the endpoint frees
    // the UDP sockets so the new bind doesn't race the old one for a port.
    drop(old_router);
    if let Some(node) = old_node {
        node.endpoint.close().await;
    }

    let id = bring_up(cfg).await?;
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
