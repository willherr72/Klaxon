//! mDNS discovery: announce ourselves on the LAN and browse for other
//! Klaxon instances. Service type: `_klaxon._tcp.local.`
//!
//! Started only when `sync_enabled` is true at app boot.

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

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredPeer {
    pub device_id: String,
    pub device_name: String,
    pub url: String,
    pub last_seen_ms: i64,
}

#[derive(Clone)]
pub struct DiscoveryHandle {
    pub peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
    _daemon: Arc<ServiceDaemon>,
}

pub fn start(identity: DeviceIdentity, port: u16) -> AppResult<DiscoveryHandle> {
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

    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &host_name,
        local_ips.as_slice(),
        port,
        Some(props),
    )
    .map_err(|e| AppError::Invalid(format!("mDNS service info: {e}")))?;

    daemon
        .register(info)
        .map_err(|e| AppError::Invalid(format!("mDNS register: {e}")))?;
    log::info!(
        "mDNS announce: {} on port {} ({} addrs)",
        identity.device_name,
        port,
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
                        let port = info.get_port();
                        let chosen = info
                            .get_addresses()
                            .iter()
                            .find(|a| a.is_ipv4() && !a.is_loopback())
                            .copied()
                            .or_else(|| info.get_addresses().iter().next().copied());
                        let Some(addr) = chosen else { continue };
                        let url = format!("http://{addr}:{port}");

                        let peer = DiscoveredPeer {
                            device_id: device_id.clone(),
                            device_name: if device_name.is_empty() {
                                "Klaxon device".to_string()
                            } else {
                                device_name
                            },
                            url,
                            last_seen_ms: now_ms(),
                        };
                        log::info!(
                            "mDNS discovered: {} ({}) → {}",
                            peer.device_name,
                            peer.device_id,
                            peer.url
                        );
                        peers_thread.lock().insert(device_id, peer);
                    }
                    ServiceEvent::ServiceRemoved(_ty, fullname) => {
                        log::debug!("mDNS removed: {fullname}");
                        // Trim entries we can match by instance prefix.
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
