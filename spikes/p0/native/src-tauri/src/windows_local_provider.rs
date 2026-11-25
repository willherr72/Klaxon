use crate::{
    refresh_response::{self, Grant},
    windows_loopback,
    windows_store::{Record, SessionId, SignOutState, Slot},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env, io,
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Builder, Manager, WebviewWindow, Wry};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

const MUTATION_URL: &str = "http://127.0.0.1:3210/api/mutation";
const ISSUER: &str = "http://127.0.0.1:3210/components/auth";
const ENTROPY: &[u8] = b"dev.klaxon.p0localprovider/session-v1/packaged";
const UNAVAILABLE: &str = "unavailable";
const RETRY: &str = "retry-required";
const SIGNED_OUT: &str = "signed-out";

type Reply = Result<(u16, Vec<u8>), &'static str>;

#[derive(Deserialize)]
struct Header {
    alg: String,
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    aud: String,
    iss: String,
    iat: u64,
    exp: u64,
}

fn subject(bearer: &str) -> Result<String, &'static str> {
    let mut parts = bearer.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(UNAVAILABLE);
    };
    if [header, payload, signature]
        .iter()
        .any(|part| part.is_empty())
    {
        return Err(UNAVAILABLE);
    }
    // Convex verifies signatures. Native binds the JWT session from the pinned
    // provider response to the separately returned user ID.
    let header = URL_SAFE_NO_PAD.decode(header).map_err(|_| UNAVAILABLE)?;
    let header: Header = serde_json::from_slice(&header).map_err(|_| UNAVAILABLE)?;
    if !nonempty(&header.alg) || header.alg == "none" || URL_SAFE_NO_PAD.decode(signature).is_err()
    {
        return Err(UNAVAILABLE);
    }
    let payload = URL_SAFE_NO_PAD.decode(payload).map_err(|_| UNAVAILABLE)?;
    let claims: Claims = serde_json::from_slice(&payload).map_err(|_| UNAVAILABLE)?;
    if !nonempty(&claims.sub)
        || claims.aud != "convex-auth"
        || claims.iss != ISSUER
        || claims.iat == 0
        || claims.exp <= claims.iat
    {
        return Err(UNAVAILABLE);
    }
    Ok(claims.sub)
}

fn nonempty(field: &str) -> bool {
    !field.trim().is_empty()
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredGrant {
    owner: String,
    subject: String,
    refresh: String,
}

impl StoredGrant {
    fn from_grant(grant: Grant, expected_owner: &str) -> Result<(Self, String), &'static str> {
        if grant.user_id != expected_owner {
            return Err(UNAVAILABLE);
        }
        let stored = Self {
            owner: grant.user_id,
            subject: subject(&grant.access_token)?,
            refresh: grant.refresh_token,
        };
        Ok((stored, grant.access_token))
    }

    fn read(slot: &Slot<'_>, owner: &str) -> Result<(Record, Self), &'static str> {
        let record = slot.read().map_err(|error| match error.kind() {
            io::ErrorKind::NotFound => SIGNED_OUT,
            _ => UNAVAILABLE,
        })?;
        let stored: Self = serde_json::from_slice(&record.marker).map_err(|_| UNAVAILABLE)?;
        if record.id.is_none()
            || !nonempty(&stored.owner)
            || stored.owner != owner
            || !nonempty(&stored.subject)
            || !nonempty(&stored.refresh)
        {
            return Err(UNAVAILABLE);
        }
        Ok((record, stored))
    }

    fn encode(&self) -> Result<Vec<u8>, &'static str> {
        serde_json::to_vec(self).map_err(|_| UNAVAILABLE)
    }
}

struct Active {
    id: SessionId,
    subject: String,
    access: String,
}

#[derive(Default)]
struct Provider {
    active: Option<Active>,
}

impl Provider {
    fn sign_in(
        &mut self,
        path: &Path,
        owner: &str,
        username: &str,
        password: &str,
        send: impl FnOnce(&Value) -> Reply,
    ) -> Result<&'static str, &'static str> {
        let slot = lock_slot(path)?;
        require_no_pending(&slot)?;
        if path.try_exists().map_err(|_| UNAVAILABLE)? {
            return Err(UNAVAILABLE);
        }
        self.active = None;
        let request = mutation(
            "auth:signInWithUsernamePassword",
            json!({"username": username, "password": password}),
        );
        let body = successful_body(send(&request)?)?;
        let grant = refresh_response::decode_sign_in(&body, owner).map_err(|_| UNAVAILABLE)?;
        let (stored, access) = StoredGrant::from_grant(grant, owner)?;
        let id = slot.seed(&stored.encode()?).map_err(|_| UNAVAILABLE)?;
        self.active = Some(Active {
            id,
            subject: stored.subject,
            access,
        });
        Ok("fixture-ready")
    }

