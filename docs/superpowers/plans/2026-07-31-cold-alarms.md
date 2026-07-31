# Cold Alarm Arming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminders that arrive via cold sync ring on time — arming moves out of the webview into one native path used by foreground, warm background, and cold background alike. Spec: `docs/superpowers/specs/2026-07-31-cold-alarms-design.md`.

**Architecture:** A pure Rust planner (`alarm_plan.rs`) decides what should be armed — bit-exact parity with the JS hash it replaces, grace-window and ring-once policy included. A thin Kotlin `NotificationReconciler` executes the plan through the vendored plugin's own `TauriNotificationManager`/`NotificationStorage`, whose receiver already fires cold. `os_alarms.rs` bridges them over classloader-JNI and is called from three places. The JS reconcile is deleted.

**Tech Stack:** Rust (chrono Local for due-lines), Kotlin (plugin classes + NotificationManagerCompat), JNI, jackson-less manual JSON parse in Kotlin (org.json, already on Android).

## Global Constraints

- Baseline on `main`: **93 tests, 0 warnings**; svelte-check 0 errors (7 pre-existing warnings). CI enforces on push.
- **Migration number 011.**
- **Hash parity is sacred.** Captured vectors from the live JS implementation (node, exact source of `hashIdToInt32`):
  - `"00000000-0000-4000-8000-000000000001"` → `1887187000`
  - `"a3f8c2d1-9b4e-4c7a-8d2f-1e5b6a9c0d3e"` → `1885464322`
  - `"ee5a9ef7-79cb-494a-9739-721cd03f6b22"` → `2117013459`
  - `""` → `5381`
  - `"z"` → `177631`
- Grace window: `GRACE_WINDOW_MS = 30 * 60 * 1000`, named constant.
- Past-due entries are scheduled at `now + 2s` (`allowWhileIdle`), not posted directly — one Kotlin code path through the existing `ScheduledNotificationReceiver`.
- The armed log is written **only after** Kotlin returns success (spec §5).
- Desktop untouched; everything JNI/Kotlin is `#[cfg(target_os = "android")]`; the planner and armed-log modules compile and test on the host.
- Android env: `JAVA_HOME` = Android Studio jbr, `NDK_HOME=$ANDROID_HOME/ndk/27.1.12297006`.
- Body/due-line formatting uses **local time** (the JS used `Date` getters) — `chrono::Local`.

---

### Task 1: The planner — `alarm_plan.rs`

**Files:**
- Create: `src-tauri/src/alarm_plan.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration: `pub mod alarm_plan;`)

**Interfaces:**
- Produces:
  - `pub struct PlannedNotification { pub id_hash: i32, pub reminder_id: String, pub title: String, pub body: String, pub channel_id: String, pub at_ms: i64, pub past_due: bool }` (derives `Serialize`)
  - `pub fn hash_id_to_int32(id: &str) -> i32`
  - `pub fn desired_notifications(reminders: &[Reminder], armed: &HashSet<(String, i64)>, now_ms: i64) -> Vec<PlannedNotification>`
  - `pub const GRACE_WINDOW_MS: i64`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/alarm_plan.rs` with the module doc and tests:

