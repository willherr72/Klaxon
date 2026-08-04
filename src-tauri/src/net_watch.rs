//! Windows network-interface change notifications → sync nudges.
//!
//! Field evidence (issue #3): after a Wi-Fi migration the iroh endpoint
//! stayed bound to the dead network for hours — every dial timed out
//! until an app restart. iroh can't always observe interface changes on
//! Windows itself; `NotifyIpInterfaceChange` can. The callback runs on
//! an OS thread-pool thread, so it must only signal — the sync loop
//! owns the actual `endpoint.network_change()` call. Same OnceLock
//! pattern as `power.rs`.

#![cfg(target_os = "windows")]

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::NetworkManagement::IpHelper::{
    NotifyIpInterfaceChange, MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE,
};
use windows::Win32::Networking::WinSock::AF_UNSPEC;

use crate::sync::trigger::Nudge;

static NUDGE: std::sync::OnceLock<UnboundedSender<Nudge>> = std::sync::OnceLock::new();

unsafe extern "system" fn on_change(
    _ctx: *const core::ffi::c_void,
    _row: *const MIB_IPINTERFACE_ROW,
    _kind: MIB_NOTIFICATION_TYPE,
) {
    // Bursts are expected (one event per address family per interface);
    // the nudge channel's debounce coalesces them into one pass.
    if let Some(tx) = NUDGE.get() {
        let _ = tx.send(Nudge::NetworkChange);
    }
}

/// Register for interface-change callbacks. Failure is logged and
/// non-fatal — behavior degrades to pre-v0.7.2 (restart to recover).
pub fn spawn_net_watcher(nudge: UnboundedSender<Nudge>) {
    let _ = NUDGE.set(nudge);
    let mut handle = HANDLE::default();
    // initial_notification = false: only actual changes, not a synthetic
    // event at registration time (launch already nudges a pass).
    let ret = unsafe {
        NotifyIpInterfaceChange(AF_UNSPEC, Some(on_change), None, false, &mut handle)
    };
    if ret.is_err() {
        log::warn!("net watcher: NotifyIpInterfaceChange failed: {ret:?}");
    } else {
        log::info!("net watcher: interface-change notifications registered");
        // The handle is dropped without CancelMibChangeNotify2 on
        // purpose — notifications live for the whole process, same as
        // the power watcher's message window.
    }
}
