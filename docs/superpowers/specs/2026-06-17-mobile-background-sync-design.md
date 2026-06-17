# Mobile Background Sync (Android, warm-only) — Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-06-17
**Branch:** `v0.4-mobile`
**Author:** William Herr (with Claude)

---

## 1. Problem

A reminder created on one paired device does not reach the other unless **both** devices have the app open and reachable at the same instant. Klaxon's sync is pure peer-to-peer over iroh with no always-on server: a sync pass (`sync::task::sync_one`) opens a live QUIC connection straight to the peer's `NodeId` and does pull-then-push *in that moment*. If the peer is unreachable, the pass fails and the change waits for the next overlap. iroh relays only assist connection setup — they do not store-and-forward data.

On desktop this is invisible (Klaxon autostarts and lives in the tray, so the machine is reachable whenever it's awake). On Android the app is only reachable while it is in the foreground:

- The background sync loop *is* spawned (`sync::task::run`, every 20s), but Android **freezes** a backgrounded app's process (the cached-app freezer), suspending its threads. The loop stops ticking until the app returns to the foreground.
- On-foreground sync already exists: `App.svelte` listens for `visibilitychange` and calls `api.syncNow()` → `sync_now` command → `run_one_pass`.

The user's environment: **phone + laptop only**, no always-on machine and none planned. Laptop uptime is **mixed** (sometimes asleep, sometimes left on). Acceptable propagation latency: **a few minutes**, refined to *"sync when I open the app, and roughly every 20-30 minutes while inactive."*

## 2. Goal & non-goals

### Goal
While the app's process is still **resident** in the background, run one pull/push sync pass approximately every 25 minutes, so paired-device reminder **data** stays current without the app being in the foreground. Keep on-foreground sync unchanged.

### Non-goals (this step)
- **Arming alarms in the background.** Alarm scheduling lives in the frontend (`mobile-scheduler.ts` → `reconcileScheduledNotifications`), and the webview JS is frozen in the background. Newly-synced reminders get their AlarmManager alarms armed on the next foreground, via the existing reconcile. Background alarm arming is deferred.
- **Syncing from a fully-killed process.** Once Android reclaims the process for real (not just freezes it), background sync stops until the app is reopened. Removing this ceiling requires the future "cold-capable" path.
- **iOS.** Only `gen/android` exists today. This design is Android-only.

These non-goals were explicitly accepted by the user as the scope of the first step. Both are lifted only by a later cold-capable + native-notification-scheduling effort, tracked separately.

## 3. Approach selection (recorded for context)

Three approaches were weighed against the phone+laptop-only, mixed-laptop-uptime, ~few-minute-latency constraints:

| Approach | Verdict |
| --- | --- |
| **Foreground service** (continuous iroh endpoint on the phone) | Most reliable; near-real-time. Rejected for now: requires a persistent notification + battery, and overshoots a 20-30 min bar. |
| **Periodic background sync (WorkManager)** — *chosen* | Fits the 20-30 min bar; no persistent notification. Within this, the **warm-only** variant was chosen over the cold-capable variant as the first step (lower effort; learn from it before committing to the heavier path). |
| **Cheap UX only** (push-on-create, last-synced indicator, manual Sync) | Useful but does not remove the "open both apps" requirement. Not sufficient alone. |

Within WorkManager, **warm-only** (sync only while the process is resident) was chosen over **cold-capable** (JNI-driven headless sync that wakes a killed process) to keep the first increment small. The accepted trade-off is the two non-goals above.

## 4. Architecture

Four small pieces, reusing the existing `run_one_pass` end to end. No change to the sync protocol, wire types, or the sync pass itself. The WorkManager job coexists with the resident 20s `sync::task::run` loop; its distinct value is covering the window where the process is resident but the OS has frozen the tokio loop (Doze/cached-app freezer) — so it is not redundant in the case that matters.

```
┌─────────────────────── Android app process ───────────────────────┐
│                                                                    │
│  WorkManager (OS)  ──fires every ~25 min──▶  BackgroundSyncWorker  │
│                                                  (Kotlin)          │
│                                                     │ JNI          │
│                                                     ▼              │
│                              nativeSyncOnce()  (Rust extern "C")   │
│                                                     │              │
│                                       try_background_sync()        │
│                                                     │              │
│                          reads static OnceLock<AppHandle>          │
│                          (set in setup(); empty if process cold)   │
│                                                     │ block_on     │
│                                                     ▼              │
│                       sync::task::run_one_pass(&db, &app)          │
│                         (existing — pull/push over iroh)           │
└────────────────────────────────────────────────────────────────────┘
```

### 4.1 Global handle to live sync state (Rust, `lib.rs`)
In `setup()`, after `app.manage(AppState { … })`, stash the app handle into a process-global under `#[cfg(mobile)]`:

```rust
// in mobile_bg.rs
static BG_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub fn register(app: tauri::AppHandle) { let _ = BG_APP.set(app); }
```

This is what lets background code reach the live DB + iroh endpoint (`AppState`) without going through Tauri's webview-IPC command layer. It is set exactly once, when the Activity runs `setup()`. If the process is cold (Activity never ran), `BG_APP` is empty.

### 4.2 Native sync entry point (Rust, new `src-tauri/src/mobile_bg.rs`)
Testable core plus a thin FFI shim:

```rust
pub enum BgSyncOutcome { NotReady, Disabled, Ran }

/// Reachable, testable without JNI.
pub fn try_background_sync() -> BgSyncOutcome {
    let Some(app) = BG_APP.get() else { return BgSyncOutcome::NotReady };
    let state = app.state::<crate::AppState>();
    if !crate::sync::read_enabled(&state.db) { return BgSyncOutcome::Disabled; }
    tauri::async_runtime::block_on(crate::sync::task::run_one_pass(&state.db, app));
    BgSyncOutcome::Ran
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "C" fn Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce(
    _env: jni::JNIEnv, _class: jni::objects::JClass,
) -> jni::sys::jint {
    std::panic::catch_unwind(|| match try_background_sync() {
        BgSyncOutcome::NotReady => 0,
        BgSyncOutcome::Disabled => 1,
        BgSyncOutcome::Ran => 2,
    }).unwrap_or(-1)
}
```

- `catch_unwind` ensures a panic never unwinds across the FFI boundary (undefined behavior otherwise).
- `run_one_pass` is reused verbatim — it already early-returns when sync is disabled and when the iroh endpoint isn't ready, logs and swallows per-peer errors, and emits `klaxon://reminders-changed` (harmless in the background; the frozen webview simply isn't listening).
- The exact JNI symbol name must match the Kotlin worker's fully-qualified class + method: `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce`.

