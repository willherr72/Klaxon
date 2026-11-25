use std::{
    collections::BTreeMap,
    env, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
#[cfg(feature = "p0-windows-sign-out-http")]
use tauri::Manager;
use tauri::{ipc::Channel, Builder, State, WebviewWindow, Wry};

#[cfg(any(test, feature = "p0-windows-sign-out-http"))]
mod loopback;
mod sign_out;
mod store;

const OWNER_A_REFRESH: &str = "KLAXON-P0-INERT/packaged/1";
const OWNER_B_REFRESH: &str = "KLAXON-P0-INERT/packaged/2";
const MARKER: &[u8] = OWNER_A_REFRESH.as_bytes();
const PEER_MARKER: &[u8] = OWNER_B_REFRESH.as_bytes();
const SUCCESSOR_MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/3";
const OWNER_A_ID: &str = "p0-fixture-owner-a";
const OWNER_A_ACCESS: &str = "p0-inert-access-a";

// In-process response for the pinned Convex auth:refreshSession mutation.
const REFRESH_RESPONSE: &[u8] = br#"{
    "status":"success",
    "value":{"kind":"rotated","tokens":{
        "accessToken":"p0-inert-access-a",
        "refreshToken":"KLAXON-P0-INERT/packaged/3",
        "refreshTokenExpiresAt":4102444800000,
        "userId":"p0-fixture-owner-a"
    }}
}"#;

#[derive(Clone, Copy, PartialEq)]
enum Owner {
    A,
    B,
}

#[derive(Clone, Copy)]
struct SessionIdentity {
    owner: Owner,
    id: store::SessionId,
}

struct Task {
    owner: Owner,
    id: &'static str,
    title: &'static str,
    updated_title: &'static str,
}

type Rows = Vec<BTreeMap<&'static str, &'static str>>;

struct Provider {
    session: Option<SessionIdentity>,
    subscription: Option<Channel<Rows>>,
    tasks: [Task; 2],
}

impl Provider {
    fn new() -> Self {
        Self {
            session: None,
            subscription: None,
            tasks: [
                Task {
                    owner: Owner::A,
                    id: "task-a",
                    title: "Owner A task",
                    updated_title: "Owner A updated",
                },
                Task {
                    owner: Owner::B,
                    id: "task-b",
                    title: "Owner B task",
                    updated_title: "Owner B updated",
                },
            ],
        }
    }

    fn revoke(&mut self) {
        self.session = None;
        self.subscription = None;
    }

    fn resume(&mut self, path: Option<&Path>) -> Result<&'static str, &'static str> {
        self.revoke();
        match confirm_resume(path.ok_or("unavailable")?) {
            Ok(session) => {
                self.session = Some(session.identity);
                Ok("authenticated")
            }
            Err(status @ ("retry-required" | "signed-out")) => Ok(status),
            Err(error) => Err(error),
        }
    }

    fn sdk_access(&mut self, slot: Option<&Path>) -> Result<String, &'static str> {
        let active = self.session.ok_or("signed-out")?;
        // Recheck even for cached SDK sessions. A replacement requires explicit resume.
        let access = slot
            .ok_or("unavailable")
            .and_then(|slot| confirm_session(slot, Some(active)))
            .map(|session| session.access);
        if access.is_err() {
            self.revoke();
        }
        access
    }

    fn active_tasks(&mut self, slot: Option<&Path>) -> Result<&mut Self, &'static str> {
        // The comparison panel uses native task IPC. Another process may have begun sign-out.
        self.sdk_access(slot)?;
        Ok(self)
    }

    fn rows(&self) -> Result<Rows, &'static str> {
        let owner = self.session.ok_or("signed-out")?.owner;
        Ok(self
            .tasks
            .iter()
            .filter(|task| task.owner == owner)
            .map(|task| BTreeMap::from([("id", task.id), ("title", task.title)]))
            .collect())
    }

    fn publish(&mut self) -> Result<(), &'static str> {
        let owner = self.session.ok_or("signed-out")?.owner;
        let task = self
            .tasks
            .iter_mut()
            .find(|task| task.owner == owner)
            .ok_or("unavailable")?;
        task.title = task.updated_title;
        if let Some(channel) = &self.subscription {
            channel.send(self.rows()?).map_err(|_| "unavailable")?;
        }
        Ok(())
    }
}

fn slot() -> Option<PathBuf> {
    let run = env::var("KLAXON_P0_SESSION_RUN").ok()?;
    let suffix = run.strip_prefix("klaxon-p0-session-")?;
    if suffix.len() != 6 || !suffix.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let directory = env::temp_dir().join(run);
    if !directory.symlink_metadata().ok()?.file_type().is_dir() {
        return None;
    }
    Some(directory.join("packaged.bin"))
}

