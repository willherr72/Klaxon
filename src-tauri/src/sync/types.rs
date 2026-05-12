use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteTombstone {
    pub id: String,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub server_time_ms: i64,
    pub reminders: Vec<RemoteReminder>,
    pub tombstones: Vec<RemoteTombstone>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResponse {
    pub server_time_ms: i64,
    pub accepted_reminders: usize,
    pub accepted_tombstones: usize,
}

// ── Tap-to-pair handshake ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRequest {
    pub request_id: String,
    pub initiator_id: String,
    pub initiator_name: String,
    pub initiator_url: String,
    pub ephemeral_token: String,
    pub initiator_cert_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairResponse {
    pub responder_id: String,
    pub responder_name: String,
    pub responder_url: String,
    pub shared_secret: String,
    pub responder_cert_fingerprint: String,
}

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
