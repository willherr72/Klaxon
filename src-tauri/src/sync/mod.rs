//! Peer-to-peer sync over LAN.
//!
//! Each Klaxon instance can run an embedded HTTP server (axum) and a sync
//! task that periodically pushes local changes to / pulls remote changes
//! from each paired peer. Auth is a per-pair shared secret.
//!
//! v0.2 first slice: manual peer config (no mDNS, no pairing UX).

pub mod client;
pub mod discovery;
pub mod server;
pub mod task;
pub mod tls;
pub mod types;

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::db::settings as cfg;

const DEFAULT_PORT: u16 = 7124;

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

pub fn read_port(db: &Arc<Mutex<Connection>>) -> u16 {
    let conn = db.lock();
    cfg::get(&conn, "sync_port")
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
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

/// Six-digit Short Authentication String shown on both devices during the
/// tap-to-pair flow. Both sides compute it identically. LAN-trusted: not
/// MITM-resistant on hostile networks (would need DH+SAS for that).
pub fn confirmation_code(
    request_id: &str,
    ephemeral_token: &str,
    initiator_id: &str,
    responder_id: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(request_id.as_bytes());
    hasher.update(b"|");
    hasher.update(ephemeral_token.as_bytes());
    hasher.update(b"|");
    hasher.update(initiator_id.as_bytes());
    hasher.update(b"|");
    hasher.update(responder_id.as_bytes());
    let hash = hasher.finalize();
    let bytes: [u8; 4] = hash[..4].try_into().unwrap_or([0; 4]);
    let n = u32::from_be_bytes(bytes) % 1_000_000;
    format!("{:03}-{:03}", n / 1000, n % 1000)
}

/// Best-effort URL we'd advertise to a peer — `https://<lan-ip>:<port>`.
/// Sync runs over TLS with self-signed certs pinned per peer.
pub fn local_url(port: u16) -> String {
    match local_ip_address::local_ip() {
        Ok(ip) => format!("https://{ip}:{port}"),
        Err(_) => format!("https://127.0.0.1:{port}"),
    }
}
