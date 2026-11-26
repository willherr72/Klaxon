use super::{
    provider_flag,
    store::{SignOutState, Slot},
    MARKER, PEER_MARKER, SUCCESSOR_MARKER,
};
use serde_json::{json, Value};
use std::{path::Path, str};

const RETRY: &str = "retry-required";

#[cfg(any(test, not(feature = "p0-windows-sign-out-http")))]
pub(super) fn run(path: &Path) -> Result<&'static str, &'static str> {
    run_with_provider(path, |request| simulated_response(path, request))
}

#[cfg(any(test, feature = "p0-windows-sign-out-http"))]
pub(super) fn run_http(
    path: &Path,
    port: Option<&str>,
    release_local_state: impl FnOnce(),
) -> Result<&'static str, &'static str> {
    run_with_provider(path, |request| {
        // The journal is pending and the slot file remains locked across HTTP.
        // Concurrent IPC can now observe the revoked in-memory provider.
        release_local_state();
        // Validate only when dispatch is needed, after the shared path has recorded intent.
        super::loopback::post(port, request)
    })
}

fn run_with_provider<B: AsRef<[u8]>>(
    path: &Path,
    send: impl FnOnce(&Value) -> Result<(u16, B), &'static str>,
) -> Result<&'static str, &'static str> {
    let slot = Slot::lock(path).map_err(|_| "unavailable")?;
    let state = slot.sign_out_state().map_err(|_| RETRY)?;
    if state == Some(SignOutState::Acknowledged) {
        return finish(&slot);
    }

    if state.is_none() {
        if !path.try_exists().map_err(|_| RETRY)? {
            return Ok("signed-out");
        }
        slot.set_sign_out_state(SignOutState::Pending)
            .map_err(|_| RETRY)?;
    }
    let marker = slot.read().map_err(|_| RETRY)?.marker;
    if !matches!(marker.as_slice(), MARKER | PEER_MARKER | SUCCESSOR_MARKER) {
        return Err(RETRY);
    }
    if provider_flag(path, "p0-provider-offline").map_err(|_| RETRY)? {
        return Err(RETRY);
    }
    let token = str::from_utf8(&marker).map_err(|_| RETRY)?;
    // Convex 1.51.0 POST /api/mutation, with Auth 2.1.0's signOut arguments.
    let request = json!({
        "path": "auth:signOut",
        "format": "convex_encoded_json",
        "args": [{ "refreshToken": token }]
    });
    let (status, body) = send(&request)?;
    accept(&slot, status, body.as_ref())
}

#[cfg(any(test, not(feature = "p0-windows-sign-out-http")))]
fn simulated_response(path: &Path, request: &Value) -> Result<(u16, &'static [u8]), &'static str> {
    use std::{fs, io};

    const DROP_REPLY: &str = "p0-signout-drop-reply";
    const EXPECT_SUCCESSOR: &str = "p0-signout-expect-successor";
    const ISSUER_RECEIPT: &str = "p0-issuer-revoked-successor";
    const ISSUER_ACK: &str = "p0-issuer-acknowledged-successor";
    const REVOKED: &[u8] = br#"{"status":"success","value":null,"logLines":[]}"#;
    const REJECTED: &[u8] =
        br#"{"status":"error","errorMessage":"Fixture rejected the sign-out request","logLines":[]}"#;

    let token = request
        .pointer("/args/0/refreshToken")
        .and_then(Value::as_str)
        .ok_or(RETRY)?;
    let drop_reply = provider_flag(path, DROP_REPLY).map_err(|_| RETRY)?;
    let loss_scenario = drop_reply || provider_flag(path, EXPECT_SUCCESSOR).map_err(|_| RETRY)?;
    if *request
        != json!({
            "path": "auth:signOut",
            "format": "convex_encoded_json",
            "args": [{ "refreshToken": token }]
        })
        || (loss_scenario && token.as_bytes() != SUCCESSOR_MARKER)
    {
        return Ok((560, REJECTED));
    }
    if loss_scenario {
        let receipt = path.with_file_name(ISSUER_RECEIPT);
        match fs::File::create_new(&receipt) {
            Ok(file) => file.sync_all().map_err(|_| RETRY)?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&receipt).map_err(|_| RETRY)?;
                if !metadata.is_file() || metadata.len() != 0 {
                    return Err(RETRY);
                }
            }
            Err(_) => return Err(RETRY),
        }
        if drop_reply {
            return Err(RETRY);
        }
        // A test observer must not change the issuer reply or overwrite an existing file.
        let _observation = fs::File::create_new(path.with_file_name(ISSUER_ACK));
    }
    Ok((200, REVOKED))
}

pub(super) fn accept(
    slot: &Slot<'_>,
    status: u16,
    body: &[u8],
) -> Result<&'static str, &'static str> {
    if !crate::refresh_response::acknowledged_sign_out(status.into(), body) {
        return Err(RETRY);
    }
    // Persist the acknowledgment before deleting the only local copy of the request marker.
    slot.set_sign_out_state(SignOutState::Acknowledged)
        .map_err(|_| RETRY)?;
    finish(slot)
}

fn finish(slot: &Slot<'_>) -> Result<&'static str, &'static str> {
    slot.finish_sign_out().map_err(|_| RETRY)?;
    Ok("signed-out")
}
