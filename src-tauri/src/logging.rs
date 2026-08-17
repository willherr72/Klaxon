//! Desktop file logging.
//!
//! Klaxon logged to stderr only, which Windows discards for a GUI app
//! launched from Explorer or autostart. The cost of that showed up in the
//! 2026-08-12..14 sync outage: the phone's side was diagnosed from logcat in
//! ninety seconds, while the desktop's had to be reconstructed from socket
//! tables and a purpose-written probe, because 42 hours of the app's own
//! account of events had gone to a discarded stderr. Android already has
//! logcat, so this is desktop-only.
//!
//! Deliberately a sink bolted onto the existing `env_logger` rather than a
//! different logging stack: the filter string in `lib.rs` is load-bearing
//! (iroh floods at info), and `RUST_LOG=debug klaxon.exe` from a terminal is
//! the ritual that cracked the v0.7.3 launch hang. Both keep working
//! untouched — output is simply written twice.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Roll over at this size. Two files means the worst case on disk is twice
/// this; big enough to hold days of steady-state logging at info level,
/// small enough to attach to a bug report.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Writes every record to stderr AND a size-capped file.
///
/// stderr stays first so a terminal run behaves exactly as before, and so a
/// failing file sink can never cost us the console output.
struct Tee {
    file: Option<RotatingFile>,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = io::stderr().write(buf)?;
        if let Some(f) = self.file.as_mut() {
            // A failed file write must not break logging. Drop the sink so
            // we stop retrying on every record, and say so on stderr once.
            if let Err(e) = f.write_all(buf) {
                eprintln!("klaxon: file logging disabled after write error: {e}");
                self.file = None;
            }
        }
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        io::stderr().flush()
    }
}

/// `klaxon.log`, rotated once to `klaxon.log.1` when it outgrows `MAX_BYTES`.
struct RotatingFile {
    path: PathBuf,
    previous: PathBuf,
    /// `None` only for the instant between closing the old file and opening
    /// the new one during a rotation — Windows will not rename a file that
    /// still has an open handle, so the handle genuinely has to go away.
    handle: Option<File>,
    written: u64,
    /// Injectable so rotation is testable without writing megabytes.
    max_bytes: u64,
}

impl RotatingFile {
    fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("klaxon.log");
        let handle = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = handle.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            previous: dir.join("klaxon.log.1"),
            path,
            handle: Some(handle),
            written,
            max_bytes,
        })
    }

    fn rotate(&mut self) -> io::Result<()> {
        // Close, move aside, reopen. If the rename fails we still reopen the
        // original path below, so the worst case is a log that grows past
        // its cap rather than one that stops recording.
        self.handle = None;
        let _ = std::fs::remove_file(&self.previous);
        let renamed = std::fs::rename(&self.path, &self.previous);
        self.handle = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
        self.written = if renamed.is_ok() {
            0
        } else {
            // Rename failed: we reopened the same file, so keep counting
            // from its real length instead of pretending it is empty.
            self.handle
                .as_ref()
                .and_then(|h| h.metadata().ok())
                .map(|m| m.len())
                .unwrap_or(0)
        };
        renamed.map(|_| ())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written + buf.len() as u64 > self.max_bytes {
            // A failed rotation must not swallow the record it interrupted.
            if let Err(e) = self.rotate() {
                eprintln!("klaxon: log rotation failed, continuing in place: {e}");
            }
        }
        let Some(handle) = self.handle.as_mut() else {
            return Err(io::Error::other("log file handle unavailable"));
        };
        let n = handle.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.handle.as_mut() {
            Some(h) => h.flush(),
            None => Ok(()),
        }
    }
}

/// Where the log lives: `<app data dir>/logs`.
///
/// Resolved by hand rather than through Tauri's path resolver because
/// logging is initialized before the app is built — and it must be, or the
/// startup sequence most likely to need explaining is the one part that
/// isn't logged. Mirrors what `app_data_dir()` returns for our identifier,
/// which `build.rs` reads out of `tauri.conf.json` so the two cannot drift.
pub fn log_dir() -> Option<PathBuf> {
    const IDENTIFIER: &str = env!("KLAXON_IDENTIFIER");
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    Some(base?.join(IDENTIFIER).join("logs"))
}

/// A `Write` sink for `env_logger` that tees to stderr and the log file.
/// Falls back to stderr alone if the file can't be opened — logging must
/// never be the reason the app fails to start.
pub fn tee_target() -> Box<dyn Write + Send + 'static> {
    let file = log_dir().and_then(|dir| match RotatingFile::open(&dir, MAX_BYTES) {
        Ok(f) => Some(f),
        Err(e) => {
            eprintln!("klaxon: could not open log file in {}: {e}", dir.display());
            None
        }
    });
    Box::new(Tee { file })
}

#[cfg(test)]
mod tests {
    use super::RotatingFile;
    use std::io::Write;

    /// The cap has to actually cap. An unbounded log is its own incident —
    /// it fills the disk of the machine you were trying to diagnose.
    #[test]
    fn the_log_rotates_once_it_outgrows_its_cap_and_keeps_one_backup() {
        let dir = std::env::temp_dir().join(format!("klaxon-log-test-{}", uuid::Uuid::new_v4()));
        let mut f = RotatingFile::open(&dir, 100).unwrap();

        f.write_all(&[b'a'; 60]).unwrap();
        assert!(!dir.join("klaxon.log.1").exists(), "no rotation before the cap");

        // Crossing the cap moves the current file aside and starts fresh.
        f.write_all(&[b'b'; 60]).unwrap();
        f.flush().unwrap();
        let rotated = std::fs::read(dir.join("klaxon.log.1")).unwrap();
        let current = std::fs::read(dir.join("klaxon.log")).unwrap();
        assert_eq!(rotated, vec![b'a'; 60], "the old content is preserved");
        assert_eq!(current, vec![b'b'; 60], "the new content starts a fresh file");

        // A second rotation replaces the backup rather than accumulating.
        f.write_all(&[b'c'; 60]).unwrap();
        f.flush().unwrap();
        assert_eq!(std::fs::read(dir.join("klaxon.log.1")).unwrap(), vec![b'b'; 60]);
        assert_eq!(std::fs::read(dir.join("klaxon.log")).unwrap(), vec![b'c'; 60]);
        assert!(!dir.join("klaxon.log.2").exists(), "only ever one backup");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Reopening must append rather than truncate — a restart is exactly
    /// when the preceding lines matter most.
    #[test]
    fn reopening_appends_instead_of_truncating() {
        let dir = std::env::temp_dir().join(format!("klaxon-log-test-{}", uuid::Uuid::new_v4()));
        {
            let mut f = RotatingFile::open(&dir, 1000).unwrap();
            f.write_all(b"before restart\n").unwrap();
            f.flush().unwrap();
        }
        {
            let mut f = RotatingFile::open(&dir, 1000).unwrap();
            f.write_all(b"after restart\n").unwrap();
            f.flush().unwrap();
        }
        let body = std::fs::read_to_string(dir.join("klaxon.log")).unwrap();
        assert!(body.contains("before restart"), "prior run survived");
        assert!(body.contains("after restart"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
