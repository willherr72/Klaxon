use std::{
    collections::BTreeMap,
    env, io,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use tauri::{ipc::Channel, Builder, State, WebviewWindow, Wry};

mod store;

const MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/1";
const PEER_MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/2";
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

struct Task {
    owner: Owner,
    id: &'static str,
    title: &'static str,
    updated_title: &'static str,
}

type Rows = Vec<BTreeMap<&'static str, &'static str>>;

struct Provider {
    owner: Option<Owner>,
    subscription: Option<Channel<Rows>>,
    tasks: [Task; 2],
}

impl Provider {
    fn new() -> Self {
        Self {
            owner: None,
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
        self.owner = None;
        self.subscription = None;
    }

    fn sdk_access(&mut self, slot: Option<&Path>) -> Result<String, &'static str> {
        let active = self.owner.ok_or("signed-out")?;
        // Recheck even for cached SDK sessions. An owner change requires explicit resume.
        let access = slot
            .ok_or("unavailable")
            .and_then(|slot| confirm_session(slot, Some(active)))
            .map(|session| session.access);
        if access.is_err() {
            self.revoke();
        }
        access
    }

    fn rows(&self) -> Result<Rows, &'static str> {
        let owner = self.owner.ok_or("signed-out")?;
        Ok(self
            .tasks
            .iter()
            .filter(|task| task.owner == owner)
            .map(|task| BTreeMap::from([("id", task.id), ("title", task.title)]))
            .collect())
    }

    fn publish(&mut self) -> Result<(), &'static str> {
        let owner = self.owner.ok_or("signed-out")?;
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

fn seed(slot: &Path, marker: &[u8]) -> io::Result<()> {
    store::Slot::lock(slot)?.publish(marker, store::Publish::Seed)
}

fn provider<'a>(
    window: &WebviewWindow,
    state: &'a Mutex<Provider>,
) -> Result<MutexGuard<'a, Provider>, &'static str> {
    if !crate::is_fixture_window(window) {
        return Err("unavailable");
    }
    state.lock().map_err(|_| "unavailable")
}

struct ConfirmedSession {
    owner: Owner,
    access: String,
}

fn provider_flag(slot: &Path, flag: &str) -> Result<bool, &'static str> {
    slot.with_file_name(flag)
        .try_exists()
        .map_err(|_| "unavailable")
}

fn accept_refresh(slot: &store::Slot<'_>, body: &[u8]) -> Result<String, &'static str> {
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
    slot.publish(grant.refresh_token.as_bytes(), store::Publish::Refresh)
        .map_err(|_| "unavailable")?;
    Ok(grant.access_token)
}

fn confirm_session(
    path: &Path,
    expected_owner: Option<Owner>,
) -> Result<ConfirmedSession, &'static str> {
    let slot = store::Slot::lock(path).map_err(|_| "unavailable")?;
    let marker = slot.read().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => "signed-out",
        _ => "unavailable",
    })?;
    let owner = match marker.as_slice() {
        MARKER | SUCCESSOR_MARKER => Owner::A,
        PEER_MARKER => Owner::B,
        _ => return Err("unavailable"),
    };
    if expected_owner.is_some_and(|expected| expected != owner) {
        return Err("unavailable");
    }
    if provider_flag(path, "p0-provider-offline")? {
        return Err("retry-required");
    }
    let access = match owner {
        Owner::A if marker == MARKER && provider_flag(path, "p0-require-successor")? => {
            accept_refresh(
                &slot,
                br#"{"status":"success","value":{"kind":"noSession"}}"#,
            )?
        }
        Owner::A if marker == MARKER && provider_flag(path, "p0-provider-refresh")? => {
            accept_refresh(&slot, REFRESH_RESPONSE)?
        }
        Owner::A if expected_owner.is_some() && provider_flag(path, "p0-provider-rotated")? => {
            crate::ROTATED_OWNER_A_ACCESS.to_owned()
        }
        Owner::A => OWNER_A_ACCESS.to_owned(),
        Owner::B => "p0-inert-access-b".to_owned(),
    };
    Ok(ConfirmedSession { owner, access })
}

#[tauri::command]
fn fixture_session(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
    operation: String,
) -> Result<&'static str, &'static str> {
    let mut provider = provider(&window, &state)?;
    if !matches!(
        operation.as_str(),
        "seed" | "seed-peer" | "resume" | "sign-out"
    ) {
        return Err("unavailable");
    }
    // Revoke before attempting I/O. Only a subsequent confirmed resume grants access.
    provider.revoke();
    let slot = slot().ok_or("unavailable")?;
    match operation.as_str() {
        "seed" | "seed-peer" => {
            let marker = if operation == "seed" {
                MARKER
            } else {
                PEER_MARKER
            };
            seed(&slot, marker)
                .map(|_| "fixture-ready")
                .map_err(|_| "unavailable")
        }
        "resume" => match confirm_session(&slot, None) {
            Ok(session) => {
                provider.owner = Some(session.owner);
                Ok("authenticated")
            }
            Err(status @ ("retry-required" | "signed-out")) => Ok(status),
            Err(error) => Err(error),
        },
        "sign-out" => sign_out(&slot),
        _ => Err("unavailable"),
    }
}

fn sign_out(slot: &Path) -> Result<&'static str, &'static str> {
    store::Slot::lock(slot)
        .and_then(|slot| slot.remove())
        .map(|_| "signed-out")
        .map_err(|_| "unavailable")
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
    let provider = provider(&window, &state)?;
    slot().ok_or("unavailable")?;
    provider.rows()
}

#[tauri::command]
fn fixture_task_subscribe(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
    on_rows: Channel<Rows>,
) -> Result<(), &'static str> {
    let mut provider = provider(&window, &state)?;
    slot().ok_or("unavailable")?;
    provider.owner.ok_or("signed-out")?;
    provider.subscription = Some(on_rows);
    Ok(())
}

#[tauri::command]
fn fixture_task_publish(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
) -> Result<(), &'static str> {
    let mut provider = provider(&window, &state)?;
    slot().ok_or("unavailable")?;
    provider.publish()
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