```rust
//! The alarm planner: decides which OS notifications should exist, as a
//! pure function of the reminders table. Replaces the reconcile logic
//! that lived in mobile-scheduler.ts — the hash, body format, and
//! channel mapping here MUST stay bit/byte-identical to what the JS
//! produced, or upgrading double-schedules every armed alarm.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Priority, Reminder, ReminderState};

    fn reminder(id: &str, state: ReminderState, due: i64, snooze: Option<i64>) -> Reminder {
        Reminder {
            id: id.into(),
            title: "Test".into(),
            description: None,
            due_at: due,
            priority: Priority::Normal,
            sound_path: None,
            repeat_rule: None,
            state,
            snooze_until: snooze,
            created_at: 0,
            updated_at: 0,
            source: "local".into(),
            external_id: None,
            last_synced_at: None,
            dirty: false,
            silent: false,
            tags: vec![],
            task_lane_id: None,
        }
    }

    /// Captured from the running JS implementation — bit-exact or bust.
    #[test]
    fn hash_matches_js_bit_for_bit() {
        assert_eq!(hash_id_to_int32("00000000-0000-4000-8000-000000000001"), 1887187000);
        assert_eq!(hash_id_to_int32("a3f8c2d1-9b4e-4c7a-8d2f-1e5b6a9c0d3e"), 1885464322);
        assert_eq!(hash_id_to_int32("ee5a9ef7-79cb-494a-9739-721cd03f6b22"), 2117013459);
        assert_eq!(hash_id_to_int32(""), 5381);
        assert_eq!(hash_id_to_int32("z"), 177631);
    }

    #[test]
    fn future_pending_and_snoozed_are_armed_terminal_states_are_not() {
        let now = 1_000_000;
        let rs = vec![
            reminder("a", ReminderState::Pending, now + 60_000, None),
            reminder("b", ReminderState::Snoozed, now + 60_000, Some(now + 120_000)),
            reminder("c", ReminderState::Completed, now + 60_000, None),
            reminder("d", ReminderState::Dismissed, now + 60_000, None),
            reminder("e", ReminderState::Fired, now + 60_000, None),
        ];
        let plan = desired_notifications(&rs, &Default::default(), now);
        let ids: Vec<&str> = plan.iter().map(|p| p.reminder_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b"]);
        // Snooze wins over due_at as the fire time.
        assert_eq!(plan[1].at_ms, now + 120_000);
    }

    #[test]
    fn grace_window_edges() {
        let now = 100_000_000;
        let rs = vec![
            reminder("young", ReminderState::Pending, now - 29 * 60_000, None),
            reminder("stale", ReminderState::Pending, now - 31 * 60_000, None),
        ];
        let plan = desired_notifications(&rs, &Default::default(), now);
        assert_eq!(plan.len(), 1, "29min late rings, 31min late doesn't");
        assert_eq!(plan[0].reminder_id, "young");
        assert!(plan[0].past_due);
    }

    #[test]
    fn ring_once_via_armed_log() {
        let now = 100_000_000;
        let due = now - 60_000;
        let rs = vec![reminder("x", ReminderState::Pending, due, None)];

        let first = desired_notifications(&rs, &Default::default(), now);
        assert_eq!(first.len(), 1, "first sight of a late reminder rings");

        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        let second = desired_notifications(&rs, &armed, now);
        assert!(second.is_empty(), "already-armed pair must not re-ring");
    }

    #[test]
    fn snooze_moves_fire_time_and_rings_again() {
        let now = 100_000_000;
        let due = now - 60_000;
        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        // Snoozed to a new (past) fire time — a new pair, within grace.
        let rs = vec![reminder("x", ReminderState::Snoozed, due, Some(now - 10_000))];
        let plan = desired_notifications(&rs, &armed, now);
        assert_eq!(plan.len(), 1, "new fire time = new ring");
        assert_eq!(plan[0].at_ms, now - 10_000);
    }

    #[test]
    fn future_arming_is_not_blocked_by_armed_log() {
        // The log exists to stop past-due re-rings; a future-due reminder
        // must keep re-scheduling idempotently even when logged.
        let now = 1_000_000;
        let due = now + 60_000;
        let mut armed = std::collections::HashSet::new();
        armed.insert(("x".to_string(), due));
        let rs = vec![reminder("x", ReminderState::Pending, due, None)];
        assert_eq!(desired_notifications(&rs, &armed, now).len(), 1);
    }

    #[test]
    fn silent_tasks_never_ring() {
        let now = 1_000_000;
        let mut r = reminder("t", ReminderState::Pending, now + 60_000, None);
        r.silent = true;
        assert!(desired_notifications(&[r], &Default::default(), now).is_empty());
    }

    #[test]
    fn body_carries_description_due_line_and_priority() {
        let now = 1_000_000;
        let mut r = reminder("a", ReminderState::Pending, now + 60_000, None);
        r.description = Some("bring the charger".into());
        let plan = desired_notifications(&[r], &Default::default(), now);
        let body = &plan[0].body;
        assert!(body.starts_with("bring the charger\n"));
        assert!(body.contains("(NORMAL)"));
        assert!(body.contains("Due "), "due line present: {body}");
    }
}
```

- [ ] **Step 2: Register the module, confirm failure**

`pub mod alarm_plan;` in `lib.rs` (alphabetical, after `pub mod backup;`). Run `cd src-tauri && cargo test alarm_plan` — FAIL.

