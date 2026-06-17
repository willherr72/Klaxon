# Mobile Background Sync (warm-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a periodic Android WorkManager job that runs one iroh pull/push sync pass every ~25 minutes while the app process is resident, so paired-device reminder data stays current without the app being foregrounded.

**Architecture:** A WorkManager `CoroutineWorker` (Kotlin) calls a `#[no_mangle] extern "C"` JNI function in the Rust lib. That function reads a process-global `AppHandle` (stashed once in Tauri's `setup()`) and, if present and sync is enabled, runs the existing `sync::task::run_one_pass`. If the process is cold (no handle) it no-ops. No sync-protocol changes.

**Tech Stack:** Rust (Tauri 2, tokio, iroh), Kotlin (AndroidX WorkManager), JNI.

## Global Constraints

- Reuse the existing sync pass `sync::task::run_one_pass(db: &Arc<Mutex<Connection>>, app: &AppHandle)` verbatim — no protocol/wire changes.
- Background sync is gated by the existing `sync_enabled` setting (via `crate::sync::read_enabled`). No new toggle.
- Interval: 25 minutes (OS floor is 15 min; user-accepted range 20-30).
- Native library name: `klaxon_lib` (`libklaxon_lib.so`, from `[lib] name = "klaxon_lib"` in `src-tauri/Cargo.toml`).
- Kotlin package: `com.klaxon.app`. JNI symbol must be `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce`.
- Android: `minSdk = 24`, `compileSdk = 36`. No new manifest permission (INTERNET already declared).
- Non-goals (do NOT implement): background alarm arming, cold-process sync, iOS.
- Build/run via `npm run tauri ...` from the repo root. Rust tests via `cargo` from `src-tauri/`.

---

### Task 1: Rust decision kernel (`mobile_bg` module)

Pure, platform-independent outcome logic, unit-tested on the desktop dev host. No Tauri/JNI types yet.

**Files:**
- Create: `src-tauri/src/mobile_bg.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod mobile_bg;`)
- Test: inline `#[cfg(test)]` module in `src-tauri/src/mobile_bg.rs`

**Interfaces:**
- Produces: `enum BgSyncOutcome { NotReady, Disabled, Ran }` with `fn code(self) -> i32`; `pub(crate) fn classify(handle_present: bool, sync_enabled: bool) -> BgSyncOutcome`.

- [ ] **Step 1: Create the module with the kernel + failing tests**

Create `src-tauri/src/mobile_bg.rs`:

```rust
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
```

- [ ] **Step 2: Declare the module in `lib.rs`**

In `src-tauri/src/lib.rs`, add the module declaration next to the others. Change:

```rust
mod alerts;
mod audio;
mod commands;
```

to:

```rust
mod alerts;
mod audio;
mod commands;
mod mobile_bg;
```

- [ ] **Step 3: Run the tests to verify they pass**

Run (from `src-tauri/`):

```
cargo test mobile_bg
```

Expected: the four `mobile_bg::tests::*` tests PASS.

(If `cargo test` errors about a missing frontend dist for `generate_context!`, run `npm run build` once from the repo root, then retry.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mobile_bg.rs src-tauri/src/lib.rs
git commit -m "feat(mobile): background-sync decision kernel + unit tests"
```

---

### Task 2: Rust mobile glue — live handle, sync entry point, JNI shim

Add the Tauri/Android-dependent parts: stash the app handle in `setup()`, run a real pass, and expose the JNI symbol. The decision logic from Task 1 is reused.

**Files:**
- Modify: `src-tauri/src/mobile_bg.rs` (append live + JNI code)
- Modify: `src-tauri/src/lib.rs` (call `register` in `setup()`)

**Interfaces:**
- Consumes: `classify`, `BgSyncOutcome` (Task 1); `crate::AppState` (`lib.rs`, has `db: Arc<Mutex<rusqlite::Connection>>`); `crate::sync::read_enabled(&db) -> bool`; `crate::sync::task::run_one_pass(&db, &app)`.
- Produces: `mobile_bg::register(app: tauri::AppHandle)` (mobile-only); JNI symbol `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce`.

- [ ] **Step 1: Append the live glue + JNI shim to `mobile_bg.rs`**

Append to `src-tauri/src/mobile_bg.rs`:

```rust
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
```

- [ ] **Step 2: Call `register` from `setup()` in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `app.manage(AppState { ... });` call inside `.setup(...)`. Immediately after the closing `});` of that `app.manage(...)` call (and before `#[cfg(desktop)] tray::setup(app)?;`), insert:

