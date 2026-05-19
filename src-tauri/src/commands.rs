use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::alerts;
use crate::db::{peers as peer_repo, reminders as repo, settings as cfg};
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, Reminder, ReminderCreate, ReminderState, ReminderUpdate};
use crate::scheduler::SchedulerMsg;
use crate::sync;
use crate::sync::client::SyncClient;
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
    pub sync_port: u16,
    pub sync_url_hint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub last_pull_at: i64,
    pub last_push_at: i64,
    pub last_seen_at: Option<i64>,
    /// Set iff this peer was paired on a v0.3 build — used by the UI to
    /// enable the "Ping (iroh)" action.
    pub iroh_node_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AddPeerInput {
    pub id: String,
    pub name: String,
    pub url: String,
    pub shared_secret: String,
    #[serde(default)]
    pub cert_fingerprint: Option<String>,
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
            url: p.url,
            last_pull_at: p.last_pull_at,
            last_push_at: p.last_push_at,
            last_seen_at: p.last_seen_at,
            iroh_node_id: p.iroh_node_id,
        })
        .collect())
}

#[tauri::command]
pub fn add_peer(state: State<'_, AppState>, input: AddPeerInput) -> AppResult<PeerView> {
    if input.id.trim().is_empty() {
        return Err(AppError::Invalid("peer id required".into()));
    }
    if input.url.trim().is_empty() {
        return Err(AppError::Invalid("peer url required".into()));
    }
    if input.shared_secret.trim().is_empty() {
        return Err(AppError::Invalid("shared secret required".into()));
    }
    let peer = peer_repo::Peer {
        id: input.id.trim().to_string(),
        name: input.name.trim().to_string(),
        url: input.url.trim().to_string(),
        shared_secret: input.shared_secret.trim().to_string(),
        last_pull_at: 0,
        last_push_at: 0,
        created_at: now_ms(),
        last_seen_at: None,
        cert_fingerprint: input
            .cert_fingerprint
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        iroh_node_id: None,
    };
    {
        let conn = state.db.lock();
        peer_repo::upsert(&conn, &peer)?;
    }
    Ok(PeerView {
        id: peer.id,
        name: peer.name,
        url: peer.url,
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

#[tauri::command]
pub async fn ping_peer(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<PingResponse> {
    let (url, secret, fp) = {
        let conn = state.db.lock();
        let peers = peer_repo::list_all(&conn)?;
        let p = peers
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::NotFound(format!("peer {id}")))?;
        (p.url, p.shared_secret, p.cert_fingerprint.unwrap_or_default())
    };
    let client = SyncClient::new(url, secret, &fp)?;
    client.ping().await
}

/// v0.3 phase 3a — ping a paired peer over the iroh transport instead of
/// HTTPS. Fails fast if the peer has no `iroh_node_id` (paired pre-v0.3)
/// or if our local iroh endpoint isn't up.
#[tauri::command]
pub async fn ping_peer_iroh(
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
                "peer has no iroh node id — was paired on a pre-v0.3 build, re-pair to enable"
                    .into(),
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
    let port = sync::read_port(&state.db);
    let enabled = sync::read_enabled(&state.db);
    let url_hint = match local_ip_address::local_ip() {
        Ok(ip) => format!("http://{ip}:{port}"),
        Err(_) => format!("http://<this-device-ip>:{port}"),
    };
    Ok(DeviceInfo {
        device_id: identity.device_id,
        device_name: identity.device_name,
        sync_enabled: enabled,
        sync_port: port,
        sync_url_hint: url_hint,
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

#[tauri::command]
pub async fn start_pair_with(
    state: State<'_, AppState>,
    app: AppHandle,
    peer_url: String,
    peer_id: String,
    peer_name: String,
    peer_cert_fingerprint: String,
) -> AppResult<crate::sync::types::PairOutcome> {
    use std::time::Duration;

    use crate::sync::types::{PairOutcome, PairRequest, PairResponse};

    if peer_cert_fingerprint.trim().is_empty() {
        return Err(AppError::Invalid(
            "peer must advertise a TLS fingerprint via mDNS to be paired".into(),
        ));
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let ephemeral = sync::generate_secret();

    let our = sync::read_identity(&state.db);
    let port = sync::read_port(&state.db);
    let our_url = sync::local_url(port);
    let our_fp = state
        .local_cert
        .lock()
        .as_ref()
        .map(|c| c.fingerprint.clone())
        .ok_or_else(|| AppError::Invalid("local cert not yet ready".into()))?;

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

    let our_iroh_node_id = state
        .iroh_node
        .lock()
        .as_ref()
        .map(|n| n.node_id.clone());
    let req = PairRequest {
        request_id: request_id.clone(),
        initiator_id: our.device_id.clone(),
        initiator_name: our.device_name.clone(),
        initiator_url: our_url,
        ephemeral_token: ephemeral,
        initiator_cert_fingerprint: our_fp,
        initiator_iroh_node_id: our_iroh_node_id,
    };

    let tls_config = sync::tls::pinned_client_config(&peer_cert_fingerprint);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(150))
        .connect_timeout(Duration::from_secs(5))
        .use_preconfigured_tls((*tls_config).clone())
        .build()
        .map_err(|e| AppError::Invalid(format!("http client: {e}")))?;

    let url = format!(
        "{}/klaxon/v1/pair/initiate",
        peer_url.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .json(&req)
        .send()
        .await
        .map_err(|e| AppError::Invalid(format!("pair request failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Invalid(match status.as_u16() {
            403 => "peer declined the pairing".to_string(),
            408 => "peer did not respond in time".to_string(),
            other => format!("peer returned HTTP {other}"),
        }));
    }

    let body: PairResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Invalid(format!("parse pair response: {e}")))?;

    if !body
        .responder_cert_fingerprint
        .eq_ignore_ascii_case(&peer_cert_fingerprint)
    {
        return Err(AppError::Invalid(
            "peer's reported fingerprint disagrees with mDNS — refusing to pair".into(),
        ));
    }

    {
        let conn = state.db.lock();
        let peer = peer_repo::Peer {
            id: body.responder_id.clone(),
            name: if peer_name.trim().is_empty() {
                body.responder_name.clone()
            } else {
                peer_name.clone()
            },
            url: body.responder_url,
            shared_secret: body.shared_secret,
            last_pull_at: 0,
            last_push_at: 0,
            created_at: now_ms(),
            last_seen_at: Some(now_ms()),
            cert_fingerprint: Some(body.responder_cert_fingerprint.clone()),
            iroh_node_id: body.responder_iroh_node_id.clone(),
        };
        peer_repo::upsert(&conn, &peer)?;
    }

    let _ = app.emit("klaxon://peer-paired", body.responder_id.clone());

    Ok(PairOutcome {
        peer_id: body.responder_id,
        peer_name: body.responder_name,
        confirmation_code: sas,
    })
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
