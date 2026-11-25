#[cfg(any(
    all(any(windows, target_os = "android"), feature = "p0-session"),
    all(windows, feature = "p0-local-provider")
))]
mod refresh_response;
#[cfg(all(target_os = "android", feature = "p0-session"))]
mod session;
#[cfg(all(windows, feature = "p0-local-provider"))]
mod windows_local_provider;
#[cfg(all(
    windows,
    any(
        feature = "p0-local-provider",
        feature = "p0-windows-sign-out-http",
        all(test, feature = "p0-session")
    )
))]
#[path = "windows_session/loopback.rs"]
mod windows_loopback;
#[cfg(all(windows, feature = "p0-session"))]
mod windows_session;
#[cfg(all(windows, any(feature = "p0-session", feature = "p0-local-provider")))]
#[path = "windows_session/store.rs"]
mod windows_store;

// JWT-shaped fixture value for the SDK's refresh state machine, with a fake signature.
#[cfg(all(any(windows, target_os = "android"), feature = "p0-session"))]
const ROTATED_OWNER_A_ACCESS: &str = concat!(
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
    "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.",
    "cDAtbm90LWEtc2lnbmF0dXJl"
);

#[cfg(any(
    all(any(windows, target_os = "android"), feature = "p0-session"),
    all(windows, feature = "p0-local-provider")
))]
fn is_fixture_window(window: &tauri::WebviewWindow) -> bool {
    window
        .url()
        .is_ok_and(|url| is_fixture_origin(window.label(), &url))
}

#[cfg(any(
    all(any(windows, target_os = "android"), feature = "p0-session"),
    all(windows, feature = "p0-local-provider")
))]
fn is_fixture_origin(label: &str, url: &tauri::Url) -> bool {
    label == "main" && url.origin().ascii_serialization() == "http://tauri.localhost"
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

#[cfg(all(windows, feature = "p0-local-provider", feature = "custom-protocol"))]
pub fn run_windows_local_provider() {
    windows_local_provider::install(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("P0 Windows local provider host failed to start");
}
