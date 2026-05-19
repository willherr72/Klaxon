use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::alerts;
use crate::db::{peers as peer_repo, reminders as repo, settings as cfg};
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, Reminder, ReminderCreate, ReminderState, ReminderUpdate};
use crate::scheduler::SchedulerMsg;
use crate::sync;
use crate::sync::types::PingResponse;
use crate::AppState;

#[tauri::command]
pub fn list_reminders(state: State<'_, AppState>) -> AppResult<Vec<Reminder>> {
    let conn = state.db.lock();
    repo::list_all(&conn)
}

#[tauri::command]
pub fn get_reminder(state: State<'_, AppState>, id: String) -> AppResult<Reminder> {
    let conn = state.db.lock();
    repo::get_by_id(&conn, &id)
}

#[tauri::command]
pub fn create_reminder(
    state: State<'_, AppState>,
    input: ReminderCreate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::create(&conn, input)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn update_reminder(
    state: State<'_, AppState>,
    id: String,
    patch: ReminderUpdate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::update(&conn, &id, patch)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn delete_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        repo::delete(&conn, &id)?;
    }
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(())
}

#[tauri::command]
pub fn snooze_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    snooze_until_ms: i64,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::set_state(&conn, &id, ReminderState::Snoozed, Some(snooze_until_ms))?
    };
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn dismiss_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<Reminder> {
    // "Dismiss" stops the active alarm but does not transition the reminder
    // to a terminal state. For one-shots the scheduler already set state to
    // Fired; for recurring the scheduler already rescheduled to the next
    // occurrence (state=Pending). In both cases we leave that alone so the
    // user can come back to the item later. If state is currently Pending
    // (e.g. dismiss invoked outside the alarm window), bump to Dismissed
    // so it visibly differentiates from never-rang reminders.
    alerts::cancel_alert(&app, &id);
    let r = {
        let conn = state.db.lock();
        let existing = repo::get_by_id(&conn, &id)?;
        if existing.state == ReminderState::Pending && existing.repeat_rule.is_none() {
            repo::set_state(&conn, &id, ReminderState::Dismissed, None)?
        } else {
            existing
        }
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn complete_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::set_state(&conn, &id, ReminderState::Completed, None)?
    };
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn next_reminder(state: State<'_, AppState>) -> AppResult<Option<Reminder>> {
    let conn = state.db.lock();
    repo::next_pending(&conn)
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let conn = state.db.lock();
    cfg::get(&conn, &key)
}

#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    let conn = state.db.lock();
    cfg::set(&conn, &key, &value)
}

#[tauri::command]
pub fn list_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    let conn = state.db.lock();
    cfg::list_all(&conn)
}

#[tauri::command]
pub fn data_dir(app: AppHandle) -> AppResult<String> {
    use tauri::Manager;
    let path = app.path().app_data_dir()?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_global_hotkey(
    state: State<'_, AppState>,
    app: AppHandle,
    combo: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        cfg::set(&conn, "global_hotkey_new", &combo)?;
    }
    crate::install_global_hotkey(&app, &state.current_hotkey, &combo)
}

#[tauri::command]
pub fn preview_tone(state: State<'_, AppState>, tone: String) -> AppResult<()> {
    let parsed = crate::audio::TonePattern::from_str_or_default(&tone);
    let id = format!("preview-{}", uuid::Uuid::new_v4());
    state
        .audio_tx
        .send(crate::audio::AudioCmd::Play { id, tone: parsed })
        .map_err(|e| AppError::Invalid(format!("audio: {e}")))?;
    Ok(())
}

/// Parse a natural-language quick-add string into a title + due-at preview.
/// Returns an error string if no usable title could be extracted — the
/// frontend uses that to keep the Save button disabled while showing the
/// hint.
#[tauri::command]
pub fn nl_parse(input: String) -> Result<crate::nl::Parsed, crate::nl::ParseError> {
    crate::nl::parse(&input, chrono::Local::now())
}

