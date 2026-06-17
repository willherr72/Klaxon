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

impl BgSyncOutcome {
    /// Stable integer code handed back across the JNI boundary.
    #[allow(dead_code)]
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
// Used on mobile + in tests; dead on the desktop host — see BgSyncOutcome above.
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

#[cfg(mobile)]
mod live {
    use super::{classify, BgSyncOutcome};
    use tauri::{AppHandle, Manager};

    /// Live app handle stashed once by `setup()` so background entry points can
    /// reach `AppState` (DB + iroh endpoint) without the webview IPC path.
    static BG_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

    /// Called once from `setup()`. Idempotent — a second call is ignored.
    pub fn register(app: AppHandle) {
        let _ = BG_APP.set(app);
    }

    /// Run one background sync pass if the process is warm and sync is enabled.
    /// Blocks the calling (worker) thread until the pass completes so iroh has
    /// time to connect.
    ///
    /// Complements the resident 20s `sync::task::run` loop: that loop fires while
    /// the process is truly resident, but Android's cached-app freezer suspends the
    /// tokio threads when the app is backgrounded. This WorkManager-driven pass
    /// provides a periodic execution slot while the process is resident-but-frozen.
    pub fn try_background_sync() -> BgSyncOutcome {
        let Some(app) = BG_APP.get() else {
            return BgSyncOutcome::NotReady;
        };
        let state = app.state::<crate::AppState>();
        let enabled = crate::sync::read_enabled(&state.db);
        match classify(true, enabled) {
            BgSyncOutcome::Ran => {
                tauri::async_runtime::block_on(crate::sync::task::run_one_pass(
                    &state.db, app,
                ));
                BgSyncOutcome::Ran
            }
            other => other,
        }
    }
}

#[cfg(mobile)]
pub use live::register;

/// JNI entry point for the Kotlin `BackgroundSyncWorker`. Returns the
/// `BgSyncOutcome` code. `JNIEnv*` and the worker `jobject` are passed as
/// opaque pointers we don't touch, so no `jni` crate dependency is needed.
/// `catch_unwind` keeps a Rust panic from unwinding across the FFI boundary
/// (undefined behavior otherwise) — a panic maps to -1.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce(
    _env: *mut std::ffi::c_void,
    _this: *mut std::ffi::c_void,
) -> i32 {
    std::panic::catch_unwind(|| live::try_background_sync().code()).unwrap_or(-1)
}

/// JNI entry point called from `MainActivity.onCreate` (before Tauri's
/// `setup()` runs) to initialize the global `ndk-context`. Tauri/wry never
/// set it, but crates that read it — `hickory-resolver` (iroh's DNS resolver)
/// and `cpal` — panic with "android context was not initialized" the instant
/// they run, which aborts the process in a release build. We stash the
/// JavaVM and a leaked global ref to the application Context so both pointers
/// stay valid for the whole process lifetime.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_MainActivity_nativeInitAndroidContext<'local>(
    env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    context: jni::objects::JObject<'local>,
) {
    use std::sync::atomic::{AtomicBool, Ordering};
    // `initialize_android_context` asserts it's called exactly once; Android
    // re-runs onCreate on activity recreation, so guard against re-init.
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    // A panic must not unwind across the JNI boundary; AssertUnwindSafe is
    // fine because we abandon `env`/`context` on the unwind path.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let Ok(vm) = env.get_java_vm() else { return };
        let Ok(ctx) = env.new_global_ref(context) else { return };
        // Safety: the JavaVM is process-global and the Context is kept alive
        // by leaking its global ref below; init runs once (guarded above).
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer() as *mut std::ffi::c_void,
                ctx.as_obj().as_raw() as *mut std::ffi::c_void,
            );
        }
        std::mem::forget(ctx);
    }));
}
