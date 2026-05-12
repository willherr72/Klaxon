//! High-priority fullscreen alert. Steals focus, cannot be minimized,
//! escalating audio. The escape hatch is the in-window Dismiss/Snooze.
//!
//! Multi-monitor: anchor the window's pre-fullscreen position to the
//! monitor that contains the main window so the alert appears wherever
//! the user is currently working, not always on the primary monitor.

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::models::Reminder;

use super::{label_for, start_repeating_audio};

pub fn spawn(app: &AppHandle, r: &Reminder) {
    let label = label_for(&r.id);
    if app.get_webview_window(&label).is_some() {
        log::debug!("alert window already open for {}", r.id);
        return;
    }

    let (anchor_x, anchor_y) = anchor_position(app);

    let result = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("alert.html".into()),
    )
    .title("Klaxon")
    .inner_size(800.0, 600.0)
    .position(anchor_x, anchor_y)
    .fullscreen(true)
    .always_on_top(true)
    .focused(true)
    .decorations(false)
    .visible(true)
    .build();

    if let Err(e) = result {
        log::error!("failed to spawn fullscreen alert: {e}");
        return;
    }

    start_repeating_audio(app, r);
}

fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.current_monitor() {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Where to place the window's top-left before `fullscreen(true)` takes
/// over. The monitor that contains this point is the one the window will
/// fill, so we use the target monitor's origin (with a small inset).
fn anchor_position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = target_monitor(app) else {
        return (0.0, 0.0);
    };
    let pos = monitor.position();
    let scale = monitor.scale_factor();
    let origin_x = pos.x as f64 / scale;
    let origin_y = pos.y as f64 / scale;
    (origin_x + 10.0, origin_y + 10.0)
}
