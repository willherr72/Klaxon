use std::{
    collections::BTreeMap,
    env, fs,
    io::{self, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr, slice,
    sync::{Mutex, MutexGuard},
};
use tauri::{ipc::Channel, Builder, State, WebviewWindow, Wry};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::MoveFileW,
};

const MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/1";
const PEER_MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/2";
const CONTEXT: &[u8] = b"dev.klaxon.p0native/session-v1/packaged";

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

    fn sdk_access(&mut self, slot: Option<&Path>) -> Result<&'static str, &'static str> {
        let active = self.owner.ok_or("signed-out")?;
        // Recheck even for cached SDK sessions. A changed record requires a new explicit resume.
        let access = slot.ok_or("unavailable").and_then(|slot| {
            let owner = confirmed_owner(slot)?;
            if owner != active {
                return Err("unavailable");
            }
            if owner == Owner::A
                && slot
                    .with_file_name("p0-provider-rotated")
                    .try_exists()
                    .map_err(|_| "unavailable")?
            {
                return Ok(crate::ROTATED_OWNER_A_ACCESS);
            }
            Ok(match owner {
                Owner::A => "p0-inert-access-a",
                Owner::B => "p0-inert-access-b",
            })
        });
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

fn dpapi(input: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    fn blob(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
        Ok(CRYPT_INTEGER_BLOB {
            cbData: bytes
                .len()
                .try_into()
                .map_err(|_| io::ErrorKind::InvalidData)?,
            pbData: bytes.as_ptr().cast_mut(),
        })
    }
    let input = blob(input)?;
    let entropy = blob(CONTEXT)?;
    let mut output = CRYPT_INTEGER_BLOB::default();
    // Both APIs read the supplied buffers synchronously and allocate their output with LocalAlloc.
    // Omitting CRYPTPROTECT_LOCAL_MACHINE selects current-user protection.
    unsafe {
        let ok = if protect {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let bytes = if output.cbData == 0 {
            Vec::new()
        } else {
            slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec()
        };
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

fn seed(slot: &Path, marker: &[u8]) -> io::Result<()> {
    let protected = dpapi(marker, true)?;
    let staged = slot.with_extension(format!("{}.tmp", std::process::id()));
    let mut file = fs::File::create_new(&staged)?;
    let write = file.write_all(&protected);
    drop(file);
    let publish = write.and_then(|()| {
        let wide = |path: &Path| {
            path.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        // Same-directory rename. MoveFileW refuses to overwrite an existing destination.
        if unsafe { MoveFileW(wide(&staged).as_ptr(), wide(slot).as_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    });
    if publish.is_err() {
        fs::remove_file(staged)?;
    }
    publish
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

fn confirmed_owner(slot: &Path) -> Result<Owner, &'static str> {
    let record = fs::read(slot).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => "signed-out",
        _ => "unavailable",
    })?;
    let marker = dpapi(&record, false).map_err(|_| "unavailable")?;
    let owner = match marker.as_slice() {
        MARKER => Owner::A,
        PEER_MARKER => Owner::B,
        _ => return Err("unavailable"),
    };
    if slot
        .with_file_name("p0-provider-offline")
        .try_exists()
        .map_err(|_| "unavailable")?
    {
        return Err("retry-required");
    }
    Ok(owner)
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
        "resume" => match confirmed_owner(&slot) {
            Ok(owner) => {
                provider.owner = Some(owner);
                Ok("authenticated")
            }
            Err(status @ ("retry-required" | "signed-out")) => Ok(status),
            Err(error) => Err(error),
        },
        "sign-out" => match fs::remove_file(&slot) {
            Ok(()) => Ok("signed-out"),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("signed-out"),
            _ => Err("unavailable"),
        },
        _ => Err("unavailable"),
    }
}

#[tauri::command]
fn fixture_sdk_access(
    window: WebviewWindow,
    state: State<'_, Mutex<Provider>>,
) -> Result<&'static str, &'static str> {
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
mod tests {
    use super::*;

    #[test]
    fn sdk_access_rechecks_record_and_revokes_on_failure() {
        let mut provider = Provider::new();
        let directory = env::temp_dir().join(format!("klaxon-p0-sdk-test-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        let slot = directory.join("packaged.bin");
        let offline = directory.join("p0-provider-offline");
        let rotated = directory.join("p0-provider-rotated");
        let path = Some(slot.as_path());

        seed(&slot, MARKER).unwrap();
        assert_eq!(provider.sdk_access(path).err(), Some("signed-out"));
        provider.owner = Some(confirmed_owner(&slot).unwrap());
        let expected = "p0-inert-access-a";
        assert!(provider.sdk_access(path).unwrap() == expected);
        fs::write(&rotated, []).unwrap();
        let rotated_access = provider.sdk_access(path);

        fs::write(&offline, []).unwrap();
        assert_eq!(provider.sdk_access(path).err(), Some("retry-required"));
        fs::remove_file(&offline).unwrap();
        assert_eq!(provider.sdk_access(path).err(), Some("signed-out"));

        provider.owner = Some(confirmed_owner(&slot).unwrap());
        fs::remove_file(&slot).unwrap();
        seed(&slot, PEER_MARKER).unwrap();
        assert_eq!(provider.sdk_access(path).err(), Some("unavailable"));
        assert!(provider.owner.is_none());
        provider.owner = Some(confirmed_owner(&slot).unwrap());
        let expected = "p0-inert-access-b";
        assert!(provider.sdk_access(path).unwrap() == expected);

        fs::write(&slot, b"damaged").unwrap();
        assert_eq!(provider.sdk_access(path).err(), Some("unavailable"));
        assert!(provider.owner.is_none());
        fs::remove_file(&slot).unwrap();
        fs::remove_file(&rotated).unwrap();
        fs::remove_dir(&directory).unwrap();
        let expected = concat!(
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
            "eyJzdWIiOiJwMC1pbmVydC1hY2Nlc3MtYTIiLCJpYXQiOjE3MDAwMDAwMDAsImV4cCI6MTcwMDA4NjQwMH0.",
            "cDAtbm90LWEtc2lnbmF0dXJl"
        );
        assert!(rotated_access.is_ok_and(|access| access == expected));
    }
}