fn require_no_pending_sign_out(slot: &store::Slot<'_>) -> Result<(), &'static str> {
    match slot.sign_out_state() {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(_) => Err("retry-required"),
    }
}

fn provider<'a>(
    window: &WebviewWindow,
    state: &'a Mutex<Provider>,
) -> Result<MutexGuard<'a, Provider>, &'static str> {
    if !crate::is_fixture_window(window) {
        return Err("unavailable");
    }
    #[cfg(feature = "p0-windows-sign-out-http")]
    let locked = state.try_lock(); // Never wait for the HTTP worker on the WebView thread.
    #[cfg(not(feature = "p0-windows-sign-out-http"))]
    let locked = state.lock();
    locked.map_err(|_| "unavailable")
}

struct ConfirmedSession {
    identity: SessionIdentity,
    access: String,
}

fn provider_flag(slot: &Path, flag: &str) -> Result<bool, &'static str> {
    slot.with_file_name(flag)
        .try_exists()
        .map_err(|_| "unavailable")
}

// Model only the username/password mutation result. The fixture never accepts credentials.
fn seed_session(path: &Path, owner: Owner) -> Result<&'static str, &'static str> {
    let slot = store::Slot::lock(path).map_err(|_| "unavailable")?;
    require_no_pending_sign_out(&slot)?;
    let (id, access, refresh) = match owner {
        Owner::A => (OWNER_A_ID, OWNER_A_ACCESS, OWNER_A_REFRESH),
        Owner::B => ("p0-fixture-owner-b", "p0-inert-access-b", OWNER_B_REFRESH),
    };
    let result = if provider_flag(path, "p0-signin-denied")? {
        serde_json::json!({"status":"error","userError":{"error":"USER_NOT_FOUND"}})
    } else {
        let issued_id = if provider_flag(path, "p0-signin-owner-mismatch")? {
            "p0-fixture-other-owner"
        } else {
            id
        };
        serde_json::json!({"status":"complete","tokens":{
            "userId":issued_id,"accessToken":access,"refreshToken":refresh,
            "refreshTokenExpiresAt":4102444800000_i64
        }})
    };
    let response = serde_json::to_vec(&serde_json::json!({"status":"success","value":result}))
        .map_err(|_| "unavailable")?;
    let grant =
        super::refresh_response::decode_sign_in(&response, id).map_err(|_| "unavailable")?;
    if grant.access_token != access || grant.refresh_token != refresh {
        return Err("unavailable");
    }
    slot.seed(grant.refresh_token.as_bytes())
        .map_err(|_| "unavailable")?;
    Ok("fixture-ready")
}

fn accept_refresh(
    slot: &store::Slot<'_>,
    body: &[u8],
) -> Result<(String, &'static [u8]), &'static str> {
    let Some(grant) = super::refresh_response::decode(body).map_err(|_| "unavailable")? else {
        slot.remove().map_err(|_| "unavailable")?;
        return Err("signed-out");
    };
    if grant.user_id != OWNER_A_ID
        || grant.access_token != OWNER_A_ACCESS
        || grant.refresh_token.as_bytes() != SUCCESSOR_MARKER
    {
        return Err("unavailable");
    }
    Ok((grant.access_token, SUCCESSOR_MARKER))
}

fn confirm_resume(path: &Path) -> Result<ConfirmedSession, &'static str> {
    #[cfg(feature = "p0-windows-sign-out-http")]
    if let Some(port) = env::var_os("KLAXON_P0_REFRESH_PORT") {
        return confirm_session_with(path, None, |slot, owner, marker| {
            if owner != Owner::A {
                return Err("unavailable");
            }
            let token = std::str::from_utf8(marker).map_err(|_| "unavailable")?;
            // Convex 1.51.0 POST /api/mutation, with Auth 2.1.0's refreshSession arguments.
            let request = serde_json::json!({
                "path": "auth:refreshSession",
                "format": "convex_encoded_json",
                "args": [{ "refreshToken": token }]
            });
            let (status, body) = loopback::post(port.to_str(), &request)?;
            if !(200..300).contains(&status) {
                return Err("retry-required");
            }
            accept_refresh(slot, &body)
        });
    }
    confirm_session(path, None)
}

fn confirm_session(
    path: &Path,
    expected: Option<SessionIdentity>,
) -> Result<ConfirmedSession, &'static str> {
    confirm_session_with(path, expected, |slot, owner, marker| {
        let access = match owner {
            Owner::A if marker == MARKER && provider_flag(path, "p0-require-successor")? => {
                return accept_refresh(
                    slot,
                    br#"{"status":"success","value":{"kind":"noSession"}}"#,
                );
            }
            Owner::A if marker == MARKER && provider_flag(path, "p0-provider-refresh")? => {
                return accept_refresh(slot, REFRESH_RESPONSE);
            }
            Owner::A if expected.is_some() && provider_flag(path, "p0-provider-rotated")? => {
                crate::ROTATED_OWNER_A_ACCESS
            }
            Owner::A => OWNER_A_ACCESS,
            Owner::B => "p0-inert-access-b",
        };
        Ok((access.to_owned(), marker))
    })
}

