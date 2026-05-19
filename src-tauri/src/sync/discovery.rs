//! mDNS discovery: announce ourselves on the LAN and browse for other
//! Klaxon instances. Service type: `_klaxon._tcp.local.`.
//!
//! v0.3 the port number we advertise is meaningless (sync rides iroh,
//! not HTTP), but mDNS service records require one — we hardcode it.
//! What matters in the TXT record is `device_id`, `device_name`, and
//! the iroh `nid` (EndpointId).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::models::now_ms;
use crate::sync::DeviceIdentity;

const SERVICE_TYPE: &str = "_klaxon._tcp.local.";
/// Cosmetic port — mDNS requires a value, sync no longer uses it.
const ADVERTISED_PORT: u16 = 7124;

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub device_name: String,
    pub last_seen_ms: i64,
    /// Iroh EndpointId from the mDNS TXT record. `None` would mean the
    /// peer is on a pre-v0.3 build; v0.3 will refuse to pair without it.
    pub node_id: Option<String>,
}

#[derive(Clone)]
pub struct DiscoveryHandle {
    pub peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
    _daemon: Arc<ServiceDaemon>,
}

pub fn start(
    identity: DeviceIdentity,
    node_id: Option<String>,
) -> AppResult<DiscoveryHandle> {
    let daemon =
        ServiceDaemon::new().map_err(|e| AppError::Invalid(format!("mDNS daemon: {e}")))?;

    let local_ips: Vec<IpAddr> = local_ip_address::list_afinet_netifas()
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|(_name, ip)| if ip.is_loopback() { None } else { Some(ip) })
        .collect();
    if local_ips.is_empty() {
        return Err(AppError::Invalid("no non-loopback IPs found".into()));
    }

    let host_name = format!("{}.local.", sanitize_host(&identity.device_id));
    let instance = sanitize_instance(&identity.device_name, &identity.device_id);

    let mut props = HashMap::new();
    props.insert("device_id".to_string(), identity.device_id.clone());
    props.insert("device_name".to_string(), identity.device_name.clone());
    props.insert(
        "version".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    );
    // mDNS TXT records are limited to 255 bytes per pair; base32 NodeId
    // (~52 chars) fits comfortably.
    if let Some(nid) = node_id.as_deref() {
        props.insert("nid".to_string(), nid.to_string());
    }

    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &host_name,
        local_ips.as_slice(),
        ADVERTISED_PORT,
        Some(props),
    )
    .map_err(|e| AppError::Invalid(format!("mDNS service info: {e}")))?;

    daemon
        .register(info)
        .map_err(|e| AppError::Invalid(format!("mDNS register: {e}")))?;
    log::info!(
        "mDNS announce: {} ({} addrs)",
        identity.device_name,
        local_ips.len()
    );

    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| AppError::Invalid(format!("mDNS browse: {e}")))?;
    let peers = Arc::new(Mutex::new(HashMap::new()));
    let peers_thread = peers.clone();
    let our_id = identity.device_id.clone();

    std::thread::Builder::new()
        .name("klaxon-mdns-browse".into())
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let props = info.get_properties();
                        let device_id = props
                            .get_property_val_str("device_id")
                            .unwrap_or("")
                            .to_string();
                        if device_id.is_empty() || device_id == our_id {
                            continue;
                        }
                        let device_name = props
                            .get_property_val_str("device_name")
                            .unwrap_or("")
                            .to_string();
                        let node_id = props
                            .get_property_val_str("nid")
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());

                        let peer = DiscoveredPeer {
                            device_id: device_id.clone(),
                            device_name: if device_name.is_empty() {
                                "Klaxon device".to_string()
                            } else {
                                device_name
                            },
                            last_seen_ms: now_ms(),
                            node_id,
                        };
                        log::info!(
                            "mDNS discovered: {} ({})",
                            peer.device_name,
                            peer.device_id,
                        );
                        peers_thread.lock().insert(device_id, peer);
                    }
                    ServiceEvent::ServiceRemoved(_ty, fullname) => {
                        log::debug!("mDNS removed: {fullname}");
                        peers_thread
                            .lock()
                            .retain(|_, p| !fullname.starts_with(&p.device_name));
                    }
                    _ => {}
                }
            }
            log::info!("mDNS browse loop ended");
        })
        .map_err(|e| AppError::Invalid(format!("spawn mdns thread: {e}")))?;

    Ok(DiscoveryHandle {
        peers,
        _daemon: Arc::new(daemon),
    })
}

/// Strip everything except alphanumerics + dashes. mDNS hostnames must be
/// safe for DNS labels.
fn sanitize_host(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if s.is_empty() {
        "klaxon".into()
    } else {
        s
    }
}

/// Service instance name — display name plus a stable disambiguator from the
/// device id so two devices with the same name don't collide.
fn sanitize_instance(name: &str, id: &str) -> String {
    let n: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == ' ' || *c == '_')
        .collect();
    let trimmed = n.trim();
    let suffix: String = id.chars().take(6).collect();
    if trimmed.is_empty() {
        format!("Klaxon-{suffix}")
    } else {
        format!("{trimmed} ({suffix})")
    }
}
