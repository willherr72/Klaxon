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

  silent: boolean;
  tags: string[];
  // v0.3.1: swim-lane id (only set for silent reminders / tasks).
  task_lane_id: string | null;
}

export interface ReminderCreate {
  title: string;
  description: string | null;
  due_at: number;
  priority: Priority;
  sound_path: string | null;
  repeat_rule: RepeatRule | null;
  silent: boolean;
  tags: string[];
  // Pre-seed the lane when creating from a specific column's `+ Add`.
  task_lane_id?: string | null;
}

export interface ReminderUpdate {
  title?: string;
  description?: string | null;
  due_at?: number;
  priority?: Priority;
  sound_path?: string | null;
  repeat_rule?: RepeatRule | null;
  silent?: boolean;
  tags?: string[];
  task_lane_id?: string | null;
}

export type ViewMode =
  | "reminders"
  | "tasks"
  | "calendar"
  | "completed"
  | "thoughts";
export type TimeFilter = "all" | "today" | "upcoming" | "recurring";

// ── Thoughts (v0.5) ──────────────────────────────────────────────────

export interface Thought {
  id: string;
  body: string;
  tags: string[];
  created_at: number;
  updated_at: number;

}

export interface ThoughtCreate {
  body: string;
  tags: string[];
}

export interface ThoughtUpdate {
  body?: string;
  tags?: string[];
}

export interface ThoughtHit {
  thought: Thought;
  /** FTS5 excerpt with matched terms wrapped in <mark>. */
  snippet: string;
}

export interface TagCount {
  tag: string;
  count: number;
}
