import { invoke } from "@tauri-apps/api/core";
import type {
  Reminder,
  ReminderCreate,
  ReminderUpdate,
} from "./types";

export const api = {
  listReminders: () => invoke<Reminder[]>("list_reminders"),
  getReminder: (id: string) =>
    invoke<Reminder>("get_reminder", { id }),
  createReminder: (input: ReminderCreate) =>
    invoke<Reminder>("create_reminder", { input }),
  updateReminder: (id: string, patch: ReminderUpdate) =>
    invoke<Reminder>("update_reminder", { id, patch }),
  deleteReminder: (id: string) =>
    invoke<void>("delete_reminder", { id }),
  snoozeReminder: (id: string, snoozeUntilMs: number) =>
    invoke<Reminder>("snooze_reminder", { id, snoozeUntilMs }),
  dismissReminder: (id: string) =>
    invoke<Reminder>("dismiss_reminder", { id }),
  completeReminder: (id: string) =>
    invoke<Reminder>("complete_reminder", { id }),
  nextReminder: () => invoke<Reminder | null>("next_reminder"),
  getSetting: (key: string) =>
    invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  listSettings: () =>
    invoke<Record<string, string>>("list_settings"),
  dataDir: () => invoke<string>("data_dir"),
  setGlobalHotkey: (combo: string) =>
    invoke<void>("set_global_hotkey", { combo }),
};
