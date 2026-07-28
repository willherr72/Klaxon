//! The global-hotkey capture window: a small always-on-top box holding
//! just the thought composer.
//!
//! Deliberately its own window rather than focusing the main one — the
//! point of hotkey capture is to not pull the user out of what they were
//! doing. Closing it destroys the window; it is cheap to rebuild and
//! leaving it alive would keep a stale always-on-top box around.

use tauri::{AppHandle, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "capture";
const W: f64 = 560.0;
const H: f64 = 190.0;

pub fn spawn(app: &AppHandle) {
    // Already open — focus it instead of stacking a second box.
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }

    let (x, y) = centered_position(app);

    let result = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("capture.html".into()))
        .title("Klaxon — Capture")
        .inner_size(W, H)
        .position(x, y)
        .always_on_top(true)
        .skip_taskbar(true)
        .decorations(false)
        .resizable(false)
        // Unlike an alert, this window exists to be typed into, so it
        // takes focus immediately.
        .focused(true)
        .visible(true)
        .build();

    if let Err(e) = result {
        log::error!("failed to spawn capture window: {e}");
    }
}

/// The monitor holding the main window, falling back to primary — the same
/// heuristic `alerts::popup` uses to pick the screen in front of the user.
fn target_monitor(app: &AppHandle) -> Option<Monitor> {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(Some(m)) = w.current_monitor() {
            return Some(m);
        }
    }
    app.primary_monitor().ok().flatten()
}

/// Horizontally centered, one third down — where the eye already is,
/// rather than dead centre over whatever the user was reading.
fn centered_position(app: &AppHandle) -> (f64, f64) {
    let Some(monitor) = target_monitor(app) else {
        return (240.0, 240.0);
    };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + (size.width - W) / 2.0;
    let y = pos.y + (size.height - H) / 3.0;
    (x, y)
}