    fn resume(
        &mut self,
        path: &Path,
        owner: &str,
        send: impl FnOnce(&Value) -> Reply,
    ) -> Result<&'static str, &'static str> {
        self.active = None;
        let slot = lock_slot(path)?;
        require_no_pending(&slot)?;
        let (record, stored) = StoredGrant::read(&slot, owner)?;
        self.active = Some(rotate(&slot, &record, stored, send)?);
        Ok("authenticated")
    }

    fn access(
        &mut self,
        path: &Path,
        owner: &str,
        force_refresh: bool,
        send: impl FnOnce(&Value) -> Reply,
    ) -> Result<String, &'static str> {
        // Authenticate all accesses against the current protected slot. Drop a
        // cached bearer if another process replaced or revoked the slot.
        let mut active = self.active.take().ok_or(SIGNED_OUT)?;
        let slot = lock_slot(path)?;
        require_no_pending(&slot)?;
        let (record, stored) = StoredGrant::read(&slot, owner)?;
        if record.id != Some(active.id) || stored.subject != active.subject {
            return Err(UNAVAILABLE);
        }
        if force_refresh {
            active = rotate(&slot, &record, stored, send)?;
        }
        let access = active.access.clone();
        self.active = Some(active);
        Ok(access)
    }

    fn revoke(
        &mut self,
        path: &Path,
        owner: &str,
        mut send: impl FnMut(&Value) -> Reply,
    ) -> Result<&'static str, &'static str> {
        self.active = None;
        let slot = lock_slot(path)?;
        if slot.sign_out_state().map_err(|_| RETRY)? != Some(SignOutState::Acknowledged) {
            let (_, stored) = StoredGrant::read(&slot, owner)?;
            slot.set_sign_out_state(SignOutState::Pending)
                .map_err(|_| RETRY)?;
            let (status, body) = send(&refresh_request("auth:signOut", &stored.refresh))?;
            if !refresh_response::acknowledged_sign_out(status.into(), &body) {
                return Err(RETRY);
            }
            // Reuse the exact revoked grant only for this negative provider check.
            let body = successful_body(send(&refresh_request(
                "auth:refreshSession",
                &stored.refresh,
            ))?)?;
            if !matches!(refresh_response::decode(&body), Ok(None)) {
                return Err(RETRY);
            }
            slot.set_sign_out_state(SignOutState::Acknowledged)
                .map_err(|_| RETRY)?;
        }
        slot.finish_sign_out().map_err(|_| RETRY)?;
        Ok("revoked")
    }
}

fn rotate(
    slot: &Slot<'_>,
    record: &Record,
    stored: StoredGrant,
    send: impl FnOnce(&Value) -> Reply,
) -> Result<Active, &'static str> {
    let body = successful_body(send(&refresh_request(
        "auth:refreshSession",
        &stored.refresh,
    ))?)?;
    let Some(grant) = refresh_response::decode(&body).map_err(|_| UNAVAILABLE)? else {
        slot.remove().map_err(|_| UNAVAILABLE)?;
        return Err(SIGNED_OUT);
    };
    let (successor, access) = StoredGrant::from_grant(grant, &stored.owner)?;
    if successor.subject != stored.subject || successor.refresh == stored.refresh {
        return Err(UNAVAILABLE);
    }
    let id = slot
        .commit(record, &successor.encode()?)
        .map_err(|_| UNAVAILABLE)?;
    Ok(Active {
        id,
        subject: successor.subject,
        access,
    })
}

fn mutation(path: &str, args: Value) -> Value {
    json!({"path": path, "format": "convex_encoded_json", "args": [args]})
}

fn refresh_request(path: &str, token: &str) -> Value {
    mutation(path, json!({"refreshToken": token}))
}

fn successful_body((status, body): (u16, Vec<u8>)) -> Result<Vec<u8>, &'static str> {
    if !(200..300).contains(&status) {
        return Err(RETRY);
    }
    Ok(body)
}

