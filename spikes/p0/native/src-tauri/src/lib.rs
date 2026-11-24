#[cfg(all(target_os = "android", feature = "p0-session"))]
mod session;
#[cfg(all(windows, feature = "p0-session"))]
mod windows_session;

#[cfg(all(any(windows, target_os = "android"), feature = "p0-session"))]
fn is_fixture_window(window: &tauri::WebviewWindow) -> bool {
    window.label() == "main"
        && window
            .url()
            .ok()
            .map(|url| url.origin().ascii_serialization())
            .as_deref()
            == Some("http://tauri.localhost")
}

#[cfg(all(target_os = "android", feature = "p0-session"))]
fn allows_fixture(window: &tauri::WebviewWindow, operation: &str) -> bool {
    is_fixture_window(window) && matches!(operation, "seed" | "seed-peer" | "resume" | "sign-out")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(all(target_os = "android", feature = "p0-session"))]
    let builder = session::install(builder);
    #[cfg(all(windows, feature = "p0-session"))]
    let builder = windows_session::install(builder);
    builder
        .run(tauri::generate_context!())
        .expect("P0 native host failed to start");
}
