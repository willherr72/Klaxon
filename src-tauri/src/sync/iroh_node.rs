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

use iroh::endpoint::presets;
pub use iroh::protocol::Router;
use iroh::{Endpoint, SecretKey};

use crate::error::{AppError, AppResult};
use crate::sync::iroh_handler::SyncHandler;
use crate::sync::proto::ALPN_SYNC;

/// Filename for the persisted Ed25519 secret key inside the app data dir.
/// Raw 32 bytes, not PEM — there's no interop need and binary keeps it tight.
const SECRET_FILE: &str = "klaxon-iroh-secret.bin";

#[derive(Clone)]
pub struct IrohNode {
    pub endpoint: Endpoint,
    pub node_id: String,
}

/// Wrap an existing `Endpoint` in an iroh `Router` that dispatches incoming
/// `klaxon/sync/0` connections to the given `SyncHandler`. The returned
/// `Router` must be kept alive — dropping it aborts the accept loop.
pub fn spawn_sync_router(endpoint: Endpoint, handler: SyncHandler) -> Router {
    Router::builder(endpoint)
        .accept(ALPN_SYNC, handler)
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