- [ ] **Step 3: Implement**

```rust
use std::collections::HashSet;

use serde::Serialize;

use crate::models::{Priority, Reminder, ReminderState};

/// How late an arriving reminder may be and still ring immediately.
/// Older than this stays silent (visible as overdue in-app) — a re-pair
/// or week-offline catch-up must not detonate a pile of stale alarms.
pub const GRACE_WINDOW_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct PlannedNotification {
    pub id_hash: i32,
    pub reminder_id: String,
    pub title: String,
    pub body: String,
    pub channel_id: String,
    pub at_ms: i64,
    pub past_due: bool,
}

/// Bit-exact port of mobile-scheduler.ts `hashIdToInt32` (djb2-xor with
/// JS 32-bit semantics). A differing hash double-schedules every alarm
/// armed by the previous version — captured-vector tested.
pub fn hash_id_to_int32(id: &str) -> i32 {
    let mut h: i32 = 5381;
    // JS charCodeAt yields UTF-16 code units; ids are ASCII UUIDs, but
    // encode_utf16 keeps parity exact for any input.
    for c in id.encode_utf16() {
        h = (h.wrapping_shl(5).wrapping_add(h)) ^ (c as i32);
    }
    h.wrapping_abs()
}

fn fire_target_ms(r: &Reminder) -> Option<i64> {
    match r.state {
        ReminderState::Pending | ReminderState::Snoozed => {
            Some(r.snooze_until.unwrap_or(r.due_at))
        }
        _ => None,
    }
}

fn channel_id_for(p: Priority) -> &'static str {
    match p {
        Priority::Low => "klaxon-low",
        Priority::Normal => "klaxon-normal",
        Priority::High => "klaxon-high",
    }
}

/// Port of formatDueLine — local time, same wording, same branches.
fn format_due_line(target_ms: i64, now_ms: i64) -> String {
    use chrono::{Datelike, Local, TimeZone, Timelike};
    let t = Local.timestamp_millis_opt(target_ms).unwrap();
    let now = Local.timestamp_millis_opt(now_ms).unwrap();
    let day = |d: &chrono::DateTime<Local>| d.date_naive();
    let diff_days = (day(&t) - day(&now)).num_days();
    let hhmm = format!("{:02}:{:02}", t.hour(), t.minute());
    const MONTHS: [&str; 12] = [
        "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
        "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
    ];
    match diff_days {
        0 => format!("Due today {hhmm}"),
        1 => format!("Due tomorrow {hhmm}"),
        -1 => format!("Was due yesterday {hhmm}"),
        _ => format!(
            "Due {} {:02} {hhmm}",
            MONTHS[t.month0() as usize],
            t.day()
        ),
    }
}

fn priority_tag(p: Priority) -> &'static str {
    match p {
        Priority::Low => "LOW",
        Priority::Normal => "NORMAL",
        Priority::High => "HIGH",
    }
}

fn build_body(r: &Reminder, target_ms: i64, now_ms: i64) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(d) = &r.description {
        lines.push(d.clone());
    }
    lines.push(format!(
        "{} ({})",
        format_due_line(target_ms, now_ms),
        priority_tag(r.priority)
    ));
    lines.join("\n")
}

/// The plan: which OS notifications should exist right now.
///
/// - Future fire time → include (same-id re-schedule is idempotent).
/// - Past fire time → include only within [`GRACE_WINDOW_MS`] AND when
///   the (reminder, fire time) pair isn't in the armed log — ring once.
/// - Silent tasks and terminal states never ring.
pub fn desired_notifications(
    reminders: &[Reminder],
    armed: &HashSet<(String, i64)>,
    now_ms: i64,
) -> Vec<PlannedNotification> {
    let mut out = Vec::new();
    for r in reminders {
        if r.silent {
            continue;
        }
        let Some(t) = fire_target_ms(r) else { continue };
        let past_due = t <= now_ms;
        if past_due {
            let age = now_ms - t;
            if age > GRACE_WINDOW_MS {
                continue;
            }
            if armed.contains(&(r.id.clone(), t)) {
                continue;
            }
        }
        out.push(PlannedNotification {
            id_hash: hash_id_to_int32(&r.id),
            reminder_id: r.id.clone(),
            title: r.title.clone(),
            body: build_body(r, t, now_ms),
            channel_id: channel_id_for(r.priority).to_string(),
            at_ms: t,
            past_due,
        });
    }
    out
}
```

