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
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
    Storage::FileSystem::{
        MoveFileExW, FILE_FLAG_DELETE_ON_CLOSE, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    },
};

const CONTEXT: &[u8] = b"dev.klaxon.p0native/session-v1/packaged";

pub(super) enum Publish {
    Seed,
    Refresh,
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

    pub(super) fn read(&self) -> io::Result<Vec<u8>> {
        let record = fs::read(self.path)?;
        dpapi(&record, false).map_err(io::Error::other)
    }

    pub(super) fn publish(&self, marker: &[u8], operation: Publish) -> io::Result<()> {
        let ciphertext = dpapi(marker, true)?;
        let staged = self.path.with_extension("staged");
        let mut file = File::create_new(&staged)?;
        let written = file.write_all(&ciphertext).and_then(|()| file.sync_all());
        drop(file);

        let refresh = matches!(operation, Publish::Refresh);
        let published = written.and_then(|()| {
            #[cfg(test)]
            if !refresh
                && self
                    .path
                    .with_file_name("discard-initial-stage")
                    .try_exists()?
            {
                fs::remove_file(&staged)?;
            }
            #[cfg(test)]
            if refresh {
                super::tests::crash_checkpoint(self.path, "before-replace");
            }
            let flags = MOVEFILE_WRITE_THROUGH
                | if refresh {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            // The staged file is on the same volume and the API can only rename it.
            // The seed operation omits replacement to protect an existing record.
            let wide = |path: &Path| {
                path.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>()
            };
            // Both paths are NUL-terminated and live for the duration of the call.
            if unsafe { MoveFileExW(wide(&staged).as_ptr(), wide(self.path).as_ptr(), flags) } == 0
            {
                return Err(io::Error::last_os_error());
            }
            #[cfg(test)]
            if refresh {
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
