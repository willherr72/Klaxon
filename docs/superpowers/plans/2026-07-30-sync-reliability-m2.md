# Sync Reliability M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The phone syncs from a cold process — the periodic WorkManager job works after Android kills the app, and an Android share triggers a sync within minutes even with Klaxon closed.

**Architecture:** The sync pass core is split from its app integration: `sync_one_core` returns a `PassEffects` (alerts to cancel, UI events to emit) that the app-process caller applies and the headless caller drops — a cold process has no ringing alerts and no webview. The headless path opens the database directly, binds the iroh endpoint from the persisted secret, runs one pass against persisted peers, and tears down. `ShareActivity` enqueues an expedited one-shot of the same worker after a successful save.

**Tech Stack:** Rust (tokio runtime built by hand in the worker thread, iroh, rusqlite), JNI (`jni` 0.21), Kotlin (WorkManager 2.9.1 `CoroutineWorker`, `setExpedited`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-sync-reliability-design.md` §5 + §7. Builds on M1 (merged into `feat/sync-reliability`).
- Baseline entering M2: **81 tests, 0 warnings**; svelte-check 0 errors (7 pre-existing warnings). No frontend changes in M2.
- **One iroh identity must never have two live endpoints.** The worker checks for a live `AppHandle` first and takes the warm path; the headless endpoint binds only when the process is cold. Known accepted edge: a worker firing during the few seconds of Tauri setup before `BG_APP` is registered could briefly overlap — transient, relay re-registration converges, documented not defended.
- **A cold WorkManager process never ran `MainActivity.onCreate`**, so the ndk-context is uninitialized and iroh's DNS resolver aborts the process (the exact v0.4 bug, `mobile_bg.rs` bottom). The worker must initialize it itself before any Rust networking.
- **Named non-goal (spec §5):** cold sync delivers data; arming alarms for freshly synced reminders still waits for the next foreground.
- Android env: `JAVA_HOME` = Android Studio jbr (JDK 21), `ANDROID_HOME`, `NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006`. JDK 25 fails at Gradle configure.
- `gen/android` is tracked in git — Kotlin edits there persist.
- Outcome codes are a stable JNI contract: `0 NotReady, 1 Disabled, 2 Ran (warm), -1 error` — extend with `3 RanCold`, never renumber.

---

### Task 1: Split the pass core from its app integration

**Files:**
- Modify: `src-tauri/src/sync/task.rs`

**Interfaces:**
- Produces:
  - `pub struct PassEffects { pub to_cancel: Vec<String>, pub reminders_changed: bool, pub thoughts_changed: bool }`
  - `async fn sync_one_core(db, endpoint, extra_seeds: &[iroh::TransportAddr], peer) -> AppResult<PassEffects>` — the full pull/apply/push pass, **no `AppHandle`**
  - `pub async fn run_one_pass_headless(db: &Arc<Mutex<Connection>>, endpoint: &Endpoint) -> PassOutcome` — peer loop with the same 10s budget, effects dropped
  - Existing `run_one_pass(db, app)` keeps its signature; `sync_one` becomes a thin wrapper: gather mDNS seeds from `AppState`, call core, apply effects.

- [ ] **Step 1: Restructure `sync_one`**

In `task.rs`, rename the existing `sync_one` body to `sync_one_core` with signature:

```rust
/// The sync pass proper — pull, apply, push — with no app-process
/// dependencies. Returns the side effects the caller should apply:
/// in the app that means cancelling alerts and refreshing the UI; a
/// headless worker (cold Android process) drops them — nothing is
/// ringing and there is no webview to refresh.
async fn sync_one_core(
    db: &Arc<Mutex<Connection>>,
    endpoint: &Endpoint,
    extra_seeds: &[iroh::TransportAddr],
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<PassEffects> {
```

Inside, three changes from the current body:

1. The seed block loses its `AppState` half — persisted seeds stay, then:

```rust
    for addr in extra_seeds {
        if !seed.contains(addr) {
            seed.push(addr.clone());
        }
    }
```

2. Replace the three `app` uses with effect collection. Where the body currently calls `alerts::cancel_alert(app, &id)` / `emit_reminders_changed(app)` / `emit_thoughts_changed(app)`, build the result instead:

```rust
    let effects = PassEffects {
        to_cancel,
        reminders_changed: !pulled.reminders.is_empty()
            || !pulled.tombstones.is_empty()
            || !pulled.lanes.is_empty(),
        thoughts_changed: !pulled.thoughts.is_empty() || !pulled.tombstones.is_empty(),
    };
```

(the existing `to_cancel` vec is already accumulated; it just gets returned instead of consumed). All `Ok(())` returns become `Ok(PassEffects::default())` — derive `Default` on the struct.

3. Nothing else changes — watermark writes, `record_sync_ok`, push, logging all stay in the core.

Then the new thin `sync_one` wrapper:

```rust
/// App-process wrapper: gather mDNS-fresh seeds, run the core, apply the
/// effects (cancel alerts, poke the webview).
async fn sync_one(
    db: &Arc<Mutex<Connection>>,
    app: &AppHandle,
    endpoint: &Endpoint,
    peer: &crate::db::peers::Peer,
) -> crate::error::AppResult<()> {
    let mut extra: Vec<iroh::TransportAddr> = Vec::new();
    if let Some(node_id) = peer.iroh_node_id.as_deref() {
        if let Some(st) = app.try_state::<crate::AppState>() {
            if let Some(disc) = st.discovery.lock().as_ref() {
                extra.extend(disc.addrs_for_node(node_id).into_iter().map(iroh::TransportAddr::Ip));
            }
        }
    }
    let effects = sync_one_core(db, endpoint, &extra, peer).await?;
    for id in &effects.to_cancel {
        alerts::cancel_alert(app, id);
    }
    if effects.reminders_changed {
        emit_reminders_changed(app);
    }
    if effects.thoughts_changed {
        emit_thoughts_changed(app);
    }
    Ok(())
}
```

- [ ] **Step 2: Add the headless pass loop**

```rust
/// One pass with no app process: same peer walk, same per-peer budget,
/// effects dropped. Used by the cold Android WorkManager path — and by
/// nothing else, so it lives behind the same rules (sync_enabled gate,
/// error recording) as the app loop.
pub async fn run_one_pass_headless(
    db: &Arc<Mutex<Connection>>,
    endpoint: &Endpoint,
) -> PassOutcome {
    const NONE: PassOutcome = PassOutcome { attempted: 0, failed: 0 };
    if !crate::sync::read_enabled(db) {
        return NONE;
    }
    let peer_list = {
        let conn = db.lock();
        match peers::list_all(&conn) {
            Ok(p) => p,
            Err(e) => {
                log::warn!("headless sync list peers: {e}");
                return NONE;
            }
        }
    };
    let mut attempted = 0usize;
    let mut failed = 0usize;
    for peer in peer_list {
        attempted += 1;
        let fut = async {
            sync_one_core(db, endpoint, &[], &peer).await.map(|_| ())
        };
        match with_peer_timeout(fut, SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                let conn = db.lock();
                let _ = peers::record_sync_err(&conn, &peer.id, &e.to_string(), crate::models::now_ms());
            }
            PeerSyncResult::TimedOut => {
                failed += 1;
                let conn = db.lock();
                let _ = peers::record_sync_err(
                    &conn,
                    &peer.id,
                    "timed out after 10s — peer unreachable",
                    crate::models::now_ms(),
                );
            }
        }
    }
    PassOutcome { attempted, failed }
}
```

Note `run_one_pass_headless` is dead code on desktop — mark it `#[cfg_attr(not(target_os = "android"), allow(dead_code))]` rather than cfg-ing it out, so it still compiles (and breaks loudly) on the host.

- [ ] **Step 3: Verify**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result"` — 81 passing.
Run: `cargo build 2>&1 | grep -c "^warning"` — 0.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync/task.rs
git commit -m "refactor(sync): split the pass core from app integration"
```

---

### Task 2: Cold-capable JNI path in mobile_bg

**Files:**
- Modify: `src-tauri/src/mobile_bg.rs`

**Interfaces:**
- Produces:
  - `BgSyncOutcome::RanCold` with code `3`
  - `Java_com_klaxon_app_BackgroundSyncWorker_nativeInitAndroidContext(env, this, context)` — same guarded init as MainActivity's, shared body
  - `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce(env, this, dataDir: JString) -> jint` — warm path if `BG_APP` is set, else headless

- [ ] **Step 1: Extend the outcome enum and its tests**

In `mobile_bg.rs`, add the variant and code:

```rust
    /// A pass ran from a cold process via the headless path.
    RanCold,
```

```rust
            BgSyncOutcome::RanCold => 3,
```

Extend the existing `outcome_codes_are_stable` test:

```rust
        assert_eq!(BgSyncOutcome::RanCold.code(), 3);
```

- [ ] **Step 2: Share the ndk-context init**

The guarded body of `Java_com_klaxon_app_MainActivity_nativeInitAndroidContext` moves to a private fn, and both exports call it:

```rust
#[cfg(target_os = "android")]
fn init_android_context_guarded(env: jni::JNIEnv<'_>, context: jni::objects::JObject<'_>) {
    // body of the existing MainActivity export, unchanged (DONE guard,
    // catch_unwind, initialize_android_context, mem::forget)
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_MainActivity_nativeInitAndroidContext<'local>(
    env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    context: jni::objects::JObject<'local>,
) {
    init_android_context_guarded(env, context);
}

/// A cold WorkManager process never ran MainActivity.onCreate, so the
/// worker must initialize the ndk-context itself before any Rust
/// networking — otherwise hickory-resolver aborts the process (the v0.4
/// bug, all over again, from a different entry point).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_BackgroundSyncWorker_nativeInitAndroidContext<'local>(
    env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    context: jni::objects::JObject<'local>,
) {
    init_android_context_guarded(env, context);
}
```

- [ ] **Step 3: The headless sync body**

Add to the `live` module (or beside it — it needs `BG_APP`):

```rust
    /// Cold-process sync: no Tauri, no AppHandle. Open the DB, bind the
    /// endpoint from the persisted identity, one pass, tear down. Any
    /// init failure is a logged no-op — never crash the worker process.
    pub fn try_headless_sync(data_dir: &std::path::Path) -> BgSyncOutcome {
        // Safety rule: one identity, one live endpoint. If the app is up
        // (or comes up mid-flight), its endpoint owns the identity — the
        // warm path handles that case.
        if BG_APP.get().is_some() {
            return BgSyncOutcome::NotReady; // caller retries via warm path
        }
        let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(rt) => rt,
            Err(e) => {
                log::warn!("headless sync: runtime build failed: {e}");
                return BgSyncOutcome::NotReady;
            }
        };
        rt.block_on(async {
            let db_path = data_dir.join("klaxon.db");
            let conn = match crate::db::open(&db_path) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("headless sync: db open failed: {e}");
                    return BgSyncOutcome::NotReady;
                }
            };
            let db = std::sync::Arc::new(parking_lot::Mutex::new(conn));
            if !crate::sync::read_enabled(&db) {
                return BgSyncOutcome::Disabled;
            }
            let node = match crate::sync::iroh_node::start(data_dir).await {
                Ok(n) => n,
                Err(e) => {
                    log::warn!("headless sync: endpoint start failed: {e}");
                    return BgSyncOutcome::NotReady;
                }
            };
            let outcome =
                crate::sync::task::run_one_pass_headless(&db, &node.endpoint).await;
            log::info!(
                "headless sync: attempted {} peers, {} failed",
                outcome.attempted,
                outcome.failed,
            );
            node.endpoint.close().await;
            BgSyncOutcome::RanCold
        })
    }
