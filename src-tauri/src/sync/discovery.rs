//! mDNS discovery: announce ourselves on the LAN and browse for other
//! Klaxon instances. Service type: `_klaxon._tcp.local.`.
//!
//! v0.3 the port number we advertise is meaningless (sync rides iroh,
//! not HTTP), but mDNS service records require one — we hardcode it.
//! What matters in the TXT record is `device_id`, `device_name`, and
//! the iroh `nid` (EndpointId).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
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
    /// v0.5.1: the peer's dialable iroh addresses (LAN IP + real QUIC
    /// port) from the TXT `addrs` key. Seeded into dials; the frontend
    /// pairing list doesn't need them.
    #[serde(skip)]
    pub sock_addrs: Vec<SocketAddr>,
}

#[derive(Clone)]
pub struct DiscoveryHandle {
    pub peers: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
    _daemon: Arc<ServiceDaemon>,
}

impl DiscoveryHandle {
    /// Stop the mDNS daemon and withdraw our service registration.
    ///
    /// Dropping the handle is NOT enough: `mdns-sd` implements no `Drop`,
    /// and its run loop exits only on an explicit `Exit` command — it uses
    /// `try_recv` and ignores channel disconnection. A dropped handle
    /// therefore leaves the daemon thread alive, holding its multicast
    /// sockets and still answering queries with a now-dead iroh port. That
    /// matters because the endpoint watchdog re-registers on every rebuild:
    /// without this, each rebuild would leak a daemon that actively
    /// poisons peers' LAN dial seeds with stale ports.
    pub fn shutdown(&self) {
        // Only the last holder should stop the daemon — the handle is Clone
        // and consumers may still be reading `peers`.
        if Arc::strong_count(&self._daemon) > 1 {
            log::debug!("mDNS shutdown skipped — handle still shared");
            return;
        }
        match self._daemon.shutdown() {
            Ok(_) => log::info!("mDNS daemon stopped"),
            Err(e) => log::warn!("mDNS daemon shutdown failed: {e}"),
        }
    }

    /// Dialable iroh addresses for a peer, by its iroh node id — fresh from
    /// the LAN right now, or empty if the peer isn't currently visible.
    pub fn addrs_for_node(&self, node_id: &str) -> Vec<SocketAddr> {
        self.peers
            .lock()
            .values()
            .find(|p| p.node_id.as_deref() == Some(node_id))
            .map(|p| p.sock_addrs.clone())
            .unwrap_or_default()
    }
}

pub fn start(
    identity: DeviceIdentity,
    node_id: Option<String>,
    iroh_port: Option<u16>,
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
    // The A-record port above is cosmetic; this is the port that matters —
    // it makes the discovered addresses actually dialable by iroh.
    if let Some(port) = iroh_port {
        props.insert("addrs".to_string(), compose_addrs_txt(&local_ips, port));
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
                            sock_addrs: props
                                .get_property_val_str("addrs")
                                .map(parse_addrs_txt)
                                .unwrap_or_default(),
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

/// Compose the TXT `addrs` value: our LAN IPs each paired with the iroh
/// QUIC port. The mDNS A-record port (`ADVERTISED_PORT`) is cosmetic —
/// this key is what makes discovered peers actually dialable.
/// TXT values are capped at 255 bytes; cap at 6 addresses to stay under.
fn compose_addrs_txt(ips: &[IpAddr], iroh_port: u16) -> String {
    ips.iter()
        .take(6)
        .map(|ip| SocketAddr::new(*ip, iroh_port).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Parse a peer's TXT `addrs` value. Malformed entries are skipped —
/// a peer on a future version with a different format must not break us.
fn parse_addrs_txt(raw: &str) -> Vec<SocketAddr> {
    raw.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
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

#[cfg(test)]
mod tests {
    use super::{compose_addrs_txt, parse_addrs_txt};
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn addrs_txt_roundtrips() {
        let ips = vec![
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
        ];
        let txt = compose_addrs_txt(&ips, 54321);
        let parsed = parse_addrs_txt(&txt);
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().all(|sa| sa.port() == 54321));
    }

    #[test]
    fn garbage_addrs_are_skipped_not_fatal() {
        let parsed = parse_addrs_txt("not-an-addr,192.168.1.7:4444,,999.9.9.9:1");
        assert_eq!(parsed.len(), 1, "only the valid entry survives");
    }

    #[test]
    fn empty_txt_parses_to_empty() {
        assert!(parse_addrs_txt("").is_empty());
    }
}