- [ ] **Step 4: Verify and commit**

Run: `cd src-tauri && cargo test alarm_plan` — 8 PASS; full suite 101; warnings 0.

```bash
git add src-tauri/src/alarm_plan.rs src-tauri/src/lib.rs
git commit -m "feat(alarms): pure planner with bit-exact JS hash parity"
```

---

### Task 2: Migration 011 + the armed log

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (migration + test)
- Create: `src-tauri/src/db/armed_alarms.rs`
- Modify: `src-tauri/src/db/mod.rs`

**Interfaces:**
- Produces:
  - `pub fn armed_set(conn) -> AppResult<HashSet<(String, i64)>>`
  - `pub fn log_armed(conn, pairs: &[(String, i64)], now: i64) -> AppResult<()>`
  - `pub fn prune(conn, live: &HashSet<(String, i64)>) -> AppResult<()>` — deletes rows not in `live`

- [ ] **Step 1: Migration**

Append to `MIGRATIONS`:

```rust
    // 011 — cold alarms (v0.6): ring-once memory for late arrivals.
    //
    // "Ring if recently due" is the first arming rule that isn't
    // naturally idempotent — an immediately-firing entry would re-fire
    // on every reconcile. This table remembers (reminder, fire time)
    // pairs this device has armed. Deliberately DEVICE-LOCAL and never
    // synced: whether this phone rang is not shared state.
    r#"
    CREATE TABLE armed_alarms (
        reminder_id TEXT NOT NULL,
        fire_at_ms  INTEGER NOT NULL,
        armed_at    INTEGER NOT NULL,
        PRIMARY KEY (reminder_id, fire_at_ms)
    );
    "#,
```

- [ ] **Step 2: The module, test-first**

`src-tauri/src/db/armed_alarms.rs`:

```rust
//! Ring-once memory for the alarm planner. Device-local; never synced.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::error::AppResult;

pub fn armed_set(conn: &Connection) -> AppResult<HashSet<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT reminder_id, fire_at_ms FROM armed_alarms")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r?);
    }
    Ok(out)
}

pub fn log_armed(conn: &Connection, pairs: &[(String, i64)], now: i64) -> AppResult<()> {
    for (id, at) in pairs {
        conn.execute(
            "INSERT OR IGNORE INTO armed_alarms (reminder_id, fire_at_ms, armed_at)
             VALUES (?1, ?2, ?3)",
            params![id, at, now],
        )?;
    }
    Ok(())
}

/// Drop rows whose (reminder, fire time) is no longer live — the
/// reminder is gone, or its fire time moved (snooze/recurrence).
pub fn prune(conn: &Connection, live: &HashSet<(String, i64)>) -> AppResult<()> {
    let existing = armed_set(conn)?;
    for (id, at) in existing.difference(live) {
        conn.execute(
            "DELETE FROM armed_alarms WHERE reminder_id = ?1 AND fire_at_ms = ?2",
            params![id, at],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn log_read_prune_roundtrip() {
        let conn = test_conn();
        log_armed(&conn, &[("a".into(), 100), ("b".into(), 200)], 1).unwrap();
        // Double-log is a no-op, not an error.
        log_armed(&conn, &[("a".into(), 100)], 2).unwrap();
        assert_eq!(armed_set(&conn).unwrap().len(), 2);

        let mut live = std::collections::HashSet::new();
        live.insert(("a".to_string(), 100i64));
        prune(&conn, &live).unwrap();
        let left = armed_set(&conn).unwrap();
        assert_eq!(left.len(), 1);
        assert!(left.contains(&("a".to_string(), 100)));
    }
}
```

Register `pub mod armed_alarms;` in `db/mod.rs`.

- [ ] **Step 3: Verify and commit**

`cargo test` — 102 passing (101 + 1), 0 warnings.

```bash
git add src-tauri/src/db
git commit -m "feat(alarms): migration 011 — device-local ring-once log"
```

---

