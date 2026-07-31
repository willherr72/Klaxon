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

import { invoke } from "@tauri-apps/api/core";
import {
  createChannel,
  registerActionTypes,
  onAction,
  Importance,
  Visibility,
} from "@tauri-apps/plugin-notification";
import { api } from "./api";
import { isMobilePlatform } from "./platform";

const ACTION_TYPE_ID = "klaxon-reminder";
const ACTION_SNOOZE = "snooze";
const ACTION_DISMISS = "dismiss";
const DEFAULT_SNOOZE_MINS = 10;

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

/** Arming now lives natively (one reconcile in Rust/Kotlin, shared with
 * the cold and warm background sync passes — see alarm_plan.rs and
 * NotificationReconciler.kt). The webview's remaining jobs are the
 * channel/action setup and tap handling above. */
export async function reconcileScheduledNotifications(): Promise<void> {
  if (!isMobilePlatform()) return;
  await invoke("reconcile_notifications");
}
