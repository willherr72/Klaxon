use serde::{Deserialize, Serialize};

use crate::db::task_lanes::Lane;
use crate::models::{Priority, ReminderState, RepeatRule};

/// Server identity returned by `/ping` so peers can confirm who they're
/// talking to (and that the shared secret matches).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingResponse {
    pub device_id: String,
    pub device_name: String,
    pub version: String,
    pub server_time_ms: i64,
}

/// A reminder as it travels over the wire — no local-only sync metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteReminder {
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
    #[serde(default)]
    pub silent: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    /// v0.3.1: swim-lane assignment for silent reminders. `None` on
    /// non-silent rows, and on rows synced from a pre-v0.3.1 peer.
    #[serde(default)]
    pub task_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTombstone {
    pub id: String,
    pub deleted_at: i64,
}

/// A thought as it travels over the wire. No `dirty` — that's local-only
/// bookkeeping, same as `RemoteReminder` omitting `source`/`external_id`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteThought {
    pub id: String,
    pub body: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub server_time_ms: i64,
    pub reminders: Vec<RemoteReminder>,
    pub tombstones: Vec<RemoteTombstone>,
    /// v0.3.1: swim-lane CRUD also flows over sync so paired devices
    /// see the same set of lanes. `#[serde(default)]` keeps the wire
    /// format compatible with v0.3.0 peers — they just ignore the field.
    #[serde(default)]
    pub lanes: Vec<Lane>,
    /// v0.5: the Thoughts feed. Appended last so an older peer decoding
    /// this ChangeSet reads the fields it knows and ignores the trailing
    /// bytes.
    ///
    /// NOTE: the reverse does *not* hold. postcard is not self-describing,
    /// so `#[serde(default)]` has nothing to trigger on — a newer peer
    /// decoding an older ChangeSet runs out of buffer here and fails the
    /// whole frame, not just this field. Accepted risk: upgrade all paired
    /// devices together. See the spec's §7 and the warning in
    /// `proto::read_frame`.
    #[serde(default)]
    pub thoughts: Vec<RemoteThought>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResponse {
    pub server_time_ms: i64,
    pub accepted_reminders: usize,
    pub accepted_tombstones: usize,
    #[serde(default)]
    pub accepted_lanes: usize,
    #[serde(default)]
    pub accepted_thoughts: usize,
}

// ── Tap-to-pair handshake ────────────────────────────────────────────

/// What the responder's frontend gets via Tauri event when an incoming
/// pair request arrives.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPairEvent {
    pub request_id: String,
    pub initiator_id: String,
    pub initiator_name: String,
    pub initiator_url: String,
    pub confirmation_code: String,
}

#[derive(Debug, Clone, Copy)]
pub enum PairDecision {
    Approve,
    Decline,
}

/// What the initiator's frontend gets back after a successful tap-to-pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairOutcome {
    pub peer_id: String,
    pub peer_name: String,
    pub confirmation_code: String,
}

impl From<&crate::models::Reminder> for RemoteReminder {
    fn from(r: &crate::models::Reminder) -> Self {
        Self {
            id: r.id.clone(),
            title: r.title.clone(),
            description: r.description.clone(),
            due_at: r.due_at,
            priority: r.priority,
            sound_path: r.sound_path.clone(),
            repeat_rule: r.repeat_rule.clone(),
            state: r.state,
            snooze_until: r.snooze_until,
            created_at: r.created_at,
            updated_at: r.updated_at,
            silent: r.silent,
            tags: r.tags.clone(),
            task_lane_id: r.task_lane_id.clone(),
        }
    }
}

impl From<&crate::models::Thought> for RemoteThought {
    fn from(t: &crate::models::Thought) -> Self {
        Self {
            id: t.id.clone(),
            body: t.body.clone(),
            tags: t.tags.clone(),
            created_at: t.created_at,
            updated_at: t.updated_at,
        }
    }
}

impl From<&crate::db::tombstones::Tombstone> for RemoteTombstone {
    fn from(t: &crate::db::tombstones::Tombstone) -> Self {
        Self {
            id: t.id.clone(),
            deleted_at: t.deleted_at,
        }
    }
}
