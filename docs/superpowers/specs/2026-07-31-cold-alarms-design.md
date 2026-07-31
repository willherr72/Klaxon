# Cold Alarm Arming (v0.6) — Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-07-31
**Branch:** new branch off `main`
**Author:** William Herr (with Claude)

---

## 1. Problem

Klaxon's identity is "a reminder app that actually gets your attention" —
and since v0.5.1, sync delivers a reminder to a pocketed phone within
minutes even when the app is dead. But it arrives *silently*. Alarm arming
lives in the webview (`mobile-scheduler.ts` → the notification plugin's
`Schedule.at`), and a cold process has no webview. A 3:00 reminder created
on the desktop at 2:50 syncs to the phone by 2:55 and then sits mute; if
the user opens Klaxon at 4:00, the klaxon never sounded. The core promise
breaks exactly where the sync work finally made it reachable.

Desktop is unaffected: its scheduler rings from the resident tray process.
This design is Android-only.

## 2. Key insight (verified in code)

The *firing* half already works cold. The vendored notification plugin's
`ScheduledNotificationReceiver` wakes in a cold process when AlarmManager
fires, reads `NotificationStorage` (SharedPreferences), and posts — that is
how pre-armed reminders ring today with the app closed. And
`TauriNotificationManager` + `NotificationStorage` are plain classes
needing only a `Context`, constructible from our cold `BackgroundSyncWorker`.

So the problem is exactly *arming*, not firing: get every code path —
foreground, warm background, cold background — to arm through the same
storage, ids, and receiver.

## 3. Decisions (user-approved)

1. **Option A — one reconcile, owned by native, fed by Rust.** The
   what-should-be-armed decision moves to a pure Rust planner; a thin
   Kotlin reconciler executes it via the plugin's own manager/storage. The
   JS reconcile (and its copy of the id hash, body format, and skip
   policy) is deleted, not paralleled — no drift between two
   implementations, which is the failure class that cost us the picker
   afternoon.
2. **Late arrivals: ring if recently due, skip if stale.** A reminder
   arriving past its fire time rings immediately if it is less than
   **30 minutes** late (named constant, tunable); older stays silent and
   shows as overdue in-app. Prevents a re-pair or week-offline catch-up
   from detonating a pile of ancient notifications.

## 4. Components

### 4.1 `alarm_plan.rs` — the pure planner (Rust, host-testable)

`desired_notifications(reminders: &[Reminder], armed: &ArmedLog, now_ms) ->
Vec<PlannedNotification>`:

- Include pending/snoozed reminders; fire time = `snooze_until ?? due_at`.
- Future fire time → include (idempotent re-schedule; same-id replace).
- Past fire time → include **only if** within the grace window **and**
  the (reminder, fire time) pair is not already in the armed log (§4.2).
- `PlannedNotification { id_hash: i32, reminder_id, title, body,
  channel_id, at_ms, past_due: bool }`.

**Bit-exact parity requirements** (unit-tested against values captured
from the running JS):

- `id_hash` replicates `hashIdToInt32` (`mobile-scheduler.ts:45`): djb2
  variant with JS 32-bit semantics (`h = ((h<<5)+h) ^ c` wrapping i32,
  then `abs`). A differing hash would double-schedule every alarm already
  armed on the user's phone at upgrade time.
- Body text replicates `buildBody`/`formatDueLine` so notifications look
  identical before and after.
- Channel mapping replicates `channelIdFor` (`klaxon-low/normal/high`).

### 4.2 Ring-once memory — migration 011, `armed_alarms`

The JS reconcile was idempotent only because it skipped past-due entries;
"ring if recently due" breaks that — an immediately-firing entry would
re-fire on every subsequent reconcile. New **device-local** table (never
synced; whether *this device* rang is not shared state):

```sql
CREATE TABLE armed_alarms (
    reminder_id TEXT NOT NULL,
    fire_at_ms  INTEGER NOT NULL,
    armed_at    INTEGER NOT NULL,
    PRIMARY KEY (reminder_id, fire_at_ms)
);
```

Arming a past-due entry logs the pair; the planner skips logged pairs.
Snooze/recurrence moves the fire time → new pair → rings again (correct).
Reconcile prunes rows whose reminder no longer exists or whose fire time
is neither current nor pending. Future-due arming also logs, harmlessly —
one code path, and the log doubles as arming evidence in debugging.

### 4.3 `NotificationReconciler.kt` — the thin executor

In the app package beside `ShareHelper`. Input: JSON array of planned
notifications. Behavior:

- Cancel scheduled notifications (alarm + storage) whose id is not in the
  desired set, and **cancel posted notifications** for those ids too — a
  reminder completed on the desktop clears the phone's shade even cold.
- Schedule every desired entry through `TauriNotificationManager` (same
  `Notification` model the plugin builds), with the plugin's action type
  id and `extra.reminderId`, so taps and Snooze/Dismiss buttons behave
  identically to plugin-scheduled ones.
- Past-due entries post immediately (no schedule) on the right channel.
- No decisions: the reconciler executes the plan verbatim.

### 4.4 One reconcile, three callers

`reconcile_os_alarms(db, ...)` (Android-only Rust): run the planner, cross
to Kotlin via the classloader-JNI pattern proven by `ShareHelper`, update
the armed log. Called from:

1. **Cold pass** — end of `try_headless_sync` (the reason this exists).
2. **Warm background pass** — end of the warm WorkManager path.
3. **Foreground** — a `reconcile_notifications` Tauri command; the JS
   calls it exactly where `reconcileScheduledNotifications` is called
   today (launch + every reminders-changed).

`mobile-scheduler.ts` keeps channels, action-type registration, and
tap/action handling (webview concerns); its reconcile, hash, and body
formatting are deleted.

## 5. Error handling

- Reconcile failure is logged and never fails a sync pass — delivering
  data outranks ringing, and the next reconcile (foreground at latest)
  retries naturally.
- JNI failures degrade to pre-v0.6 behavior (armed on next app open).
- The armed log is written only after Kotlin returns success, so a failed
  hand-off doesn't burn a ring-once entry.

## 6. Non-goals

- Desktop changes of any kind.
- iOS.
- Fullscreen/alarm-activity UI for high priority while cold — channels
  already give heads-up display; the in-app fullscreen alert remains a
  foreground behavior.
- Configurable grace window in Settings (constant until real use argues).
- Changing recurrence semantics: the planner arms the current next
  occurrence exactly as the JS did; advancing recurrences remains the
  resident scheduler's job.

## 7. Testing

Rust (host): hash parity against captured JS values (several UUIDs,
including hash-collision-shaped inputs); body/due-line parity incl. the
"Due today/tomorrow/was due yesterday" branches; grace edges (29 min
rings, 31 min doesn't); ring-once (same pair planned twice → second run
excludes); snooze moves fire time → re-included; pruning; planner output
stability (same input → same JSON).

On-device (the flagship): force-stop Klaxon, create a reminder on the
desktop due in ~3 minutes, phone stays pocketed — **it rings on time**.
Also: complete a reminder on the desktop → phone's shade clears cold;
late-arrival within grace rings once and only once across multiple
subsequent passes; upgrade path — alarms armed by v0.5.2's JS still fire
and don't double after updating.

## 8. Sequencing

- Takes **migration 011** (the shelved calendar branch renumbers once
  more when it returns).
- Ships as **v0.6.0** — a minor bump: user-visible new behavior, no wire
  format change (0.5.x peers sync freely).