// ── Sync ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub sync_enabled: bool,
    /// v0.3 iroh transport — this device's stable EndpointId, or `None`
    /// if sync is disabled / the endpoint hasn't started.
    pub iroh_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerView {
    pub id: String,
    pub name: String,
    pub last_pull_at: i64,
    pub last_push_at: i64,
    pub last_seen_at: Option<i64>,
    pub iroh_node_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AddPeerInput {
    pub id: String,
    pub name: String,
    pub shared_secret: String,
    pub iroh_node_id: String,
}

#[tauri::command]
pub fn list_peers(state: State<'_, AppState>) -> AppResult<Vec<PeerView>> {
    let conn = state.db.lock();
    let peers = peer_repo::list_all(&conn)?;
    Ok(peers
        .into_iter()
        .map(|p| PeerView {
            id: p.id,
            name: p.name,
            last_pull_at: p.last_pull_at,
            last_push_at: p.last_push_at,
            last_seen_at: p.last_seen_at,
            iroh_node_id: p.iroh_node_id,
        })
        .collect())
}

/// Manual peer entry — bypasses pairing. Useful for transferring a peer
/// list between installs, or pairing two devices that can't reach each
/// other via mDNS (e.g. across home networks before QR/ticket pairing
/// lands). Caller is responsible for getting the shared_secret and
/// node_id from the other device out-of-band.
#[tauri::command]
pub fn add_peer(state: State<'_, AppState>, input: AddPeerInput) -> AppResult<PeerView> {
    if input.id.trim().is_empty() {
        return Err(AppError::Invalid("peer id required".into()));
    }
    if input.shared_secret.trim().is_empty() {
        return Err(AppError::Invalid("shared secret required".into()));
    }
    if input.iroh_node_id.trim().is_empty() {
        return Err(AppError::Invalid("iroh node_id required".into()));
    }
    let peer = peer_repo::Peer {
        id: input.id.trim().to_string(),
        name: input.name.trim().to_string(),
        shared_secret: input.shared_secret.trim().to_string(),
        last_pull_at: 0,
        last_push_at: 0,
        created_at: now_ms(),
        last_seen_at: None,
        iroh_node_id: Some(input.iroh_node_id.trim().to_string()),
    };
    {
        let conn = state.db.lock();
        peer_repo::upsert(&conn, &peer)?;
    }
    Ok(PeerView {
        id: peer.id,
        name: peer.name,
        last_pull_at: peer.last_pull_at,
        last_push_at: peer.last_push_at,
        last_seen_at: peer.last_seen_at,
        iroh_node_id: peer.iroh_node_id,
    })
}

#[tauri::command]
pub fn remove_peer(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let conn = state.db.lock();
    peer_repo::delete(&conn, &id)
}

/// Ping a paired peer over iroh. Fails fast if the peer has no
/// `iroh_node_id` (paired pre-v0.3 — must re-pair) or if our local iroh
/// endpoint isn't up.
#[tauri::command]
pub async fn ping_peer(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<PingResponse> {
    let (node_id, secret) = {
        let conn = state.db.lock();
        let peers = peer_repo::list_all(&conn)?;
        let p = peers
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::NotFound(format!("peer {id}")))?;
        let node_id = p.iroh_node_id.ok_or_else(|| {
            AppError::Invalid(
                "peer has no iroh node id — was paired pre-v0.3, re-pair to enable".into(),
            )
        })?;
        (node_id, p.shared_secret)
    };
    let endpoint = state
        .iroh_node
        .lock()
        .as_ref()
        .map(|n| n.endpoint.clone())
        .ok_or_else(|| AppError::Invalid("local iroh endpoint not started".into()))?;
    sync::iroh_client::ping(&endpoint, &node_id, &secret).await
}

#[tauri::command]
pub fn device_identity(state: State<'_, AppState>) -> AppResult<DeviceInfo> {
    let identity = sync::read_identity(&state.db);
    let enabled = sync::read_enabled(&state.db);
    let iroh_node_id = state
        .iroh_node
        .lock()
        .as_ref()
        .map(|n| n.node_id.clone());
    Ok(DeviceInfo {
        device_id: identity.device_id,
        device_name: identity.device_name,
        sync_enabled: enabled,
        iroh_node_id,
    })
}

#[tauri::command]
pub fn generate_secret() -> AppResult<String> {
    Ok(sync::generate_secret())
}

#[tauri::command]
pub fn set_sync_enabled(state: State<'_, AppState>, enabled: bool) -> AppResult<()> {
    let conn = state.db.lock();
    cfg::set(&conn, "sync_enabled", if enabled { "true" } else { "false" })?;
    // Note: starting/stopping the actual server + mDNS requires a restart.
    // The sync TASK respects the flag immediately on its next tick.
    Ok(())
}

#[tauri::command]
pub fn list_discovered_peers(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::sync::discovery::DiscoveredPeer>> {
    let guard = state.discovery.lock();
    let Some(handle) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let peers = handle.peers.lock();
    Ok(peers.values().cloned().collect())
}

// ── Tap-to-pair (initiator side) ──────────────────────────────────────

/// v0.3 phase 3c: pair handshake rides iroh, not HTTPS.
///
/// The discovered peer's `node_id` (from mDNS TXT) is now what we dial.
/// `peer_url` and `peer_cert_fingerprint` are intentionally gone — there
/// is no LAN HTTPS path anymore. mDNS-discovered peers without a
/// `node_id` (shouldn't happen post-v0.3 cutover, but defensive) are
/// rejected up front.
#[tauri::command]
pub async fn start_pair_with(
    state: State<'_, AppState>,
    app: AppHandle,
    peer_node_id: String,
    peer_id: String,
    peer_name: String,
) -> AppResult<crate::sync::types::PairOutcome> {
    use crate::sync::proto::{PairAck, PairOffer};
    use crate::sync::types::PairOutcome;

    if peer_node_id.trim().is_empty() {
        return Err(AppError::Invalid(
            "peer must advertise an iroh node id via mDNS to be paired".into(),
        ));
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let ephemeral = sync::generate_secret();
    let our = sync::read_identity(&state.db);

    let (endpoint, our_node_id) = state
        .iroh_node
        .lock()
        .as_ref()
        .map(|n| (n.endpoint.clone(), n.node_id.clone()))
        .ok_or_else(|| AppError::Invalid("local iroh endpoint not started".into()))?;

    let sas = sync::confirmation_code(&request_id, &ephemeral, &our.device_id, &peer_id);

    let _ = app.emit(
        "klaxon://pair-progress",
        serde_json::json!({
            "request_id": request_id,
            "peer_id": peer_id,
            "peer_name": peer_name,
            "confirmation_code": sas,
        }),
    );

    let offer = PairOffer {
        request_id: request_id.clone(),
        initiator_id: our.device_id.clone(),
        initiator_name: our.device_name.clone(),
        initiator_node_id: our_node_id,
        ephemeral_token: ephemeral,
    };

    let ack = sync::iroh_client::pair_initiate(&endpoint, &peer_node_id, offer).await?;

    match ack {
        PairAck::Approved {
            responder_id,
            responder_name,
            responder_node_id,
            shared_secret,
        } => {
            {
                let conn = state.db.lock();
                let peer = peer_repo::Peer {
                    id: responder_id.clone(),
                    name: if peer_name.trim().is_empty() {
                        responder_name.clone()
                    } else {
                        peer_name.clone()
                    },
                    shared_secret,
                    last_pull_at: 0,
                    last_push_at: 0,
                    created_at: now_ms(),
                    last_seen_at: Some(now_ms()),
                    iroh_node_id: Some(responder_node_id.clone()),
                };
                peer_repo::upsert(&conn, &peer)?;
            }

            let _ = app.emit("klaxon://peer-paired", responder_id.clone());

            Ok(PairOutcome {
                peer_id: responder_id,
                peer_name: responder_name,
                confirmation_code: sas,
            })
        }
        PairAck::Declined => Err(AppError::Invalid("peer declined the pairing".into())),
        PairAck::Error(msg) => Err(AppError::Invalid(format!("pair error: {msg}"))),
    }
}

// ── Tap-to-pair (responder side) ──────────────────────────────────────

use crate::sync::types::PairDecision;

#[tauri::command]
pub fn approve_pair_request(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    let mut guard = state.pending_pairs.lock();
    if let Some(tx) = guard.remove(&request_id) {
        let _ = tx.send(PairDecision::Approve);
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "pair request {request_id} expired or unknown"
        )))
    }
}

#[tauri::command]
pub fn decline_pair_request(
    state: State<'_, AppState>,
    request_id: String,
) -> AppResult<()> {
    let mut guard = state.pending_pairs.lock();
    if let Some(tx) = guard.remove(&request_id) {
        let _ = tx.send(PairDecision::Decline);
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "pair request {request_id} expired or unknown"
        )))
    }
}
