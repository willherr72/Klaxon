use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::models::Reminder;

pub fn show(app: &AppHandle, r: &Reminder) {
    let body = r.description.clone().unwrap_or_default();
    let result = app
        .notification()
        .builder()
        .title(&r.title)
        .body(body)
        .show();
    if let Err(e) = result {
        log::warn!("toast notification failed: {e}");
    }
}
