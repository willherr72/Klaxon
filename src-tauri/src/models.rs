use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
}

impl Priority {
    pub fn as_int(self) -> i32 {
        match self {
            Priority::Low => 0,
            Priority::Normal => 1,
            Priority::High => 2,
        }
    }

    pub fn from_int(n: i32) -> Self {
        match n {
            0 => Priority::Low,
            2 => Priority::High,
            _ => Priority::Normal,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReminderState {
    Pending,
    Fired,
    Snoozed,
    Dismissed,
    Completed,
}

impl ReminderState {
    pub fn as_str(self) -> &'static str {
        match self {
            ReminderState::Pending => "pending",
            ReminderState::Fired => "fired",
            ReminderState::Snoozed => "snoozed",
            ReminderState::Dismissed => "dismissed",
            ReminderState::Completed => "completed",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => ReminderState::Pending,
            "fired" => ReminderState::Fired,
            "snoozed" => ReminderState::Snoozed,
            "dismissed" => ReminderState::Dismissed,
            "completed" => ReminderState::Completed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RepeatRule {
    Daily,
    Weekly { weekdays: Vec<u8> },
    Interval { every_seconds: i64 },
    Monthly { day: u8 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub description: Option<String>,
    pub due_at: i64,
    pub priority: Priority,
    pub sound_path: Option<String>,
    pub repeat_rule: Option<RepeatRule>,
    pub state: ReminderState,
    pub snooze_until: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub source: String,
    pub external_id: Option<String>,
    pub last_synced_at: Option<i64>,
    pub dirty: bool,
    /// When true the scheduler ignores this row entirely — no alarm. Used
    /// for to-do style items that have a date but shouldn't ring.
    pub silent: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReminderCreate {
    pub title: String,
    pub description: Option<String>,
    pub due_at: i64,
    pub priority: Priority,
    pub sound_path: Option<String>,
    pub repeat_rule: Option<RepeatRule>,
    #[serde(default)]
    pub silent: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReminderUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
    pub due_at: Option<i64>,
    pub priority: Option<Priority>,
    pub sound_path: Option<Option<String>>,
    pub repeat_rule: Option<Option<RepeatRule>>,
    pub silent: Option<bool>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
