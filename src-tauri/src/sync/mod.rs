//! Peer-to-peer sync over iroh.
//!
//! Each Klaxon instance runs an iroh `Endpoint` bound on startup. Two
//! ALPNs are accepted on it:
//!
//!   - `klaxon/sync/0` — authenticated RPC (Ping / Pull / Push)
//!   - `klaxon/pair/0` — pre-auth pair handshake
//!
//! Discovery happens via mDNS on the LAN; iroh's relay network handles
//! the cross-network reachability case. Auth is a per-pair shared
//! secret established during pairing.

pub mod discovery;
pub mod iroh_client;
pub mod iroh_handler;
pub mod iroh_node;
pub mod ops;
pub mod pair_handler;
pub mod proto;
pub mod task;
pub mod types;

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;
use tokio::sync::oneshot;

use crate::db::settings as cfg;
use crate::sync::types::PairDecision;

/// Pending pair handshakes the local UI hasn't decided on yet. Keyed
/// by `request_id`; the oneshot sender flips Approve/Decline from the
/// `approve_pair_request` / `decline_pair_request` Tauri commands.
pub type PendingPairs = Arc<Mutex<HashMap<String, oneshot::Sender<PairDecision>>>>;

#[derive(Debug, Clone)]
pub struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
}

pub fn read_identity(db: &Arc<Mutex<Connection>>) -> DeviceIdentity {
    let conn = db.lock();
    let device_id = cfg::get(&conn, "device_id")
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".to_string());
    let device_name = cfg::get(&conn, "device_name")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Klaxon".to_string());
    DeviceIdentity { device_id, device_name }
}

pub fn read_enabled(db: &Arc<Mutex<Connection>>) -> bool {
    let conn = db.lock();
    cfg::get(&conn, "sync_enabled")
        .ok()
        .flatten()
        .map(|s| s == "true")
        .unwrap_or(false)
}

pub fn generate_secret() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Six-digit Short Authentication String shown on both devices during
/// the tap-to-pair flow. Both sides compute it identically from values
/// they both have available: the per-attempt `request_id` +
/// `ephemeral_token` (set by the initiator), and both peers' iroh
/// NodeIds. The NodeId-based scheme lets ticket pairing work without
/// the initiator needing to know the responder's `device_id` up front.
pub fn confirmation_code(
    request_id: &str,
    ephemeral_token: &str,
    initiator_node_id: &str,
    responder_node_id: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(request_id.as_bytes());
    hasher.update(b"|");
    hasher.update(ephemeral_token.as_bytes());
    hasher.update(b"|");
    hasher.update(initiator_node_id.as_bytes());
    hasher.update(b"|");
    hasher.update(responder_node_id.as_bytes());
    let hash = hasher.finalize();
    let bytes: [u8; 4] = hash[..4].try_into().unwrap_or([0; 4]);
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    format!("{:03}-{:03}", n / 1000, n % 1000)
}