### Task 3: `NotificationReconciler.kt`

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/NotificationReconciler.kt`

**Interfaces:**
- Produces: `object NotificationReconciler { @JvmStatic fun reconcile(context: Context, planJson: String): Boolean }` — JNI-called; `true` on success.

- [ ] **Step 1: Write it**

```kotlin
package com.klaxon.app

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import app.tauri.notification.Notification
import app.tauri.notification.NotificationSchedule
import app.tauri.notification.NotificationStorage
import app.tauri.notification.TauriNotificationManager
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONArray
import java.util.Date

/**
 * Executes an alarm plan produced by the Rust planner. Thin on purpose:
 * no decisions here — cancel what isn't in the plan, (re)schedule what
 * is, through the vendored notification plugin's own manager/storage so
 * ids, receiver behavior, and action buttons stay identical to
 * plugin-scheduled notifications.
 *
 * Past-due entries arrive with at_ms in the past; they're scheduled at
 * now+2s (allowWhileIdle) so immediate rings flow through the exact same
 * receiver path as future ones.
 */
object NotificationReconciler {
  private const val TAG = "Klaxon"
  private const val ACTION_TYPE_ID = "klaxon-reminder"

  @JvmStatic
  fun reconcile(context: Context, planJson: String): Boolean {
    return try {
      val storage = NotificationStorage(context, ObjectMapper())
      val manager = TauriNotificationManager(
        storage, null, context, ObjectMapper()
      )
      val plan = JSONArray(planJson)

      val desiredIds = HashSet<Int>()
      val toSchedule = ArrayList<Notification>()
      val now = System.currentTimeMillis()

      for (i in 0 until plan.length()) {
        val p = plan.getJSONObject(i)
        val id = p.getInt("id_hash")
        desiredIds.add(id)
        val atMs = p.getLong("at_ms")
        val fireAt = if (atMs <= now) now + 2_000 else atMs

        val n = Notification()
        n.id = id
        n.title = p.getString("title")
        n.body = p.getString("body")
        n.channelId = p.getString("channel_id")
        n.actionTypeId = ACTION_TYPE_ID
        n.extra = JSObject().put("reminderId", p.getString("reminder_id"))
        n.isAutoCancel = true
        val sched = NotificationSchedule.At()
        sched.date = Date(fireAt)
        sched.repeating = false
        sched.allowWhileIdle = true
        n.schedule = sched
        n.sourceJson = p.toString()
        toSchedule.add(n)
      }

      // Cancel anything armed or posted that the plan no longer wants.
      val stale = storage.getSavedNotificationIds()
        .mapNotNull { it.toIntOrNull() }
        .filter { it !in desiredIds }
      if (stale.isNotEmpty()) {
        manager.cancel(stale)
        val nm = NotificationManagerCompat.from(context)
        for (id in stale) nm.cancel(id)
      }

      if (toSchedule.isNotEmpty()) manager.schedule(toSchedule)
      Log.i(TAG, "alarm reconcile: ${toSchedule.size} armed, ${stale.size} cancelled")
      true
    } catch (t: Throwable) {
      Log.w(TAG, "alarm reconcile failed", t)
      false
    }
  }
}
```

**Execution note:** `TauriNotificationManager`'s constructor signature must be checked against the vendored source (`vendor/.../TauriNotificationManager.kt:44`) — the second parameter (activity/webview, used only for foreground checks) should accept null or need an overload; adapt the call, or if it requires non-null, add a tiny constructor overload **in the vendored plugin** (we own the fork). Same for `Notification`'s package name and `sourceJson` expectations — mirror how `NotificationPlugin.kt` builds and passes notifications to `schedule`.

- [ ] **Step 2: Commit (compile-verified in Task 4's Android build)**

```bash
git add -f src-tauri/gen/android/app/src/main/java/com/klaxon/app/NotificationReconciler.kt
git commit -m "feat(alarms): Kotlin reconciler over the plugin's own manager/storage"
```

---

### Task 4: The bridge — `os_alarms.rs`, three callers, JS slim-down

**Files:**
- Create: `src-tauri/src/os_alarms.rs`
- Modify: `src-tauri/src/lib.rs` (module + command registration)
- Modify: `src-tauri/src/mobile_bg.rs` (cold + warm passes call reconcile)
- Modify: `src-tauri/src/commands.rs` (`reconcile_notifications` command)
- Modify: `src/lib/mobile-scheduler.ts`, `src/App.svelte`, `src/lib/api.ts`

**Interfaces:**
- Produces:
  - `pub fn reconcile_os_alarms(db: &Arc<Mutex<Connection>>) -> AppResult<()>` (Android-only; no-op cfg elsewhere)
  - Tauri command `reconcile_notifications` (mobile-only)
  - JS: `reconcileScheduledNotifications()` becomes a thin invoke, signature drops its argument

- [ ] **Step 1: The Rust bridge**

Create `src-tauri/src/os_alarms.rs`:

```rust
//! Bridge from the alarm planner to the Kotlin reconciler. One reconcile,
//! three callers: cold sync pass, warm background pass, and the
//! foreground `reconcile_notifications` command. Failure is logged and
//! never fails the caller — delivering data outranks ringing, and the
//! next reconcile retries naturally.

