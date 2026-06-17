/// OS-level background scheduling for Android (and iOS, when it ships).
///
/// Rust-side scheduler doesn't tick when Android backgrounds the app
/// (Doze mode, APP_STANDBY). To make reminders fire while the app is
/// closed, we schedule each pending reminder at the OS level through
/// tauri-plugin-notification's `Schedule.at()` API — which is backed
/// by AlarmManager.setExactAndAllowWhileIdle on Android.
///
/// Model:
///   - Setup on first launch creates priority channels + registers
///     action buttons (Snooze / Dismiss).
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
  createChannel,
  registerActionTypes,
  onAction,
  Importance,
  Visibility,
} from "@tauri-apps/plugin-notification";
import { api } from "./api";
import type { Reminder, Priority } from "./types";
import { isMobilePlatform } from "./platform";

const ACTION_TYPE_ID = "klaxon-reminder";
const ACTION_SNOOZE = "snooze";
const ACTION_DISMISS = "dismiss";
const DEFAULT_SNOOZE_MINS = 10;

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

function channelIdFor(p: Priority): string {
  switch (p) {
    case "low":
      return "klaxon-low";
    case "normal":
      return "klaxon-normal";
    case "high":
      return "klaxon-high";
  }
}

/** Pretty due-time line appended to the notification body. */
function formatDueLine(targetMs: number): string {
  const t = new Date(targetMs);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tDay = new Date(targetMs);
  tDay.setHours(0, 0, 0, 0);
  const diffDays = Math.round(
    (tDay.getTime() - today.getTime()) / 86_400_000,
  );
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  if (diffDays === 0) return `Due today ${hh}:${mm}`;
  if (diffDays === 1) return `Due tomorrow ${hh}:${mm}`;
  if (diffDays === -1) return `Was due yesterday ${hh}:${mm}`;
  const months = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
  ];
  return `Due ${months[t.getMonth()]} ${String(t.getDate()).padStart(2, "0")} ${hh}:${mm}`;
}

function buildBody(r: Reminder, targetMs: number): string {
  const lines: string[] = [];
  if (r.description) lines.push(r.description);
  lines.push(`${formatDueLine(targetMs)} (${r.priority.toUpperCase()})`);
  return lines.join("\n");
}

/// One-time setup on app launch: register channels (so per-priority
/// importance + heads-up display works) and action buttons (Snooze /
/// Dismiss in the notification shade). Idempotent — calling twice
/// just replaces the channel definitions.
export async function setupMobileNotifications(opts: {
  onOpenReminder: (id: string) => void;
}): Promise<void> {
  if (!isMobilePlatform()) return;

  try {
    await createChannel({
      id: "klaxon-low",
      name: "Low priority",
      description: "Background reminders. No heads-up, quiet sound.",
      importance: Importance.Low,
      visibility: Visibility.Public,
      vibration: false,
      lights: false,
    });
    await createChannel({
      id: "klaxon-normal",
      name: "Normal priority",
      description: "Standard reminders.",
      importance: Importance.Default,
      visibility: Visibility.Public,
      vibration: true,
      lights: true,
    });
    await createChannel({
      id: "klaxon-high",
      name: "High priority",
      description: "Urgent reminders — heads-up display + full ringtone.",
      importance: Importance.High,
      visibility: Visibility.Public,
      vibration: true,
      lights: true,
    });
  } catch (e) {
    console.warn("createChannel failed", e);
  }

  try {
    await registerActionTypes([
      {
        id: ACTION_TYPE_ID,
        actions: [
          { id: ACTION_SNOOZE, title: `Snooze ${DEFAULT_SNOOZE_MINS}m` },
          { id: ACTION_DISMISS, title: "Dismiss", destructive: true },
        ],
      },
    ]);
  } catch (e) {
    console.warn("registerActionTypes failed", e);
  }

  // onAction fires for both action-button taps and body taps.
  try {
    await onAction((notification: unknown) => {
      const n = notification as {
        actionId?: string;
        notification?: { extra?: { reminderId?: string } };
      };
      const reminderId = n.notification?.extra?.reminderId;
      if (!reminderId) {
        console.warn("notification action missing reminderId", notification);
        return;
      }
      const actionId = n.actionId ?? "tap";
      handleAction(actionId, reminderId, opts.onOpenReminder).catch((e) =>
        console.error("notification action failed", e),
      );
    });
  } catch (e) {
    console.warn("onAction listener failed", e);
  }
}

async function handleAction(
  actionId: string,
  reminderId: string,
  onOpenReminder: (id: string) => void,
) {
  if (actionId === ACTION_SNOOZE) {
    await api.snoozeReminder(
      reminderId,
      Date.now() + DEFAULT_SNOOZE_MINS * 60_000,
    );
  } else if (actionId === ACTION_DISMISS) {
    await api.dismissReminder(reminderId);
  } else {
    onOpenReminder(reminderId);
  }
}

export async function reconcileScheduledNotifications(
  reminders: Reminder[],
): Promise<void> {
  if (!isMobilePlatform()) return;

  try {
    if (!(await isPermissionGranted())) return;
  } catch {
    return;
  }

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
        body: buildBody(r, t),
        channelId: channelIdFor(r.priority),
        actionTypeId: ACTION_TYPE_ID,
        extra: { reminderId: r.id },
        schedule: Schedule.at(new Date(t), false, true),
      });
    } catch (e) {
      console.warn(`mobile-scheduler: schedule failed for ${r.id}`, e);
    }
  }
}
