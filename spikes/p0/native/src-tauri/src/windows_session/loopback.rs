use serde_json::Value;
#[cfg(all(
    feature = "p0-session",
    any(test, feature = "p0-windows-sign-out-http")
))]
use std::num::NonZeroU16;
use std::time::Duration;

#[cfg(all(
    feature = "p0-session",
    any(test, feature = "p0-windows-sign-out-http")
))]
pub(super) fn post(port: Option<&str>, request: &Value) -> Result<(u16, Vec<u8>), &'static str> {
    let port = port
        .filter(|port| port.len() <= 5 && port.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|port| port.parse::<NonZeroU16>().ok())
        .ok_or("retry-required")?;
    post_mutation(&format!("http://127.0.0.1:{port}/api/mutation"), request)
}

pub(super) fn post_mutation(url: &str, request: &Value) -> Result<(u16, Vec<u8>), &'static str> {
    const RETRY: &str = "retry-required";
    const MAX_BODY_BYTES: usize = 16 * 1024;
    tauri::async_runtime::handle().block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| RETRY)?;
        let mut response = client
            .post(url)
            .json(request)
            .send()
            .await
            .map_err(|_| RETRY)?;
        let status = response.status().as_u16();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| RETRY)? {
            if chunk.len() > MAX_BODY_BYTES - body.len() {
                return Err(RETRY);
            }
            body.extend_from_slice(&chunk);
        }
        Ok((status, body))
    })
}