fn require_no_pending(slot: &Slot<'_>) -> Result<(), &'static str> {
    match slot.sign_out_state() {
        Ok(None) => Ok(()),
        _ => Err(RETRY),
    }
}

fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

fn slot_path(root: &Path, run: &str) -> Option<PathBuf> {
    let suffix = run.strip_prefix("klaxon-p0-session-")?;
    if suffix.len() != 6 || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let directory = root.join(run);
    let metadata = directory.symlink_metadata().ok()?;
    if !metadata.is_dir() || is_reparse_point(&metadata) {
        return None;
    }
    Some(directory.join("packaged.bin"))
}

fn lock_slot(path: &Path) -> Result<Slot<'_>, &'static str> {
    let slot = Slot::lock_with_context(path, ENTROPY).map_err(|_| UNAVAILABLE)?;
    for file in [path.to_owned(), path.with_extension("signout-pending")] {
        match file.symlink_metadata() {
            Ok(metadata) if metadata.is_file() && !is_reparse_point(&metadata) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            _ => return Err(UNAVAILABLE),
        }
    }
    Ok(slot)
}

fn post(request: &Value) -> Reply {
    windows_loopback::post_mutation(MUTATION_URL, request)
}

struct Credentials {
    username: String,
    password: String,
}

impl Credentials {
    fn capture() -> Option<Self> {
        // Capture before starting the WebView so its subprocesses don't inherit the inputs.
        let username = env_field("KLAXON_P0_LOCAL_USER");
        let password = env_field("KLAXON_P0_LOCAL_PASSWORD");
        env::remove_var("KLAXON_P0_LOCAL_USER");
        env::remove_var("KLAXON_P0_LOCAL_PASSWORD");
        Some(Self {
            username: username?,
            password: password?,
        })
    }
}

fn env_field(name: &str) -> Option<String> {
    env::var(name).ok().filter(|value| nonempty(value))
}

struct Runtime {
    provider: Mutex<Provider>,
    credentials: Option<Credentials>,
}

async fn run_command<T: Send + 'static>(
    window: WebviewWindow,
    operation: impl FnOnce(&mut Provider, &Path, &str, Option<&Credentials>) -> Result<T, &'static str>
        + Send
        + 'static,
) -> Result<T, &'static str> {
    // Hold the state and slot locks across provider calls on a blocking worker.
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::is_fixture_window(&window) {
            return Err(UNAVAILABLE);
        }
        let run = env_field("KLAXON_P0_SESSION_RUN").ok_or(UNAVAILABLE)?;
        let path = slot_path(&env::temp_dir(), &run).ok_or(UNAVAILABLE)?;
        let owner = env_field("KLAXON_P0_LOCAL_OWNER_ID").ok_or(UNAVAILABLE)?;
        let runtime = window.state::<Runtime>();
        let mut provider = runtime.provider.lock().map_err(|_| UNAVAILABLE)?;
        operation(&mut provider, &path, &owner, runtime.credentials.as_ref())
    })
    .await
    .map_err(|_| UNAVAILABLE)?
}

#[tauri::command]
async fn local_sign_in(window: WebviewWindow) -> Result<&'static str, &'static str> {
    run_command(window, |provider, path, owner, credentials| {
        let credentials = credentials.ok_or(UNAVAILABLE)?;
        provider.sign_in(
            path,
            owner,
            &credentials.username,
            &credentials.password,
            post,
        )
    })
    .await
}

#[tauri::command]
async fn local_resume(window: WebviewWindow) -> Result<&'static str, &'static str> {
    run_command(window, |provider, path, owner, _| {
        provider.resume(path, owner, post)
    })
    .await
}

#[tauri::command]
async fn local_access(window: WebviewWindow, force_refresh: bool) -> Result<String, &'static str> {
    run_command(window, move |provider, path, owner, _| {
        provider.access(path, owner, force_refresh, post)
    })
    .await
}

#[tauri::command]
async fn local_revoke(window: WebviewWindow) -> Result<&'static str, &'static str> {
    run_command(window, |provider, path, owner, _| {
        provider.revoke(path, owner, post)
    })
    .await
}

pub(super) fn install(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .manage(Runtime {
            provider: Mutex::new(Provider::default()),
            credentials: Credentials::capture(),
        })
        .invoke_handler(tauri::generate_handler![
            local_sign_in,
            local_resume,
            local_access,
            local_revoke
        ])
}

#[cfg(test)]
mod tests;
