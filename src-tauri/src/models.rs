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
    /// When true the scheduler ignores this row entirely — no alarm. Used
    /// for to-do style items that have a date but shouldn't ring.
    pub silent: bool,
    /// Free-form labels, lowercase, deduplicated. Persisted as a JSON array.
    #[serde(default)]
    pub tags: Vec<String>,
    /// v0.3.1: swim-lane assignment for silent (task) reminders. Always
    /// `Some` when `silent = true` post-migration-008; `None` on
    /// non-silent reminders.
    #[serde(default)]
    pub task_lane_id: Option<String>,
    /// v0.8: manual position within the task lane. Lanes render
    /// ascending (smallest on top). `None` on non-task rows.
    #[serde(default)]
    pub task_sort_key: Option<f64>,
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
    #[serde(default)]
    pub tags: Vec<String>,
    /// Pre-set the lane when creating a task from a specific column's
    /// `+ Add` button. Ignored when `silent = false`. When omitted on a
    /// silent reminder, the backend assigns the default lane.
    #[serde(default)]
    pub task_lane_id: Option<String>,
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
    pub tags: Option<Vec<String>>,
    /// Used by DnD between columns on the TasksBoard.
    pub task_lane_id: Option<Option<String>>,
}

/// Canonical form for a tag — lowercase, trimmed, with internal whitespace
/// collapsed to single spaces. Empty strings are returned as `None`.
pub fn normalize_tag(raw: &str) -> Option<String> {
    let s: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// The `#tag` rule, in one place: a token must start with `#` and have
/// something after it; the remainder keeps only alphanumerics, `-` and `_`,
/// lowercased. Returns `None` for anything that isn't a usable tag.
///
/// Shared by the natural-language parser (which strips the token from the
/// title) and the Thoughts feed (which leaves it in the body) so the two
/// can never drift on what counts as a tag.
pub fn tag_from_token(token: &str) -> Option<String> {
    if !token.starts_with('#') || token.len() <= 1 {
        return None;
    }
    let cleaned: String = token[1..]
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .to_lowercase();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Every `#tag` mentioned in free text, deduplicated, first-seen order.
/// The text itself is left alone — callers that want the tags removed do
/// that separately.
pub fn extract_tags(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for token in text.split_whitespace() {
        if let Some(tag) = tag_from_token(token) {
            if seen.insert(tag.clone()) {
                out.push(tag);
            }
        }
    }
    out
}

/// Normalize + dedupe a list of tags, preserving first-seen order.
pub fn normalize_tags(input: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for raw in input {
        if let Some(t) = normalize_tag(&raw) {
            if seen.insert(t.clone()) {
                out.push(t);
            }
        }
    }
    out
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Hard ceiling on a thought body. An Android share can carry an entire
/// article, and the whole ChangeSet is held in memory under the 16 MiB
/// frame cap in `sync/proto.rs` — 64 K characters is generous for a
/// thought and far below that even in bulk.
pub const MAX_THOUGHT_CHARS: usize = 65_536;

/// Trim surrounding whitespace and clamp to `MAX_THOUGHT_CHARS`.
/// Counts characters, not bytes — slicing bytes would panic mid-codepoint.
pub fn truncate_body(raw: &str) -> String {
    raw.trim().chars().take(MAX_THOUGHT_CHARS).collect()
}

/// A captured thought: free text, no time, no lifecycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thought {
    pub id: String,
    pub body: String,
    /// Free-form labels sharing the reminder tag vocabulary. Persisted as
    /// a JSON array of lowercase strings.
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThoughtCreate {
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ThoughtUpdate {
    pub body: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::{truncate_body, MAX_THOUGHT_CHARS};

    #[test]
    fn short_bodies_pass_through_untouched() {
        assert_eq!(truncate_body("  an idea  "), "an idea");
    }

    #[test]
    fn long_bodies_are_capped_at_the_char_limit() {
        let huge = "x".repeat(MAX_THOUGHT_CHARS + 500);
        assert_eq!(truncate_body(&huge).chars().count(), MAX_THOUGHT_CHARS);
    }

    #[test]
    fn truncation_counts_chars_not_bytes() {
        // A naive byte-slice would panic here by splitting a multi-byte char.
        let huge = "é".repeat(MAX_THOUGHT_CHARS + 10);
        assert_eq!(truncate_body(&huge).chars().count(), MAX_THOUGHT_CHARS);
    }
}
