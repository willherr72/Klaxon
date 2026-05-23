/// OS-level background scheduling for Android (and iOS, when it ships).
///
/// Rust-side scheduler doesn't tick when Android backgrounds the app
/// (Doze mode, APP_STANDBY). To make reminders fire while the app is
/// closed, we schedule each pending reminder at the OS level through
/// tauri-plugin-notification's `Schedule.at()` API — which is backed
/// by AlarmManager.setExactAndAllowWhileIdle on Android.
///
/// Model:
///   - On launch and after every reminders-changed event, call
///     `reconcileScheduledNotifications(reminders)`.
///   - For each pending/snoozed reminder with a future fire time we
///     post a scheduled notification (id derived from the reminder UUID).
///   - OS-pending notifications that no longer correspond to a live
///     reminder are cancelled.
///   - The Rust dispatcher is a no-op on mobile (see alerts/mod.rs)
///     so we never double-notify when the app is open at fire time.

import {
  isPermissionGranted,
  sendNotification,
  cancel,
  pending,
  Schedule,
} from "@tauri-apps/plugin-notification";
import type { Reminder } from "./types";
import { isMobilePlatform } from "./platform";

/** Deterministic UUID → positive 31-bit int hash. The plugin's
 * notification id must be a 32-bit integer; we keep it positive to
 * avoid ambiguity with sign-handling in the plugin's internal map. */
function hashIdToInt32(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h) ^ id.charCodeAt(i);
  }
  return Math.abs(h | 0);
}

function fireTargetMs(r: Reminder): number | null {
  if (r.state !== "pending" && r.state !== "snoozed") return null;
  return r.snooze_until ?? r.due_at;
}

export async function reconcileScheduledNotifications(
  reminders: Reminder[],
): Promise<void> {
  if (!isMobilePlatform()) return;

  // Without the runtime permission the plugin can't post anything;
  // scheduling silently no-ops in that case but we save the round
  // trip by short-circuiting here.
  try {
    if (!(await isPermissionGranted())) return;
  } catch {
    return;
  }

  // Desired set: notification id → reminder. Only future-targeted
  // pending/snoozed reminders make the cut; everything else (fired,
  // dismissed, completed, past-due) is excluded so it gets cancelled.
  const desired = new Map<number, Reminder>();
  const now = Date.now();
  for (const r of reminders) {
    const t = fireTargetMs(r);
    if (t === null || t <= now) continue;
    desired.set(hashIdToInt32(r.id), r);
  }

  // Cancel pending OS notifications that no longer belong.
  try {
    const pendingList = await pending();
    const toCancel = pendingList
      .map((p) => p.id)
      .filter((id) => !desired.has(id));
    if (toCancel.length > 0) await cancel(toCancel);
  } catch (e) {
    console.warn("mobile-scheduler: cancel pass failed", e);
  }

  // Schedule each desired notification. The plugin treats `id` as a
  // primary key — sending again with the same id replaces the
  // existing schedule, so this loop is idempotent on re-runs.
  for (const [id, r] of desired) {
    try {
      const t = fireTargetMs(r)!;
      sendNotification({
        id,
        title: r.title,
        body: r.description ?? "",
        schedule: Schedule.at(new Date(t), false, true),
      });
    } catch (e) {
      console.warn(`mobile-scheduler: schedule failed for ${r.id}`, e);
    }
  }
}
