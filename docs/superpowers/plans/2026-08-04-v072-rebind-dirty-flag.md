# v0.7.2 Rebind + Dirty-Flag Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync recovers from network migrations without an app restart (#3), and the vestigial dirty flag is retired with mesh-forwarding semantics pinned by test (#2).

**Architecture:** Detectors (Windows `NotifyIpInterfaceChange`, Android `ConnectivityManager` callback) only send a new `Nudge::NetworkChange`; the sync loop reacts by calling iroh's sanctioned `endpoint.network_change()` before the pass — which also upgrades the existing wake-from-sleep `Resume` nudge for free. The dirty flag is proven inert by a three-database mesh test, then removed (writes → structs → indexes → migration 013 column drops).

**Tech Stack:** Rust (windows crate iphlpapi callback, tokio), Kotlin (ConnectivityManager + JNI), rusqlite migration, iroh 1.0.3 `Endpoint::network_change()`.

## Global Constraints

- Detector callbacks run on bare OS threads: they may ONLY send on the nudge channel (the `power.rs` `OnceLock<UnboundedSender<Nudge>>` pattern) — never touch app state.
- `endpoint.network_change()` is called from the sync loop only; documented safe to over-call; never on the cold path (fresh endpoints there).
- Registration failures are logged, never fatal.
- Mesh test lands and passes BEFORE any dirty-flag removal.
- Wire format untouched; no coordination with 0.7.1 peers required.
- Zero cargo warnings; svelte-check stays 0/0. Branch: `feat/v0.7.2` off main.

---

### Task 1: Three-database mesh-forwarding test

