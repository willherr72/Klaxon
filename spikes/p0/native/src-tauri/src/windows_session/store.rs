use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::Path,
    ptr, slice,
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        BCryptGenRandom, CryptProtectData, CryptUnprotectData, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{
        MoveFileExW, FILE_FLAG_DELETE_ON_CLOSE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
};

const CONTEXT: &[u8] = b"dev.klaxon.p0native/session-v1/packaged";
const RECORD_HEADER: &[u8] = b"klaxon-p0-session-v2\0";

pub(super) type SessionId = [u8; 16];

pub(super) struct Record {
    pub(super) id: Option<SessionId>,
    pub(super) marker: Vec<u8>,
}

enum Publish {
    Seed,
    ReplaceSession,
    SignOutState,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum SignOutState {
    Pending,
    Acknowledged,
}

pub(super) struct Slot<'a> {
    path: &'a Path,
    _lock: File,
}

impl<'a> Slot<'a> {
    pub(super) fn lock(path: &'a Path) -> io::Result<Self> {
        // All fixture operations acquire this exclusive handle. Windows removes the lock
        // on close, including after process termination. Contention fails closed.
        let lock = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
            .open(path.with_extension("lock"))?;
        // Only this slot's reserved staging file can be left by an interrupted writer.
        remove_if_present(&path.with_extension("staged"))?;
        Ok(Self { path, _lock: lock })
    }

    pub(super) fn read(&self) -> io::Result<Record> {
        let bytes = dpapi(&fs::read(self.path)?, false).map_err(io::Error::other)?;
        let Some(payload) = bytes.strip_prefix(RECORD_HEADER) else {
            // The previous fixture format protected just the inert marker.
            return Ok(Record {
                id: None,
                marker: bytes,
            });
        };
        let (id, marker) = payload
            .split_first_chunk::<16>()
            .ok_or(io::ErrorKind::InvalidData)?;
        Ok(Record {
            id: Some(*id),
            marker: marker.to_vec(),
        })
    }

    pub(super) fn seed(&self, marker: &[u8]) -> io::Result<()> {
        self.write_session(new_session_id()?, marker, Publish::Seed)
    }

    // Commit a confirmed marker and bind legacy records in the same atomic write.
    pub(super) fn commit(&self, record: &Record, marker: &[u8]) -> io::Result<SessionId> {
        let id = match record.id {
            Some(id) if record.marker == marker => return Ok(id),
            Some(id) => id,
            None => new_session_id()?,
        };
        self.write_session(id, marker, Publish::ReplaceSession)?;
        Ok(id)
    }

    fn write_session(&self, id: SessionId, marker: &[u8], operation: Publish) -> io::Result<()> {
        let payload = [RECORD_HEADER, &id, marker].concat();
        let ciphertext = dpapi(&payload, true)?;
        self.publish_record(&ciphertext, self.path, operation)
    }

    #[cfg(test)]
    pub(super) fn seed_legacy(&self, marker: &[u8]) -> io::Result<()> {
        self.publish_record(&dpapi(marker, true)?, self.path, Publish::Seed)
    }

    pub(super) fn sign_out_state(&self) -> io::Result<Option<SignOutState>> {
        match fs::read(self.path.with_extension("signout-pending")) {
            Ok(state) => match state.as_slice() {
                b"pending" => Ok(Some(SignOutState::Pending)),
                b"acknowledged" => Ok(Some(SignOutState::Acknowledged)),
                _ => Err(io::ErrorKind::InvalidData.into()),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) fn set_sign_out_state(&self, state: SignOutState) -> io::Result<()> {
        let state: &[u8] = match state {
            SignOutState::Pending => b"pending",
            SignOutState::Acknowledged => b"acknowledged",
        };
        self.publish_record(
            state,
            &self.path.with_extension("signout-pending"),
            Publish::SignOutState,
        )
    }

    pub(super) fn finish_sign_out(&self) -> io::Result<()> {
        self.remove()?;
        #[cfg(test)]
        super::tests::crash_checkpoint(self.path, "after-sign-out-remove");
        remove_if_present(&self.path.with_extension("signout-pending"))
    }

    fn publish_record(
        &self,
        record: &[u8],
        destination: &Path,
        operation: Publish,
    ) -> io::Result<()> {
        let staged = self.path.with_extension("staged");
        let mut file = File::create_new(&staged)?;
        let written = file.write_all(record).and_then(|()| file.sync_all());
        drop(file);

        let seed = matches!(operation, Publish::Seed);
        #[cfg(test)]
        let replace_session = matches!(operation, Publish::ReplaceSession);
        let published = written.and_then(|()| {
            #[cfg(test)]
            if seed
                && self
                    .path
                    .with_file_name("discard-initial-stage")
                    .try_exists()?
            {
                fs::remove_file(&staged)?;
            }
            #[cfg(test)]
            if replace_session {
                super::tests::crash_checkpoint(self.path, "before-replace");
            }
            let flags = MOVEFILE_WRITE_THROUGH | if seed { 0 } else { MOVEFILE_REPLACE_EXISTING };
            // The staged file is on the same volume and the API can only rename it.
            // The seed operation omits replacement to protect an existing record.
            let wide = |path: &Path| {
                path.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            // Both paths are NUL-terminated and live for the duration of the call.
            if unsafe { MoveFileExW(wide(&staged).as_ptr(), wide(destination).as_ptr(), flags) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            #[cfg(test)]
            if replace_session {
                super::tests::crash_checkpoint(self.path, "after-replace");
            }
            Ok(())
        });
        if published.is_err() {
            remove_if_present(&staged)?;
        }
        published
    }

    pub(super) fn remove(&self) -> io::Result<()> {
        remove_if_present(self.path)
    }
}

fn new_session_id() -> io::Result<SessionId> {
    let mut id = [0; 16];
    // The system RNG takes a null algorithm handle and writes only to this buffer.
    let status = unsafe {
        BCryptGenRandom(
            ptr::null_mut(),
            id.as_mut_ptr(),
            id.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(io::Error::other("could not generate fixture session ID"));
    }
    Ok(id)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
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