use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::AppResult;

#[cfg(target_os = "android")]
pub fn reconcile_os_alarms(db: &Arc<Mutex<Connection>>) -> AppResult<()> {
    use crate::error::AppError;

    let (plan, live_pairs) = {
        let conn = db.lock();
        let reminders = crate::db::reminders::list_all(&conn)?;
        let armed = crate::db::armed_alarms::armed_set(&conn)?;
        let plan = crate::alarm_plan::desired_notifications(
            &reminders,
            &armed,
            crate::models::now_ms(),
        );
        // Live = the CURRENT fire-target pair of every non-terminal
        // reminder — logged pairs matching these must survive (they're
        // what blocks re-rings), while pairs for moved, completed, or
        // deleted reminders age out. NOT plan ∪ armed: unioning the
        // existing log in would make prune a permanent no-op.
        let live: std::collections::HashSet<(String, i64)> = reminders
            .iter()
            .filter(|r| {
                matches!(
                    r.state,
                    crate::models::ReminderState::Pending
                        | crate::models::ReminderState::Snoozed
                )
            })
            .map(|r| (r.id.clone(), r.snooze_until.unwrap_or(r.due_at)))
            .collect();
        (plan, live)
    };

    let json = serde_json::to_string(&plan)
        .map_err(|e| AppError::Invalid(format!("plan encode: {e}")))?;

    let ok = call_kotlin_reconcile(&json)?;
    if !ok {
        return Err(AppError::Invalid("kotlin reconcile reported failure".into()));
    }

    // Log AFTER Kotlin succeeded — a failed hand-off must not burn a
    // ring-once entry (spec §5). Then prune against current-plan pairs
    // plus reminders still pending (their logged pairs stay live).
    {
        let conn = db.lock();
        let pairs: Vec<(String, i64)> = plan
            .iter()
            .map(|p| (p.reminder_id.clone(), p.at_ms))
            .collect();
        let _ = crate::db::armed_alarms::log_armed(&conn, &pairs, crate::models::now_ms());
        let _ = crate::db::armed_alarms::prune(&conn, &live_pairs);
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
pub fn reconcile_os_alarms(_db: &Arc<Mutex<Connection>>) -> AppResult<()> {
    Ok(())
}

/// Classloader-JNI into NotificationReconciler — same pattern as
/// ShareHelper (FindClass on a native thread can't see app classes).
#[cfg(target_os = "android")]
fn call_kotlin_reconcile(plan_json: &str) -> AppResult<bool> {
    use crate::error::AppError;
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| AppError::Invalid(format!("jvm: {e}")))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| AppError::Invalid(format!("attach: {e}")))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };

    let loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("classloader: {e}")))?;
    let name = env
        .new_string("com.klaxon.app.NotificationReconciler")
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("loadClass: {e}")))?;

    let jplan = env
        .new_string(plan_json)
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let ok = env
        .call_static_method(
            jni::objects::JClass::from(class),
            "reconcile",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[(&context).into(), (&jplan).into()],
        )
        .and_then(|v| v.z())
        .map_err(|e| AppError::Invalid(format!("reconcile call: {e}")))?;
    Ok(ok)
}
```

Register `pub mod os_alarms;` in `lib.rs`.

- [ ] **Step 2: The three callers**

1. **Cold:** in `mobile_bg.rs::try_headless_sync`, after `run_one_pass_headless` and before `endpoint.close()`:

```rust
            if let Err(e) = crate::os_alarms::reconcile_os_alarms(&db) {
                log::warn!("cold alarm reconcile failed: {e}");
            }