**Files:**
- Modify: `src-tauri/src/sync/ops.rs` (append to its `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::db::open`, `db::{reminders,thoughts,task_lanes,tombstones}` creation fns, `ops::pull(db, since)`, `ops::push(db, None, changeset)`.
- Produces: the regression net for Task 2.

- [ ] **Step 1: Write the test** (temp-file DBs, same pattern as `share.rs` tests):

```rust
    /// Issue #2's design guarantee: forwarding is carried entirely by
    /// updated_at/deleted_at watermarks — a change that arrives FROM a
    /// peer (which lands with dirty = 0 today) must forward onward to a
    /// third device unchanged. A→B→C through the real pull/push ops.
    #[test]
    fn changes_forward_across_three_devices_via_watermarks() {
        let (da, db_, dc) = (temp_db(), temp_db(), temp_db());
        let a = Arc::new(Mutex::new(crate::db::open(&da).unwrap()));
        let b = Arc::new(Mutex::new(crate::db::open(&db_).unwrap()));
        let c = Arc::new(Mutex::new(crate::db::open(&dc).unwrap()));

        // Local writes on A: a reminder, a thought, a lane, and a delete.
        let (rid, doomed_id, lane_id, thought_id) = {
            let conn = a.lock();
            let r = crate::db::reminders::create(
                &conn,
                crate::models::ReminderCreate {
                    title: "travels the mesh".into(),
                    ..Default::default()
                },
            )
            .unwrap();
            let doomed = crate::db::reminders::create(
                &conn,
                crate::models::ReminderCreate { title: "doomed".into(), ..Default::default() },
            )
            .unwrap();
            crate::db::reminders::delete(&conn, &doomed.id).unwrap(); // writes tombstone
            let lane = crate::db::task_lanes::create(&conn, "mesh lane").unwrap();
            let t = crate::db::thoughts::create(
                &conn,
                crate::models::ThoughtCreate { body: "an idea".into(), tags: vec![] },
            )
            .unwrap();
            (r.id, doomed.id, lane.id, t.id)
        };

        // Hop 1: B ingests A's full state (what task.rs does with a pull).
        let hop1 = pull(&a, 0).unwrap();
        push(&b, None, hop1).unwrap();

        // Hop 2: C ingests from B. If any table's selection still
        // consulted `dirty`, the rows B received (dirty = 0) would be
        // invisible here — the exact issue-#1 failure mode.
        let hop2 = pull(&b, 0).unwrap();
        assert_eq!(hop2.reminders.len(), 1, "forwarded reminder present in B's pull");
        assert_eq!(hop2.tombstones.len(), 1);
        assert_eq!(hop2.lanes.len(), 2, "default lane + mesh lane");
        assert_eq!(hop2.thoughts.len(), 1);
        push(&c, None, hop2).unwrap();

        {
            let conn = c.lock();
            let got = crate::db::reminders::get_by_id(&conn, &rid).unwrap();
            assert_eq!(got.title, "travels the mesh");
            assert!(crate::db::reminders::get_by_id(&conn, &doomed_id).is_err(), "tombstone applied");
            assert!(crate::db::task_lanes::list_all(&conn).unwrap().iter().any(|l| l.id == lane_id));
            assert_eq!(crate::db::thoughts::get_by_id(&conn, &thought_id).unwrap().body, "an idea");
        }
        for p in [da, db_, dc] {
            std::fs::remove_file(p).ok();
        }
    }
```

Add a `temp_db()` helper mirroring `share.rs` if ops.rs tests lack one. Adjust creation-fn signatures to the real ones (read them first — e.g. `task_lanes::create(&conn, name)` and `ReminderCreate::default()` availability; if `ReminderCreate` has no `Default`, construct it fully with `due_at: now + 60_000`, `priority: Normal`, `silent: false`, rest `None`/empty).

- [ ] **Step 2:** `cargo test changes_forward` → PASS (this documents today's behavior; it must pass BEFORE retirement starts). If it fails, STOP — issue #1's fix has a gap; investigate before touching the flag.

- [ ] **Step 3: Commit** — `git add src-tauri/src/sync/ops.rs && git commit -m "test(sync): three-device mesh forwarding pinned to watermark semantics"`

---

### Task 2: Retire the dirty flag + migration 013

**Files:**
- Modify: `src-tauri/src/db/{reminders,thoughts,task_lanes,tombstones}.rs` (drop field from structs, row mappers, all SQL), `src-tauri/src/db/migrations.rs` (013), `src-tauri/src/models.rs` (if `dirty` lives on the model structs), `src-tauri/src/share.rs` (test assertion), `src/lib/types.ts` + any frontend reads of `dirty` (grep first)

- [ ] **Step 1: Exhaustive inventory** — `grep -rn "dirty" src-tauri/src src/` and list every hit. Categories expected: struct fields, row mappers, INSERT/UPDATE column lists, `dirty = 1`/`dirty = 0` sets, partial indexes in old migrations (LEAVE those — migrations are append-only history), the share.rs test, possibly TS types. Anything OUTSIDE those categories: stop and reassess before proceeding.

- [ ] **Step 2: Remove writes + fields.** Drop `dirty` from the four Rust structs and every SELECT/INSERT/UPDATE. The share.rs test assertion `assert!(got.dirty, ...)` becomes an updated_at freshness check:

```rust
        assert!(got.updated_at > 0, "updated_at set — the watermark sync selects on");
```

Frontend: remove `dirty` from TS types if present (grep `dirty` in `src/`); no UI reads it (verify).

- [ ] **Step 3: Migration 013** — append:

```rust
    // 013 — v0.7.2: the dirty flag is vestigial. Since the issue-#1 fix,
    // every synced table is selected by updated_at/deleted_at against
    // per-peer cursors — which IS the per-peer forwarding state (#2).
    // Dropping the columns also drops the idx_*_dirty partial indexes.
    r#"
    ALTER TABLE reminders  DROP COLUMN dirty;
    ALTER TABLE thoughts   DROP COLUMN dirty;
    ALTER TABLE task_lanes DROP COLUMN dirty;
    ALTER TABLE tombstones DROP COLUMN dirty;
    "#,
```

Note: SQLite auto-drops indexes that reference a dropped column? It does NOT — `DROP COLUMN` fails with "error in index ... after drop column" if a partial index references it. So the migration must `DROP INDEX` first:

```rust
    r#"
    DROP INDEX IF EXISTS idx_reminders_dirty;
    DROP INDEX IF EXISTS idx_thoughts_dirty;
    DROP INDEX IF EXISTS idx_task_lanes_dirty;
    DROP INDEX IF EXISTS idx_tombstones_dirty;
    ALTER TABLE reminders  DROP COLUMN dirty;
    ALTER TABLE thoughts   DROP COLUMN dirty;
    ALTER TABLE task_lanes DROP COLUMN dirty;
    ALTER TABLE tombstones DROP COLUMN dirty;
    "#,
```

(Check the actual index names in migration 001/005/008 text first — use exactly those.)

- [ ] **Step 4:** `cargo test` — full suite green including the Task 1 mesh test, zero warnings. The migration test harness exercises 013 on a fresh DB; also verify an EXISTING db upgrades: `cargo test migrations` (the suite's forward-migration coverage).

- [ ] **Step 5: Commit** — `git commit -m "feat(db): retire the dirty flag — watermarks are the forwarding state (closes #2, migration 013)"`

---

### Task 3: `Nudge::NetworkChange` + loop reaction

**Files:**
- Modify: `src-tauri/src/sync/trigger.rs` (variant), `src-tauri/src/sync/task.rs` (react in the select loop)

**Interfaces:**
- Produces: `Nudge::NetworkChange` (sent by Tasks 4–5); loop behavior: on `Resume | NetworkChange`, `endpoint.network_change().await` runs before the pass.

- [ ] **Step 1:** Add variant to `trigger.rs`:

```rust
    /// v0.7.2: OS reported an interface/connectivity change. The loop
    /// tells iroh to re-evaluate sockets and paths before dialing.
    NetworkChange,
```

- [ ] **Step 2:** In `task.rs`, find where the received nudge is consumed in the `select!` loop (the debounced batch). Before running the pass for a batch containing `Resume` or `NetworkChange` (Resume gets it too — sleep usually means the network moved):

```rust
                if nudges.iter().any(|n| matches!(n, Nudge::Resume | Nudge::NetworkChange)) {
                    log::info!("network-change/resume — notifying iroh endpoint");
                    endpoint.network_change().await;
                }
```

Adapt to the loop's actual shape (single nudge vs drained batch — read the code; if single, match on it). If `next_retry_delay`/logging matches exhaustively on Nudge, extend those arms.

- [ ] **Step 3:** `cargo test` green, zero warnings (desktop build compiles the loop; no behavioral test — the drill covers it). Commit: `feat(sync): NetworkChange nudge — loop tells iroh before dialing`

---

### Task 4: Windows interface watcher

**Files:**
- Create: `src-tauri/src/net_watch.rs`
- Modify: `src-tauri/src/lib.rs` (`mod net_watch;` + spawn next to `power::spawn_power_watcher`), `src-tauri/Cargo.toml` (windows features)

**Interfaces:**
- Consumes: `Nudge::NetworkChange` (Task 3), the `UnboundedSender<Nudge>` clone available at setup.

- [ ] **Step 1:** Cargo.toml — extend the `windows` dependency features with `"Win32_NetworkManagement_IpHelper"`, `"Win32_NetworkManagement_Ndis"`, `"Win32_Networking_WinSock"` (keep existing ones).

- [ ] **Step 2:** `net_watch.rs`:

```rust
//! Windows network-interface change notifications → sync nudges.
//!
//! Field evidence (issue #3): after a Wi-Fi migration the iroh endpoint
//! stayed bound to the dead network for hours. iroh can't always see
//! interface changes itself on Windows; `NotifyIpInterfaceChange` can.
//! The callback runs on an OS thread pool thread — it must only signal.
//! Same OnceLock pattern as `power.rs`.

#![cfg(target_os = "windows")]

use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{BOOLEAN, HANDLE};
use windows::Win32::NetworkManagement::IpHelper::{
    NotifyIpInterfaceChange, MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE,
};
use windows::Win32::Networking::WinSock::AF_UNSPEC;

use crate::sync::trigger::Nudge;

static NUDGE: std::sync::OnceLock<UnboundedSender<Nudge>> = std::sync::OnceLock::new();

unsafe extern "system" fn on_change(
    _ctx: *const core::ffi::c_void,
    _row: *const MIB_IPINTERFACE_ROW,
    _kind: MIB_NOTIFICATION_TYPE,
) {
    // Bursts are expected (one event per family per interface); the
    // nudge channel's 1.5s debounce coalesces them into one pass.
    if let Some(tx) = NUDGE.get() {
        let _ = tx.send(Nudge::NetworkChange);
    }
}

/// Register for interface-change callbacks. Failure is logged and
/// non-fatal — behavior degrades to pre-v0.7.2 (restart to recover).
pub fn spawn_net_watcher(nudge: UnboundedSender<Nudge>) {
    let _ = NUDGE.set(nudge);
    let mut handle = HANDLE::default();
    // initial_notification = false: we only want actual changes.
    let ret = unsafe {
        NotifyIpInterfaceChange(
            AF_UNSPEC,
            Some(on_change),
            None,
            BOOLEAN(0),
            &mut handle,
        )
    };
    if ret.is_err() {
        log::warn!("net watcher: NotifyIpInterfaceChange failed: {ret:?}");
    } else {
        log::info!("net watcher: interface-change notifications registered");
        // Handle intentionally leaked — notifications live for the
        // process lifetime, same as the power watcher's window.
        std::mem::forget(handle);
    }
}
```

Adjust exact windows-crate types to what 0.62 exposes (`NotifyIpInterfaceChange` signature may take `ADDRESS_FAMILY` and return `WIN32_ERROR` — compile and adapt; the semantic content above is fixed).

- [ ] **Step 3:** lib.rs — `mod net_watch;` (cfg windows) and directly after `power::spawn_power_watcher(nudge_tx.clone());`:

```rust
            #[cfg(target_os = "windows")]
            net_watch::spawn_net_watcher(nudge_tx.clone());
```

- [ ] **Step 4:** `cargo check` + `cargo test` green, zero warnings. Manual smoke on the dev box: run `cargo run`, toggle Wi-Fi off/on, expect the "network-change/resume — notifying iroh endpoint" log line within ~2 s. Commit: `feat(sync): Windows interface-change watcher (issue #3)`

---

### Task 5: Android connectivity callback

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/MainActivity.kt` (register callback + external fun), `src-tauri/src/mobile_bg.rs` (JNI export)

- [ ] **Step 1: Kotlin** — read MainActivity.kt first; following its existing style, add inside the class:

```kotlin
  private external fun nativeNetworkChanged()

  private fun registerNetworkCallback() {
    try {
      val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
          Log.i("Klaxon", "network available — notifying Rust")
          runCatching { nativeNetworkChanged() }
        }
        override fun onLost(network: Network) {
          Log.i("Klaxon", "network lost — notifying Rust")
          runCatching { nativeNetworkChanged() }
        }
      })
    } catch (t: Throwable) {
      Log.w("Klaxon", "network callback registration failed", t)
    }
  }
