use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    App, Emitter, Manager,
};

use crate::error::AppResult;

pub const EVT_OPEN_NEW: &str = "klaxon://open-new-reminder";

pub fn setup(app: &App) -> AppResult<()> {
    let new_item = MenuItem::with_id(app, "new", "New Reminder", true, Some("Ctrl+Alt+N"))?;
    let show_item = MenuItem::with_id(app, "show", "Open Klaxon", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_item, &show_item, &sep, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("klaxon-tray")
        .tooltip("Klaxon — reminders, but louder")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "new" => {
                show_main(app);
                let _ = app.emit(EVT_OPEN_NEW, ());
            }
            "show" => show_main(app),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
