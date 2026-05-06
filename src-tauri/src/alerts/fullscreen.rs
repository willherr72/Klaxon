//! High-priority fullscreen alert. Steals focus, cannot be minimized,
//! escalating audio. The escape hatch is the in-window Dismiss/Snooze.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::models::Reminder;

use super::{label_for, start_repeating_audio};

pub fn spawn(app: &AppHandle, r: &Reminder) {
    let label = label_for(&r.id);
    if app.get_webview_window(&label).is_some() {
        log::debug!("alert window already open for {}", r.id);
        return;
    }

    let result = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App("alert.html".into()),
    )
    .title("Klaxon")
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