```

- [ ] **Step 4: Rework the worker's JNI entry**

Replace `Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce` — it gains the `dataDir` string and the cold branch, and now needs real JNI types (it previously took opaque pointers):

```rust
/// JNI entry point for the Kotlin `BackgroundSyncWorker`. Warm process →
/// existing in-app pass; cold process → headless pass against the given
/// data dir. `catch_unwind` keeps panics from crossing the FFI boundary.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_BackgroundSyncWorker_nativeSyncOnce<'local>(
    mut env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
    data_dir: jni::objects::JString<'local>,
) -> jni::sys::jint {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        if let outcome @ (BgSyncOutcome::Ran | BgSyncOutcome::Disabled) =
            live::try_background_sync()
        {
            return outcome.code();
        }
        // Warm path said NotReady — the process is cold. Go headless.
        let Ok(dir) = env.get_string(&data_dir) else {
            return -1;
        };
        let dir: String = dir.into();
        live::try_headless_sync(std::path::Path::new(&dir)).code()
    }))
    .unwrap_or(-1)
}
```

- [ ] **Step 5: Verify on the host, then compile for Android**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result"` — 81 passing (the enum test grew but stays one test).
Run (Android env from Global Constraints): `npm run tauri android build -- --apk --target aarch64` — this is the only check that compiles the JNI code.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/mobile_bg.rs
git commit -m "feat(sync): cold-capable background sync — headless pass over JNI"
```

---

### Task 3: Kotlin — worker init + dataDir, share-triggered expedited job

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/ShareActivity.kt`