```rust
            // Mobile: stash the app handle so the WorkManager background-sync
            // worker can reach AppState via JNI. No-op / absent on desktop.
            #[cfg(mobile)]
            mobile_bg::register(app.handle().clone());
```

- [ ] **Step 3: Verify the desktop build is unbroken**

The new live/JNI code is `#[cfg(mobile)]` / `#[cfg(target_os = "android")]`, so the desktop build compiles only the Task 1 kernel. Run (from `src-tauri/`):

```
cargo test mobile_bg
```

Expected: still PASS, no new warnings about `mobile_bg`. (Android compilation of the live + JNI code is validated in Task 3 via the Tauri Android build.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/mobile_bg.rs src-tauri/src/lib.rs
git commit -m "feat(mobile): live app-handle registration + JNI sync entry point"
```

---

### Task 3: Kotlin worker + WorkManager dependency (compile-verified)

Add the worker that calls the JNI symbol, plus the WorkManager dependency. Verifying this with the Tauri Android build also compiles the Rust-for-Android from Task 2 and links the native lib.

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt`
- Modify: `src-tauri/gen/android/app/build.gradle.kts` (add WorkManager dependency)

**Interfaces:**
- Consumes: native symbol `nativeSyncOnce` from `libklaxon_lib.so` (Task 2).
- Produces: class `com.klaxon.app.BackgroundSyncWorker` (a `CoroutineWorker`) for Task 4 to schedule.

- [ ] **Step 1: Add the WorkManager dependency**

In `src-tauri/gen/android/app/build.gradle.kts`, inside the `dependencies { ... }` block (currently lines 60-69), add one line after the existing `implementation(...)` lines:

```kotlin
    implementation("androidx.work:work-runtime-ktx:2.9.1")
```

(`work-runtime-ktx` provides `CoroutineWorker` and pulls in Kotlin coroutines transitively.)

- [ ] **Step 2: Create the worker**

Create `src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt`:

```kotlin
package com.klaxon.app

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Periodic background sync. WorkManager wakes us roughly every 25 min while the
 * app process is resident; we call into Rust to run one iroh pull/push pass.
 *
 * Warm-only: if the process is cold the native side returns 0 (NotReady) and we
 * simply succeed and wait for the next period. Outcome codes:
 *   0 = NotReady (cold process), 1 = Disabled (sync off), 2 = Ran, -1 = error.
 */
class BackgroundSyncWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    private external fun nativeSyncOnce(): Int

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val outcome = try {
            nativeSyncOnce()
        } catch (t: Throwable) {
            Log.w(TAG, "background sync threw", t)
            -1
        }
        Log.i(TAG, "background sync outcome=$outcome")
        // Always success: this is a periodic job, so we rely on the next period
        // rather than WorkManager retry/backoff.
        Result.success()
    }

    companion object {
        private const val TAG = "Klaxon"

        init {
            // Resolve the JNI symbol. No-op if the Activity already loaded it
            // (warm process); needed if the worker class loads first.
            try {
                System.loadLibrary("klaxon_lib")
            } catch (t: Throwable) {
                Log.w(TAG, "loadLibrary(klaxon_lib) failed", t)
            }
        }
    }
}
```

- [ ] **Step 3: Build the Android app to verify it compiles + links**

Run from the repo root (requires the Android SDK/NDK env that `tauri android` uses):

```
npm run tauri android build -- --debug
```

Expected: build SUCCEEDS. This compiles the Kotlin worker, compiles the Rust lib for Android (validating the Task 2 `#[cfg(target_os = "android")]` JNI shim), and packages `libklaxon_lib.so` with the `nativeSyncOnce` symbol.

(Optional symbol check, if NDK `nm` is on PATH — replace the path with your ABI's `.so` under `src-tauri/gen/android/app/build/`:
`nm -D <path>/libklaxon_lib.so | findstr nativeSyncOnce` should list `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce`.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt src-tauri/gen/android/app/build.gradle.kts
git commit -m "feat(mobile): WorkManager BackgroundSyncWorker calling JNI sync"
```

---

### Task 4: Schedule the worker + on-device verification

Register the periodic job on app launch and verify the whole path on a device.

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/MainActivity.kt`

**Interfaces:**
- Consumes: `BackgroundSyncWorker` (Task 3).

- [ ] **Step 1: Enqueue unique periodic work in `MainActivity.onCreate`**

Replace the entire contents of `src-tauri/gen/android/app/src/main/java/com/klaxon/app/MainActivity.kt` with:

```kotlin
package com.klaxon.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    scheduleBackgroundSync()
  }

  /**
   * Register the ~25-minute background sync job. KEEP policy means relaunches
   * don't reset the schedule; WorkManager persists it across process death and
   * reboot on its own.
   */
  private fun scheduleBackgroundSync() {
    val request = PeriodicWorkRequestBuilder<BackgroundSyncWorker>(25, TimeUnit.MINUTES)
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build()
      )
      .build()
    WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
      "klaxon-bg-sync",
      ExistingPeriodicWorkPolicy.KEEP,
      request,
    )
  }
}
```

- [ ] **Step 2: Install on a device and confirm the job is registered**

Run from the repo root with a device/emulator connected:

```
npm run tauri android dev
```

Open the app once. Then in another terminal:

```
adb shell dumpsys jobscheduler | findstr klaxon
```

Expected: at least one job entry for `com.klaxon.app` is listed (the WorkManager-backed periodic job).

- [ ] **Step 3: Force the worker and confirm the native outcome**

Start a log filter:

```
adb logcat -s Klaxon:*
```

Find the numeric job id from the `dumpsys jobscheduler` output in Step 2 (the integer after `JOB #u0a…/…` for `com.klaxon.app`), then force-run it:

```
adb shell cmd jobscheduler run -f com.klaxon.app <jobId>
```

Expected: a logcat line `background sync outcome=2` (warm process, sync enabled → Ran). If sync is disabled in Settings, expect `outcome=1`.

- [ ] **Step 4: Cross-device data check**

With phone + laptop paired and sync enabled, and the phone app **backgrounded** (process still resident): create a new reminder on the laptop. Within a forced worker run (Step 3) or one ~25-min period, then foreground the phone and confirm the laptop-made reminder is present. (Per design, its alarm arms on this foreground, not earlier.)

- [ ] **Step 5: Cold no-op check**

Fully kill the phone app (swipe from recents AND `adb shell am force-stop com.klaxon.app`), then force-run the job (Step 3). Expected: logcat shows `background sync outcome=0` (NotReady) with no crash.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/klaxon/app/MainActivity.kt
git commit -m "feat(mobile): schedule ~25min periodic background sync on launch"
```

---

## Post-implementation

- Update `CHANGELOG.md` under the v0.4 work with an "Added — Android background sync (warm-only, ~25 min)" entry when cutting the next build. (Not a code task; fold into the v0.4 changelog pass.)
- The two known limitations (stops on full process-kill; alarms arm on next foreground) are documented in the design doc and are the entry point for a future cold-capable effort.
