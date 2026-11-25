use super::{
    provider_flag,
    store::{SignOutState, Slot},
    MARKER, PEER_MARKER, SUCCESSOR_MARKER,
};
use serde_json::{json, Value};
use std::{fs, io, path::Path, str};

const RETRY: &str = "retry-required";
const DROP_REPLY: &str = "p0-signout-drop-reply";
const EXPECT_SUCCESSOR: &str = "p0-signout-expect-successor";
const ISSUER_RECEIPT: &str = "p0-issuer-revoked-successor";
const ISSUER_ACK: &str = "p0-issuer-acknowledged-successor";
const REVOKED: &[u8] = br#"{"status":"success","value":null,"logLines":[]}"#;
const REJECTED: &[u8] =
    br#"{"status":"error","errorMessage":"Fixture rejected the sign-out request","logLines":[]}"#;

pub(super) fn run(path: &Path) -> Result<&'static str, &'static str> {
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
    let marker = slot.read().map_err(|_| RETRY)?;
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
    let (status, body) = simulated_response(path, &request)?;
    accept(&slot, status, body)
}

fn simulated_response(path: &Path, request: &Value) -> Result<(u16, &'static [u8]), &'static str> {
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