- [ ] **Step 1: Worker passes context + dataDir**

In `BackgroundSyncWorker.kt`:

```kotlin
    private external fun nativeInitAndroidContext(context: Context)
    private external fun nativeSyncOnce(dataDir: String): Int

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val outcome = try {
            // A cold process never ran MainActivity.onCreate, so the
            // ndk-context (needed by iroh's DNS) must be initialized here.
            // Guarded native-side: a second init is a no-op.
            nativeInitAndroidContext(applicationContext)
            nativeSyncOnce(applicationContext.dataDir.absolutePath)
        } catch (t: Throwable) {
            Log.w(TAG, "background sync threw", t)
            -1
        }
        Log.i(TAG, "background sync outcome=$outcome")
        // Always success: periodic jobs rely on the next period, and the
        // expedited one-shot from ShareActivity gets its retry from the
        // next write or foreground instead of WorkManager backoff.
        Result.success()
    }
```

Update the class doc comment: outcome codes now include `3 = RanCold`.

- [ ] **Step 2: ShareActivity enqueues the expedited job**

In `ShareActivity.kt`, after a successful save (`code == 0`), before `finish()`:

```kotlin
    if (code == 0) {
      // The thought is in SQLite, but this process has no sync engine and
      // the app may be cold. An expedited one-shot of the sync worker
      // pushes it out within seconds-to-minutes instead of waiting for
      // the app to next open.
      try {
        val req = OneTimeWorkRequestBuilder<BackgroundSyncWorker>()
          .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
          )
          .build()
        WorkManager.getInstance(applicationContext)
          .enqueueUniqueWork("klaxon-share-sync", ExistingWorkPolicy.REPLACE, req)
      } catch (t: Throwable) {
        // Sync will happen on next app open instead — never block the share.
      }
    }
```