```

Call `registerNetworkCallback()` from `onCreate` after the existing native init. Imports: `android.content.Context`, `android.net.ConnectivityManager`, `android.net.Network`, `android.util.Log`.

- [ ] **Step 2: JNI export** in `mobile_bg.rs`, next to the other MainActivity exports:

```rust
/// v0.7.2 (issue #3): ConnectivityManager callback → nudge. Android
/// never exposes network changes to native code (iroh's docs call this
/// out explicitly), so Kotlin forwards them. Warm-only by design: the
/// cold worker builds a fresh endpoint per pass and never needs this.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_klaxon_app_MainActivity_nativeNetworkChanged<'local>(
    _env: jni::JNIEnv<'local>,
    _this: jni::objects::JObject<'local>,
) {
    ensure_android_logging();
    let _ = std::panic::catch_unwind(|| {
        let Some(app) = live::app_handle() else {
            log::debug!("network change before setup — ignored");
            return;
        };
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let _ = state.sync_nudge.send(crate::sync::trigger::Nudge::NetworkChange);
    });
}
```

`live::app_handle()` may not exist — the module has `BG_APP` private + `app_is_live()`. Add to the `live` module:

```rust
    /// Clone of the live handle for JNI entry points that need state.
    pub fn app_handle() -> Option<AppHandle> {
        BG_APP.get().cloned()
    }