fn confirm_session_with(
    path: &Path,
    expected: Option<SessionIdentity>,
    check_provider: impl FnOnce(
        &store::Slot<'_>,
        Owner,
        &'static [u8],
    ) -> Result<(String, &'static [u8]), &'static str>,
) -> Result<ConfirmedSession, &'static str> {
    let slot = store::Slot::lock(path).map_err(|_| "unavailable")?;
    require_no_pending_sign_out(&slot)?;
    let record = slot.read().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => "signed-out",
        _ => "unavailable",
    })?;
    let (owner, marker) = match record.marker.as_slice() {
        MARKER => (Owner::A, MARKER),
        SUCCESSOR_MARKER => (Owner::A, SUCCESSOR_MARKER),
        PEER_MARKER => (Owner::B, PEER_MARKER),
        _ => return Err("unavailable"),
    };
    if expected.is_some_and(|session| session.owner != owner || Some(session.id) != record.id) {
        return Err("unavailable");
    }
    if provider_flag(path, "p0-provider-offline")? {
        return Err("retry-required");
    }
    let (access, marker) = check_provider(&slot, owner, marker)?;
    let id = slot.commit(&record, marker).map_err(|_| "unavailable")?;
    Ok(ConfirmedSession {
        identity: SessionIdentity { owner, id },
        access,
    })
}

#[cfg(not(feature = "p0-windows-sign-out-http"))]
#[tauri::command]
fn fixture_session(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
    operation: String,
) -> Result<&'static str, &'static str> {
    run_session(&window, &state, &operation)
}

#[cfg(feature = "p0-windows-sign-out-http")]
#[tauri::command]
async fn fixture_session(
    window: WebviewWindow,
    operation: String,
) -> Result<&'static str, &'static str> {
    // Keep the slot lock across the exchange without blocking the WebView event loop.
    tauri::async_runtime::spawn_blocking(move || {
        let state = window.state::<Mutex<Provider>>();
        run_session(&window, &state, &operation)
    })
    .await
    .map_err(|_| "unavailable")?
}

fn run_session(
    window: &WebviewWindow,
    state: &Mutex<Provider>,
    operation: &str,
) -> Result<&'static str, &'static str> {
    if !crate::is_fixture_window(window)
        || !matches!(operation, "seed" | "seed-peer" | "resume" | "sign-out")
    {
        return Err("unavailable");
    }
    let mut provider = state.lock().map_err(|_| "unavailable")?;
    if operation == "resume" {
        return provider.resume(slot().as_deref());
    }
    // Revoke before attempting I/O. Only a subsequent confirmed resume grants access.
    provider.revoke();
    let slot = slot().ok_or("unavailable")?;
    match operation {
        "seed" => seed_session(&slot, Owner::A),
        "seed-peer" => seed_session(&slot, Owner::B),
        #[cfg(not(feature = "p0-windows-sign-out-http"))]
        "sign-out" => sign_out::run(&slot),
        #[cfg(feature = "p0-windows-sign-out-http")]
        "sign-out" => sign_out::run_http(
            &slot,
            env::var("KLAXON_P0_SIGN_OUT_PORT").ok().as_deref(),
            || drop(provider),
        ),
        _ => Err("unavailable"),
    }
}

#[tauri::command]
fn fixture_sdk_access(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
) -> Result<String, &'static str> {
    provider(&window, &state)?.sdk_access(slot().as_deref())
}

#[tauri::command]
fn fixture_task_list(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
) -> Result<Rows, &'static str> {
    provider(&window, &state)?
        .active_tasks(slot().as_deref())?
        .rows()
}

#[tauri::command]
fn fixture_task_subscribe(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
    on_rows: Channel<Rows>,
) -> Result<(), &'static str> {
    provider(&window, &state)?
        .active_tasks(slot().as_deref())?
        .subscription = Some(on_rows);
    Ok(())
}

#[tauri::command]
fn fixture_task_publish(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
) -> Result<(), &'static str> {
    provider(&window, &state)?
        .active_tasks(slot().as_deref())?
        .publish()
}

pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
    builder
        .manage(Mutex::new(Provider::new()))
        .invoke_handler(tauri::generate_handler![
            fixture_session,
            fixture_sdk_access,
            fixture_task_list,
            fixture_task_subscribe,
            fixture_task_publish
        ])
}

#[cfg(test)]
mod tests;