```

2. **Warm:** in `mobile_bg.rs::try_background_sync`, after the `run_one_pass` block_on:

```rust
                if let Err(e) = crate::os_alarms::reconcile_os_alarms(&state.db) {
                    log::warn!("warm alarm reconcile failed: {e}");
                }
```

3. **Foreground command** in `commands.rs`:

```rust
/// Mobile: re-arm OS notifications from the current reminders table.
/// Called by the webview on launch and after reminders-changed — the
/// same trigger points the old JS reconcile used.
#[cfg(mobile)]
#[tauri::command]
pub fn reconcile_notifications(state: State<'_, AppState>) -> AppResult<()> {
    crate::os_alarms::reconcile_os_alarms(&state.db)
}
```

Register in `generate_handler!` gated like the desktop-only commands:

```rust
            #[cfg(mobile)]
            commands::reconcile_notifications,
```

- [ ] **Step 3: Slim the JS**

In `mobile-scheduler.ts`: delete `hashIdToInt32`, `fireTargetMs`, `channelIdFor`, `formatDueLine`, `buildBody`, and the body of `reconcileScheduledNotifications`; it becomes:

```ts
import { invoke } from "@tauri-apps/api/core";

/** Arming now lives natively (one reconcile shared with the cold and
 * warm background sync passes). The webview's remaining jobs are
 * channels, action registration, and tap handling above. */
export async function reconcileScheduledNotifications(): Promise<void> {
  if (!isMobilePlatform()) return;
  await invoke("reconcile_notifications");
}
```

Drop the now-unused imports (`cancel`, `pending`, `Schedule`, `sendNotification` if unused by the remaining setup code — check; `sendNotification` is not used by setup). In `App.svelte:107`, the call site drops its argument: `reconcileScheduledNotifications().catch(...)`.

- [ ] **Step 4: Verify — host, frontend, Android**

`cd src-tauri && cargo test` — 102 passing, 0 warnings (bridge is cfg'd out on host, planner/log tested).
`npx svelte-check --threshold error` — 0 errors.
Android build (env per constraints): `npm run tauri android build -- --apk --target aarch64` — compiles the JNI bridge, the reconciler, and any vendored-plugin constructor adaptation together.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/os_alarms.rs src-tauri/src/lib.rs src-tauri/src/mobile_bg.rs \
        src-tauri/src/commands.rs src/lib/mobile-scheduler.ts src/App.svelte
git add -f src-tauri/gen/android  # if vendored-constructor adaptation touched gen files
git commit -m "feat(alarms): one native reconcile — cold, warm, and foreground callers"
```

(If the vendored plugin needed a constructor overload, commit that separately under `vendor/` with its own message explaining the fork change.)

---

### Task 5: On-device verification — the flagship

**Files:** none, then `CHANGELOG.md`.

- [ ] **Step 1: Upgrade path**

Before installing: note a reminder already armed by the 0.5.2 JS on the phone. Install the new build, open it once (foreground reconcile runs). The reminder must still be armed exactly once — fires once at its time. This validates hash parity end-to-end.

- [ ] **Step 2: The flagship**

Force-stop Klaxon on the phone. On the desktop, create a reminder due in ~3 minutes. Phone stays pocketed/screen-off. **It rings on time** (the cold pass arms it; the receiver fires it). Logcat shows `alarm reconcile: 1 armed` from the cold worker.

- [ ] **Step 3: Late arrival rings once**

Force-stop Klaxon. Desktop: create a reminder due 2 minutes **ago**. Trigger a cold pass (share something to Klaxon, or wait for the periodic slot). Phone rings once, promptly. Trigger another cold pass — **no second ring**.

- [ ] **Step 4: Cold shade-clearing**

With a reminder armed on the phone and Klaxon force-stopped, complete that reminder on the desktop. After the next cold pass, the phone's scheduled alarm is gone (it never rings).

- [ ] **Step 5: Foreground regression**

Normal use: create/snooze/complete reminders with the app open — notifications behave exactly as before (same look, same actions, Snooze/Dismiss buttons work).

- [ ] **Step 6: Changelog**

Unreleased → 0.6.0 section: cold alarm arming, grace window, ring-once, native reconcile.

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for cold alarm arming"
```