```

- [ ] **Step 3:** Android build compiles (`npm run tauri android build -- --apk --target aarch64 --verbose`, BUILD SUCCESSFUL) + string-verify `nativeNetworkChanged` in the dex and `network-change` in the .so. Commit: `feat(sync): Android connectivity callback → NetworkChange nudge`

---

### Task 6: Release v0.7.2 + drills

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`

- [ ] **Step 1:** Versions → 0.7.2; changelog entry: rebind fix (#3), dirty-flag retirement (#2, migration 013), markdown release notes (from `b5c4392`). Full gate: `cargo test` (≥110, zero warnings), svelte-check 0/0, `npm run build`.

- [ ] **Step 2:** Merge `feat/v0.7.2` → main `--no-ff`; build NSIS + APK; string-verify APK (`nativeNetworkChanged` in dex, `network-change` in .so); tag `v0.7.2`; push; `gh release create` with `klaxon-0.7.2-arm64.apk` + `Klaxon_0.7.2_x64-setup.exe`. Release notes exercise the new markdown rendering — write them WITH headings/bold/bullets.

- [ ] **Step 3: Self-update drills** — both devices update in-app from 0.7.1. Confirm the update panel now renders the notes as formatted markdown (user checks visually) and the what's-new card appears on BOTH platforms this time (both have the seed marker now).

- [ ] **Step 4: THE REBIND DRILL (release gate for #3):** both devices running and synced on v0.7.2 → move the laptop to a different network (phone hotspot) → create a reminder on the laptop → without restarting anything, it must reach the phone within ~2 minutes. Then hop back to the original network and confirm recovery again. Watch for the "network-change/resume — notifying iroh endpoint" log line.

- [ ] **Step 5:** Close #2 and #3 with evidence comments; update memory; mark tasks complete.

## Self-review notes

- Spec coverage: detection (Tasks 4–5), shared reaction incl. wake-for-free (Task 3), cold-path immunity (no task needed — by construction, noted in Task 5 comment), mesh test first (Task 1 ordering + STOP clause), retirement + 013 with index-drop ordering (Task 2), markdown rider + drills (Task 6).
- Type consistency: `Nudge::NetworkChange` used by Tasks 3/4/5; `live::app_handle() -> Option<AppHandle>` defined where used; migration index names flagged verify-first.
- Honest soft spots marked in-plan: exact windows-crate 0.62 signatures, task.rs loop shape (single vs batch nudge), MainActivity.kt current structure, `ReminderCreate` Default availability — each carries a read-first instruction.
