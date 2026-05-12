//! Normal-priority popup. Top-right corner of the monitor that currently
//! contains the main window (falling back to the primary monitor), always
//! on top, no decorations, persistent audio.

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

use crate::models::Reminder;

use super::{label_for, start_repeating_audio};

const W: f64 = 480.0;
const H: f64 = 260.0;
const MARGIN: f64 = 24.0;

pub fn spawn(app: &AppHandle, r: &Reminder) {
    let label = label_for(&r.id);
    if app.get_webview_window(&label).is_some() {
        log::debug!("alert window already open for {}", r.id);
        return;
    }

    let (x, y) = corner_position(app);

    let result = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("alert.html".into()),
    )
    .title("Klaxon")
    .inner_size(W, H)
    .position(x, y)
    .always_on_top(true)
    .skip_taskbar(true)
    .decorations(false)
    .resizable(false)
    .focused(false)
    .visible(true)
    .build();

    if let Err(e) = result {
        log::error!("failed to spawn popup alert: {e}");
        return;
    }

    start_repeating_audio(app, r);
}

/// Pick the monitor the user is most likely looking at: the one that
/// currently contains the main window. Fall back to primary if the main
/// window is hidden/destroyed or we can't resolve its monitor.
fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.current_monitor() {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

fn corner_position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = target_monitor(app) else {
        return (MARGIN, MARGIN);
    };
    let pos = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let monitor_w = size.width as f64 / scale;
    let origin_x = pos.x as f64 / scale;
    let origin_y = pos.y as f64 / scale;
    let x = (origin_x + monitor_w - W - MARGIN).max(origin_x + MARGIN);
    let y = origin_y + MARGIN;
    (x, y)
}
