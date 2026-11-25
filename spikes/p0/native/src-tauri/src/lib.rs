#[cfg(any(
    all(any(windows, target_os = "android"), feature = "p0-session"),
    all(windows, feature = "p0-local-provider")
))]
mod refresh_response;
#[cfg(all(
    target_os = "android",
    feature = "p0-session",
    not(feature = "p0-android-provider-preflight")
))]
mod session;
#[cfg(all(
    target_os = "android",
    feature = "p0-android-provider-preflight",
    not(debug_assertions)
))]
compile_error!("Android provider preflight is a debug-only fixture");
#[cfg(all(target_os = "android", feature = "p0-android-provider-preflight"))]
mod android_local_provider;
#[cfg(any(
    all(target_os = "android", feature = "p0-android-provider-preflight"),
    all(
        windows,
        any(
            feature = "p0-local-provider",
            feature = "p0-windows-sign-out-http",
            all(test, feature = "p0-session")
        )
    )
))]
mod fixture_http;
#[cfg(test)]
mod hosted_origin;
#[cfg(any(
    all(windows, feature = "p0-local-provider"),
    all(target_os = "android", feature = "p0-android-provider-preflight")
))]
mod provider_endpoint;
#[cfg(all(windows, feature = "p0-local-provider"))]
mod windows_local_provider;

#[cfg(all(target_os = "android", feature = "p0-android-provider-preflight"))]
#[tauri::command]
async fn android_provider_preflight(
    window: tauri::WebviewWindow,
) -> Result<&'static str, &'static str> {
    if !is_fixture_window(&window) {
        return Err("unavailable");
    }
    tauri::async_runtime::spawn_blocking(|| {
        let request = serde_json::json!({
            "path": "auth:refreshSession",
            "format": "convex_encoded_json",
            "args": [{"refreshToken": "klaxon-p0-inert-android-preflight"}]
        });
        let (status, body) = provider_endpoint::post(&request)?;
        if status == 200 && matches!(refresh_response::decode(&body), Ok(None)) {
            Ok("no-session")
        } else {
            Err("unavailable")
        }
    })
    .await
    .map_err(|_| "unavailable")?
}
#[cfg(all(windows, feature = "p0-session"))]
mod windows_session;
#[cfg(all(windows, any(feature = "p0-session", feature = "p0-local-provider")))]
#[path = "windows_session/store.rs"]
mod windows_store;

// JWT-shaped fixture value for the SDK's refresh state machine, with a fake signature.
#[cfg(all(
    any(
        windows,
        all(target_os = "android", not(feature = "p0-android-provider-preflight"))
    ),
    feature = "p0-session"
))]
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

#[cfg(all(
    target_os = "android",
    feature = "p0-session",
    not(feature = "p0-android-provider-preflight")
))]
fn allows_fixture(window: &tauri::WebviewWindow, operation: &str) -> bool {
    is_fixture_window(window) && matches!(operation, "seed" | "seed-peer" | "resume" | "sign-out")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(all(
        target_os = "android",
        feature = "p0-session",
        not(feature = "p0-android-provider-preflight")
    ))]
    let builder = session::install(builder);
    #[cfg(all(target_os = "android", feature = "p0-android-provider-preflight"))]
    let builder = android_local_provider::install(builder);
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
