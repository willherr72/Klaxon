export type Priority = "low" | "normal" | "high";

export type ReminderState =
  | "pending"
  | "fired"
  | "snoozed"
  | "dismissed"
  | "completed";

export type RepeatRule =
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: number[] }
  | { kind: "interval"; every_seconds: number }
  | { kind: "monthly"; day: number };

export interface Reminder {
  id: string;
  title: string;
  description: string | null;
  due_at: number;
  priority: Priority;
  sound_path: string | null;
  repeat_rule: RepeatRule | null;
  state: ReminderState;
  snooze_until: number | null;
  created_at: number;
  updated_at: number;
  source: string;
  external_id: string | null;
  last_synced_at: number | null;
  dirty: boolean;
  silent: boolean;
}

export interface ReminderCreate {
  title: string;
  description: string | null;
  due_at: number;
  priority: Priority;
  sound_path: string | null;
  repeat_rule: RepeatRule | null;
  silent: boolean;
}

export interface ReminderUpdate {
  title?: string;
  description?: string | null;
  due_at?: number;
  priority?: Priority;
  sound_path?: string | null;
  repeat_rule?: RepeatRule | null;
  silent?: boolean;
}

export type ViewMode = "reminders" | "tasks" | "calendar" | "completed";
export type TimeFilter = "all" | "today" | "upcoming" | "recurring";
