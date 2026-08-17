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
//! untouched — output is simply written twice. Every record is flushed as
//! it is emitted, so a hang or a hard kill keeps the whole tail.
//!
//! Two caveats worth knowing before relying on this during an incident:
//!
//! * **Capacity is size-based, not time-based.** Steady-state failure logs
//!   roughly one line per 20s sync tick, so 5 MB holds days — but a relay
//!   reconnect storm or a `loglevel.txt` escalation can churn both files in
//!   hours and evict the onset you went looking for. Copy the files aside
//!   before escalating verbosity.
//! * **Two processes are not coordinated.** `single_instance` normally
//!   prevents it, but the sink opens before that plugin runs, so a
//!   short-lived second instance can rotate the file underneath the first.
//!   The result is misordered or lost records, never corruption or a hang.

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
/// Consecutive file-write failures tolerated before dropping the sink. A
/// transient lock (antivirus, a backup agent, a log viewer) must not cost
/// every later line on a tray-resident app that runs for weeks.
const MAX_FILE_ERRORS: u32 = 20;

struct Tee {
    file: Option<RotatingFile>,
    errors: u32,
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // `write_all`, not `write`: a partial stderr write (Windows consoles
        // cap at 4 KB) would make our caller retry with the remainder while
        // the file had already taken the whole buffer — duplicating the tail
        // of every large record, exactly during a `RUST_LOG=…debug` run.
        io::stderr().write_all(buf)?;
        if let Some(f) = self.file.as_mut() {
            if let Err(e) = f.write_all(buf) {
                // NOT eprintln!, which panics on a stderr error. env_logger
                // calls this while holding its pipe mutex, so a panic here
                // poisons that lock and every later log:: call panics with
                // it — on the main thread, during startup.
                let _ = writeln!(io::stderr(), "klaxon: file logging error: {e}");
                self.errors += 1;
                if self.errors >= MAX_FILE_ERRORS {
                    let _ = writeln!(
                        io::stderr(),
                        "klaxon: giving up on file logging after {} errors",
                        self.errors
                    );
                    self.file = None;
                }
            } else {
                self.errors = 0;
            }
        }
        Ok(buf.len())
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
    /// `None` between closing the old file and opening the new one during a
    /// rotation, and after a failed reopen — the next `write` retries.
    /// (Rust opens with FILE_SHARE_DELETE so Windows would permit renaming
    /// with the handle open; closing first is defensive, not required.)
    handle: Option<File>,
    written: u64,
    /// Injectable so rotation is testable without writing megabytes.
    max_bytes: u64,
    /// How many times rotation has failed in a row. Each one pushes the next
    /// attempt out by another `max_bytes` so a permanently unrenameable file
    /// costs one attempt per cap rather than one per record.
    deferred_rotations: u32,
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
            deferred_rotations: 0,
        })
    }

    /// Size at which the next rotation is attempted, backed off after
    /// consecutive failures.
    fn rotate_at(&self) -> u64 {
        self.max_bytes
            .saturating_mul(u64::from(self.deferred_rotations) + 1)
    }

    fn rotate(&mut self) -> io::Result<()> {
        // Close, move aside, reopen. No `remove_file` first: rename replaces
        // the destination atomically on both platforms, and deleting the
        // backup up front would throw away the only copy we had if the
        // rename then failed.
        self.handle = None;
        let renamed = std::fs::rename(&self.path, &self.previous);
        self.handle = Some(OpenOptions::new().create(true).append(true).open(&self.path)?);
        self.written = self
            .handle
            .as_ref()
            .and_then(|h| h.metadata().ok())
            .map(|m| m.len())
            .unwrap_or(0);
        renamed
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written + buf.len() as u64 > self.rotate_at() {
            if let Err(e) = self.rotate() {
                // Rotation failed, so the current file is still over its
                // cap. Push the next attempt out by a full cap's worth of
                // growth: retrying per-record would rename-and-reopen on
                // every single line, forever.
                let _ = writeln!(
                    io::stderr(),
                    "klaxon: log rotation failed, continuing in place: {e}"
                );
                self.deferred_rotations = self.deferred_rotations.saturating_add(1);
            } else {
                self.deferred_rotations = 0;
            }
        }
        // A rotation whose reopen failed leaves no handle. Try once more here
        // rather than letting one transient lock end file logging for the
        // lifetime of the process.
        if self.handle.is_none() {
            self.handle = OpenOptions::new().create(true).append(true).open(&self.path).ok();
            if self.handle.is_some() {
                self.written = 0;
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
    // Tauri resolves this through the RoamingAppData known folder rather
    // than the environment; they agree except when APPDATA has been
    // overridden, in which case the logs follow the override and the
    // database does not.
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute()) // matches `dirs`, which rejects relative
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
            let _ = writeln!(
                io::stderr(),
                "klaxon: could not open log file in {}: {e}",
                dir.display()
            );
            None
        }
    });
    Box::new(Tee { file, errors: 0 })
}

/// An optional log-filter override read from `<log dir>/loglevel.txt`.
///
/// `RUST_LOG` still wins, but it needs a console — and the launch contexts
/// where an intermittent failure actually happens (Explorer, autostart) have
/// none, so it was impossible to raise verbosity in the situation that most
/// needs it. Dropping a file next to the log and restarting now does it:
/// write e.g. `info,iroh=debug` into `loglevel.txt`.
pub fn filter_override() -> Option<String> {
    let path = log_dir()?.join("loglevel.txt");
    let raw = std::fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_owned())
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

    /// A rotation that cannot succeed must not cost log data, and must not
    /// retry on every single record. Forced by making the backup path a
    /// directory, which `rename` refuses to overwrite on either platform.
    #[test]
    fn a_failing_rotation_keeps_recording_and_backs_off() {
        let dir = std::env::temp_dir().join(format!("klaxon-log-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("klaxon.log.1")).unwrap();
        let mut f = RotatingFile::open(&dir, 100).unwrap();

        f.write_all(&[b'a'; 60]).unwrap();
        // Crossing the cap: rotation fails, but the record still lands.
        f.write_all(&[b'b'; 60]).unwrap();
        f.flush().unwrap();
        assert_eq!(f.deferred_rotations, 1, "the failure was recorded");
        assert_eq!(
            std::fs::read(dir.join("klaxon.log")).unwrap().len(),
            120,
            "no data lost when rotation cannot proceed"
        );

        // Backed off: the next attempt is a whole cap away, not next record.
        assert_eq!(f.rotate_at(), 200);
        f.write_all(&[b'c'; 10]).unwrap();
        f.flush().unwrap();
        assert_eq!(f.deferred_rotations, 1, "did not re-attempt on the next record");

        // Once the backup path is renameable, rotation resumes normally.
        std::fs::remove_dir(dir.join("klaxon.log.1")).unwrap();
        f.write_all(&[b'd'; 120]).unwrap();
        f.flush().unwrap();
        assert_eq!(f.deferred_rotations, 0, "recovered");
        assert!(dir.join("klaxon.log.1").is_file());

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
