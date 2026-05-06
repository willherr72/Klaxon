//! Normal-priority popup. Top-right corner of the primary monitor,
//! always-on-top, no decorations, persistent audio.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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

fn corner_position(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let mw = size.width as f64 / scale;
        let x = (mw - W - MARGIN).max(MARGIN);
        return (x, MARGIN);
    }
    (MARGIN, MARGIN)
}