### 4.3 WorkManager worker (Kotlin, new `BackgroundSyncWorker.kt`)
A `CoroutineWorker` under `com/klaxon/app/`:

```kotlin
class BackgroundSyncWorker(ctx: Context, params: WorkerParameters)
    : CoroutineWorker(ctx, params) {
    external fun nativeSyncOnce(): Int
    override suspend fun doWork(): Result {
        try { System.loadLibrary("klaxon_lib") } catch (_: Throwable) {}
        val outcome = try { nativeSyncOnce() } catch (e: Throwable) { -1 }
        Log.i("Klaxon", "background sync outcome=$outcome")
        return Result.success() // always success; rely on next period, no retry storm
    }
}
```

- The native library is `libklaxon_lib.so` (from `[lib] name = "klaxon_lib"` in `Cargo.toml`), loaded via `System.loadLibrary("klaxon_lib")`. `System.loadLibrary` is a no-op if already loaded (warm process, where `TauriActivity` has already loaded it); it only matters for resolving the symbol if the worker runs before the Activity has loaded it.
- Returns `Result.success()` regardless of outcome so the periodic schedule is preserved. A `NotReady` (cold) result is a clean no-op.

### 4.4 Scheduling (Kotlin, `MainActivity.kt`)
In `onCreate`, enqueue the periodic work:

```kotlin
val req = PeriodicWorkRequestBuilder<BackgroundSyncWorker>(25, TimeUnit.MINUTES)
    .setConstraints(Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED).build())
    .build()
WorkManager.getInstance(this).enqueueUniquePeriodicWork(
    "klaxon-bg-sync", ExistingPeriodicWorkPolicy.KEEP, req)
```

WorkManager persists this across process death and reboot via its own initializer/boot handling — no custom boot receiver required. `KEEP` avoids rescheduling duplicates on every launch.

## 5. Behavior, configuration, gating

- **Interval:** hardcoded 25 minutes (within the user's 20-30 min ask, comfortably above WorkManager's 15-min floor). No user-facing setting — YAGNI.
- **Gating:** already governed by the existing `sync_enabled` flag — `run_one_pass` early-returns via `read_enabled`, so the worker no-ops when sync is off. No separate background-sync toggle.
- **Doze:** under deep Doze the OS may stretch the interval to its maintenance windows. Expected and acceptable.
- **Permissions/deps:** adds only `androidx.work:work-runtime-ktx`. No new manifest permission (INTERNET is already present for iroh; no `FOREGROUND_SERVICE` since there is no foreground service).

## 6. Error handling

- **FFI boundary:** `catch_unwind` → integer status, never an unwind across JNI.
- **Per-peer failures:** already logged and swallowed inside `run_one_pass`; one unreachable peer does not abort the pass.
- **Concurrency:** a worker pass and a foreground `sync_now` may overlap. Safe by construction — DB access serializes on the existing `parking_lot::Mutex` in `run_one_pass`, and pull/push are idempotent (last-write-wins + per-peer watermarks). No new lock introduced.
- **Cold process:** `BG_APP` empty → `NotReady` → no-op; worker returns success and waits for the next period (or the next app launch, whichever comes first).

## 7. Testing

- **Rust unit tests** (no JNI): exercise `try_background_sync()` branch logic — `NotReady` when `BG_APP` is unset, `Disabled` when sync is off. The `extern "C"` shim is a thin mapping and is not unit-tested directly.
- **Device verification:**
  1. Pair phone + laptop, enable sync.
  2. Background the phone app; force the worker: `adb shell cmd jobscheduler run -f com.klaxon.app <jobId>` (or WorkManager's test tooling). Confirm a "background sync outcome=2" line in logcat.
  3. Create a reminder on the laptop; confirm it is present on the phone after foregrounding (data synced in the background).
  4. Kill the phone process fully; force the worker; confirm a clean no-op (`outcome=0`) and no crash.

## 8. Files touched

| File | Change |
| --- | --- |
| `src-tauri/src/lib.rs` | Call `mobile_bg::register(app.handle().clone())` in `setup()` under `#[cfg(mobile)]`; declare the new module. |
| `src-tauri/src/mobile_bg.rs` *(new)* | `BG_APP` global, `register`, `try_background_sync`, `BgSyncOutcome`, JNI shim. |
| `src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt` *(new)* | `CoroutineWorker` calling `nativeSyncOnce()`. |
| `src-tauri/gen/android/app/src/main/java/com/klaxon/app/MainActivity.kt` | Enqueue unique periodic work in `onCreate`. |
| `src-tauri/gen/android/app/build.gradle.kts` | Add `androidx.work:work-runtime-ktx` dependency. |
| `src-tauri/Cargo.toml` | Add `jni` crate dependency (Android target) if not already transitively available. |

`gen/android` is safe to edit: generated files are isolated under `…/generated/`; `MainActivity.kt` is already a custom file, and a sibling worker + a `build.gradle.kts` line survive `tauri android` regeneration.

## 9. Known limitations (by design)

- Stops syncing once Android fully kills the process (warm-only ceiling).
- Background-synced reminders' alarms arm on next foreground, not in the background.
- Android only.

All three are intentional for this increment and are the boundary at which a future **cold-capable + native-notification-scheduling** design takes over.
