//! Mobile (Android) background-sync glue.
//!
//! A WorkManager periodic worker calls into Rust here roughly every 25 min to
//! run one sync pass while the app process is resident. Warm-only: if the
//! process is cold (Tauri `setup()` never ran, so no live `AppHandle`), the
//! attempt no-ops. See
//! docs/superpowers/specs/2026-06-17-mobile-background-sync-design.md.

/// Result of a background-sync attempt, surfaced to the Kotlin worker as an
/// int for logging. `Ran` means a pass was *dispatched* — per-peer success is
/// logged inside the pass itself.
// Used on mobile and in tests; silence the desktop non-test dead-code warning.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BgSyncOutcome {
    /// No live app handle — process is cold; nothing to do.
    NotReady,
    /// Sync is disabled in settings; skip.
    Disabled,
    /// A sync pass was dispatched.
    Ran,
}

#[allow(dead_code)]
impl BgSyncOutcome {
    /// Stable integer code handed back across the JNI boundary.
    pub fn code(self) -> i32 {
        match self {
            BgSyncOutcome::NotReady => 0,
            BgSyncOutcome::Disabled => 1,
            BgSyncOutcome::Ran => 2,
        }
    }
}

/// Pure decision kernel: given whether the live app handle exists and (when it
/// does) whether sync is enabled, decide the outcome. Free of Tauri/JNI types
/// so it is unit-testable on the desktop dev host.
#[allow(dead_code)]
pub(crate) fn classify(handle_present: bool, sync_enabled: bool) -> BgSyncOutcome {
    if !handle_present {
        BgSyncOutcome::NotReady
    } else if !sync_enabled {
        BgSyncOutcome::Disabled
    } else {
        BgSyncOutcome::Ran
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_process_is_not_ready() {
        // Absence of a handle dominates regardless of the enabled flag.
        assert_eq!(classify(false, true), BgSyncOutcome::NotReady);
        assert_eq!(classify(false, false), BgSyncOutcome::NotReady);
    }

    #[test]
    fn disabled_sync_skips() {
        assert_eq!(classify(true, false), BgSyncOutcome::Disabled);
    }

    #[test]
    fn ready_and_enabled_runs() {
        assert_eq!(classify(true, true), BgSyncOutcome::Ran);
    }

    #[test]
    fn outcome_codes_are_stable() {
        assert_eq!(BgSyncOutcome::NotReady.code(), 0);
        assert_eq!(BgSyncOutcome::Disabled.code(), 1);
        assert_eq!(BgSyncOutcome::Ran.code(), 2);
    }
}