with imports:

```kotlin
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
```

- [ ] **Step 3: Build and install**

```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npm run tauri android build -- --apk --target aarch64
"$ANDROID_HOME/platform-tools/adb" install -r \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

Expected: `Success` (release-signed, in-place upgrade).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/klaxon/app/BackgroundSyncWorker.kt \
        src-tauri/gen/android/app/src/main/java/com/klaxon/app/ShareActivity.kt
git commit -m "feat(sync): worker cold init + share-triggered expedited sync"
```

---

### Task 4: On-device verification

The cold path can only be proven on hardware. The share-triggered job doubles as the test rig — it exercises the entire cold chain without waiting ~25 min for the periodic slot.

**Files:** none (plus CHANGELOG at the end).

- [ ] **Step 1: Arm the log watch**

```bash
"$ANDROID_HOME/platform-tools/adb" logcat -c
"$ANDROID_HOME/platform-tools/adb" logcat | grep -iE "background sync outcome|headless sync|klaxon.*FATAL|UnsatisfiedLink"
```

- [ ] **Step 2: The cold share test**

1. **Force-stop Klaxon** on the phone (Settings → Apps → Klaxon → Force stop). Genuinely cold — no cached process.
2. Desktop Klaxon running and on the same Wi-Fi.
3. Share a link from Chrome → "Saved to Klaxon" toast, Chrome stays foreground.
4. Watch logcat: `background sync outcome=3` (RanCold) and `headless sync: attempted 1 peers, 0 failed`.
5. The shared thought appears on the **desktop** within ~a minute, with Klaxon never opened on the phone. That line is the whole milestone.

- [ ] **Step 3: Warm-path regression**

Open Klaxon on the phone, share another link → logcat shows outcome `2` (Ran, warm path) — the cold machinery must not have broken the warm one.

- [ ] **Step 4: Periodic cold catch-up (patience test, optional now)**

Force-stop Klaxon, create a reminder on the desktop, leave the phone plugged in and screen off. Within ~25–40 min the periodic slot fires cold; afterwards, opening Klaxon on the phone shows the reminder immediately (it synced before you opened it). This validates the spec's ~20 min target loosely; log line `outcome=3` timestamps it precisely.

- [ ] **Step 5: Changelog + commit**

Extend the Unreleased 0.5.1 section: cold-capable background sync + share-triggered sync, and the named non-goal (alarms still arm on next foreground).

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for sync reliability M2"
```
