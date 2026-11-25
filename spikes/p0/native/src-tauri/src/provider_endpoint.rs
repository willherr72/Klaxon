use serde_json::Value;

#[cfg(feature = "p0-hosted-provider")]
macro_rules! origin {
    () => {
        env!("KLAXON_P0_HOSTED_ORIGIN")
    };
}

#[cfg(not(feature = "p0-hosted-provider"))]
macro_rules! origin {
    () => {
        "http://127.0.0.1:3210"
    };
}

const MUTATION_URL: &str = concat!(origin!(), "/api/mutation");
#[cfg(any(target_os = "android", feature = "p0-hosted-provider"))]
pub(super) const ORIGIN: &str = origin!();
#[cfg(windows)]
const ISSUER: &str = concat!(origin!(), "/components/auth");

#[cfg(windows)]
pub(super) fn matches_issuer(issuer: &str) -> bool {
    issuer == ISSUER
}

pub(super) fn post(request: &Value) -> Result<(u16, Vec<u8>), &'static str> {
    crate::fixture_http::post_mutation(MUTATION_URL, request, cfg!(feature = "p0-hosted-provider"))
}

#[cfg(feature = "p0-hosted-provider")]
#[tauri::command]
pub(crate) fn local_provider_origin(
    window: tauri::WebviewWindow,
) -> Result<&'static str, &'static str> {
    if !crate::is_fixture_window(&window) {
        return Err("unavailable");
    }
    Ok(ORIGIN)
}
