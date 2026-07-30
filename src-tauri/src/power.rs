//! Windows suspend/resume notifications → sync nudges.
//!
//! Push-on-write means data leaves the device seconds after a write, so
//! there is rarely anything to flush at suspend. The valuable edge is
//! resume: iroh's sockets are stale after sleep and the first dial used to
//! eat the 10s timeout and fail silently. Nudging a pass at resume (with
//! the seeded-dial path from iroh_client) turns wake-up into a fast,
//! evidence-logged catch-up.
//!
//! Implementation: a message-only window on its own thread receiving
//! WM_POWERBROADCAST. Tao/Tauri don't surface these events, and a
//! message-only window (HWND_MESSAGE parent) needs no visible surface.

#![cfg(windows)]

use tokio::sync::mpsc::UnboundedSender;

use crate::sync::trigger::Nudge;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_POWERBROADCAST, WNDCLASSW,
};

// PBT_* constants are stable numeric values; defining them locally skips
// pulling in the whole Win32_System_Power feature for two integers.
const PBT_APMSUSPEND: usize = 0x0004;
const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

static NUDGE: std::sync::OnceLock<UnboundedSender<Nudge>> = std::sync::OnceLock::new();

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_POWERBROADCAST {
        match wparam.0 {
            PBT_APMRESUMEAUTOMATIC => {
                log::info!("resume detected — nudging sync");
                if let Some(tx) = NUDGE.get() {
                    let _ = tx.send(Nudge::Resume);
                }
            }
            PBT_APMSUSPEND => {
                // Best-effort: one last nudge. The pass races the OS's
                // suspend deadline and may not finish — push-on-write is
                // the real answer; this is a free extra chance.
                log::info!("suspend imminent — best-effort sync nudge");
                if let Some(tx) = NUDGE.get() {
                    let _ = tx.send(Nudge::Write);
                }
            }
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Spawn the watcher thread. Failures are logged, never fatal — losing
/// power events degrades to the pre-M1 behaviour (tick-driven catch-up).
pub fn spawn_power_watcher(nudge: UnboundedSender<Nudge>) {
    let _ = NUDGE.set(nudge);
    let spawned = std::thread::Builder::new()
        .name("klaxon-power-watch".into())
        .spawn(|| unsafe {
            let hinstance = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("power watcher: GetModuleHandleW failed: {e}");
                    return;
                }
            };
            let class = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance.into(),
                lpszClassName: w!("KlaxonPowerWatch"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                log::warn!("power watcher: RegisterClassW failed");
                return;
            }
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("KlaxonPowerWatch"),
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                // Message-only window: no surface, just messages.
                Some(HWND_MESSAGE),
                None,
                Some(hinstance.into()),
                None,
            );
            if hwnd.is_err() {
                log::warn!("power watcher: CreateWindowExW failed");
                return;
            }
            log::info!("power watcher online");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        });
    if let Err(e) = spawned {
        log::warn!("power watcher spawn failed: {e}");
    }
}
