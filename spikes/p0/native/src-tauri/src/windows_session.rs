use std::{
    env, fs,
    io::{self, Write},
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr, slice,
};
use tauri::{Builder, WebviewWindow, Wry};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::MoveFileW,
};

const MARKER: &[u8] = b"KLAXON-P0-INERT/packaged/1";
const CONTEXT: &[u8] = b"dev.klaxon.p0native/session-v1/packaged";

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

fn seed(slot: &Path) -> io::Result<()> {
    let protected = dpapi(MARKER, true)?;
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

#[tauri::command]
fn fixture_session(window: WebviewWindow, operation: String) -> Result<&'static str, &'static str> {
    if !crate::allows_fixture(&window, &operation) {
        return Err("unavailable");
    }
    let slot = slot().ok_or("unavailable")?;
    match operation.as_str() {
        "seed" => seed(&slot)
            .map(|_| "fixture-ready")
            .map_err(|_| "unavailable"),
        "resume" => match fs::read(&slot) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("signed-out"),
            // Simulated provider accepts only the fixture owner's expected generation.
            Ok(record) if dpapi(&record, false).as_deref().ok() == Some(MARKER) => {
                Ok("authenticated")
            }
            _ => Err("unavailable"),
        },
        "sign-out" => match fs::remove_file(&slot) {
            Ok(()) => Ok("signed-out"),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("signed-out"),
            _ => Err("unavailable"),
        },
        _ => Err("unavailable"),
    }
}

pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
    builder.invoke_handler(tauri::generate_handler![fixture_session])
}
