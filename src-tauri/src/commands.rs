use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::alerts;
use crate::db::thoughts::{TagCount, ThoughtHit};
use crate::db::{peers as peer_repo, reminders as repo, settings as cfg, thoughts};
use crate::error::{AppError, AppResult};
use crate::models::{
    now_ms, Reminder, ReminderCreate, ReminderState, ReminderUpdate, Thought, ThoughtCreate,
    ThoughtUpdate,
};
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

/// Push-on-write: poke the sync loop after a local mutation so the change
/// leaves this device in ~seconds instead of waiting for the 20s tick.
/// Failures are impossible in practice (unbounded channel); ignore them.
fn nudge_write(state: &State<'_, AppState>) {
    let _ = state.sync_nudge.send(crate::sync::trigger::Nudge::Write);
}

#[tauri::command]
pub fn create_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    input: ReminderCreate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::create(&conn, input)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
    Ok(r)
}

#[tauri::command]
pub fn update_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    patch: ReminderUpdate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::update(&conn, &id, patch)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    // Announce the change instead of trusting the caller to re-fetch. The
    // editor happens to call refresh() after saving, which masked this;
    // the Tasks board's star control has no such path, so its cards
    // rendered stale priorities even though the write had landed. Every
    // reminder-mutating command emits now, so no caller has to know.
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
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
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
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
    // The alarm window and the Android notification actions are separate
    // callers with no way to refresh the main window's list — without this
    // the countdown there keeps showing the pre-snooze time.
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
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
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
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
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
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

/// Desktop-only. The global-shortcut plugin doesn't exist on Android/iOS
/// and the underlying OS APIs (e.g. RegisterHotKey on Windows) have no
/// mobile equivalent. The mobile UI hides the relevant Settings row.
#[cfg(desktop)]
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
    crate::install_global_hotkey(
        &app,
        &state.current_hotkey,
        &combo,
        crate::HotkeyAction::NewReminder,
    )
}

/// Re-register the thought-capture hotkey. An empty string clears it.
/// Desktop only, same as `set_global_hotkey`.
#[cfg(desktop)]
#[tauri::command]
pub fn set_capture_hotkey(
    state: State<'_, AppState>,
    app: AppHandle,
    combo: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        cfg::set(&conn, "global_hotkey_capture", &combo)?;
    }
    crate::install_global_hotkey(
        &app,
        &state.capture_hotkey,
        &combo,
        crate::HotkeyAction::CaptureThought,
    )
}

/// Desktop only — the in-process audio engine doesn't run on Android
/// (cpal needs the JNI context, which we don't surface). Mobile sound
/// previews would route through the notification plugin in a future
/// milestone.
#[cfg(desktop)]
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

// ── Swim lanes (v0.3.1) ──────────────────────────────────────────────

use crate::db::task_lanes::{self, Lane};

#[tauri::command]
pub fn list_lanes(state: State<'_, AppState>) -> AppResult<Vec<Lane>> {
    let conn = state.db.lock();
    task_lanes::list_all(&conn)
}

#[tauri::command]
pub fn create_lane(
    state: State<'_, AppState>,
    app: AppHandle,
    name: String,
) -> AppResult<Lane> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("lane name required".into()));
    }
    let now = now_ms();
    let lane = {
        let conn = state.db.lock();
        let existing = task_lanes::list_all(&conn)?;
        let next_order = existing
            .iter()
            .map(|l| l.order_index)
            .max()
            .map(|m| m + 1)
            .unwrap_or(0);
        let lane = Lane {
            id: uuid::Uuid::new_v4().to_string(),
            name: trimmed.to_string(),
            order_index: next_order,
            is_default: false,
            created_at: now,
            updated_at: now,
        };
        task_lanes::insert(&conn, &lane)?;
        lane
    };
    let _ = app.emit("klaxon://lanes-changed", ());
    nudge_write(&state);
    Ok(lane)
}

#[tauri::command]
pub fn rename_lane(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    name: String,
) -> AppResult<Lane> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("lane name required".into()));
    }
    let lane = {
        let conn = state.db.lock();
        let existing = task_lanes::get_by_id(&conn, &id)?
            .ok_or_else(|| AppError::NotFound(format!("lane {id}")))?;
        task_lanes::update(
            &conn,
            &id,
            trimmed,
            existing.order_index,
            now_ms(),
        )?;
        task_lanes::get_by_id(&conn, &id)?
            .ok_or_else(|| AppError::NotFound(format!("lane {id}")))?
    };
    let _ = app.emit("klaxon://lanes-changed", ());
    nudge_write(&state);
    Ok(lane)
}

/// Result of a `delete_lane` call — surfaces how many tasks got
/// cascaded to the default lane so the UI can confirm the user's
/// "this will move N tasks" warning was accurate.
#[derive(Debug, Clone, Serialize)]
pub struct DeleteLaneOutcome {
    pub tasks_moved: usize,
}

#[tauri::command]
pub fn delete_lane(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<DeleteLaneOutcome> {
    let outcome = {
        let conn = state.db.lock();
        let lane = task_lanes::get_by_id(&conn, &id)?
            .ok_or_else(|| AppError::NotFound(format!("lane {id}")))?;
        if lane.is_default {
            return Err(AppError::Invalid(
                "cannot delete the default lane — rename it or move tasks to it instead"
                    .into(),
            ));
        }
        let default_id = task_lanes::default_lane(&conn)?.id;
        // Cascade tasks: re-home everything in this lane onto the
        // default lane. updated_at bumps so each row syncs naturally
        // on the next tick.
        let now = now_ms();
        let moved = conn.execute(
            "UPDATE reminders
                SET task_lane_id = ?2, updated_at = ?3
              WHERE task_lane_id = ?1",
            rusqlite::params![id, default_id, now],
        )?;
        task_lanes::delete(&conn, &id)?;
        // Tombstone uses the shared tombstones table so peers learn
        // to drop the lane too.
        crate::db::tombstones::create(&conn, &id, now)?;
        DeleteLaneOutcome {
            tasks_moved: moved,
        }
    };
    let _ = app.emit("klaxon://lanes-changed", ());
    nudge_write(&state);
    let _ = app.emit("klaxon://reminders-changed", ());
    Ok(outcome)
}

#[tauri::command]
pub fn reorder_lanes(
    state: State<'_, AppState>,
    app: AppHandle,
    ids: Vec<String>,
) -> AppResult<()> {
    let now = now_ms();
    {
        let conn = state.db.lock();
        for (idx, id) in ids.iter().enumerate() {
            let lane = task_lanes::get_by_id(&conn, id)?
                .ok_or_else(|| AppError::NotFound(format!("lane {id}")))?;
            // Only bump if the position actually changed — saves
            // unnecessary updated_at churn and spurious sync traffic.
            if lane.order_index != idx as i64 {
                task_lanes::update(&conn, id, &lane.name, idx as i64, now)?;
            }
        }
    }
    let _ = app.emit("klaxon://lanes-changed", ());
    nudge_write(&state);
    Ok(())
}

#[tauri::command]
pub fn place_task(
    state: State<'_, AppState>,
    app: AppHandle,
    reminder_id: String,
    lane_id: String,
    before_id: Option<String>,
    after_id: Option<String>,
) -> AppResult<Reminder> {
    let trimmed = lane_id.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("lane_id required".into()));
    }
    let updated = {
        let conn = state.db.lock();
        // Validate the lane exists so a stale UI state doesn't write a
        // dangling FK.
        if task_lanes::get_by_id(&conn, trimmed)?.is_none() {
            return Err(AppError::NotFound(format!("lane {trimmed}")));
        }
        repo::place(
            &conn,
            &reminder_id,
            trimmed,
            before_id.as_deref(),
            after_id.as_deref(),
        )?
    };
    let _ = app.emit("klaxon://reminders-changed", ());
    nudge_write(&state);
    Ok(updated)
}

#[tauri::command]
pub fn sort_lane_by_stars(
    state: State<'_, AppState>,
    app: AppHandle,
    lane_id: String,
) -> AppResult<usize> {
    let changed = {
        let conn = state.db.lock();
        // Validate the lane exists — matches place_task's style, so a
        // garbage lane id errors instead of silently returning 0.
        if task_lanes::get_by_id(&conn, &lane_id)?.is_none() {
            return Err(AppError::NotFound(format!("lane {lane_id}")));
        }
        repo::sort_lane_by_stars(&conn, &lane_id)?
    };
    if changed > 0 {
        let _ = app.emit("klaxon://reminders-changed", ());
        nudge_write(&state);
    }
    Ok(changed)
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
    /// v0.5.1 sync evidence — drives the per-peer status row in Settings.
    pub last_sync_ok_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub last_sync_error_at: Option<i64>,
    /// v0.7.1: peer's app version from the Hello exchange; None = never
    /// learned (pre-0.7.1 peer or no sync since our upgrade).
    pub last_app_version: Option<String>,
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
            last_sync_ok_at: p.last_sync_ok_at,
            last_sync_error: p.last_sync_error,
            last_sync_error_at: p.last_sync_error_at,
            last_app_version: p.last_app_version,
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
        endpoint_addrs_json: None,
        last_sync_ok_at: None,
        last_sync_error: None,
        last_sync_error_at: None,
        last_app_version: None,
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
        last_sync_ok_at: None,
        last_sync_error: None,
        last_sync_error_at: None,
        last_app_version: None,
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
    sync::iroh_client::ping(&endpoint, &node_id, &[], &secret).await
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

/// Run one sync pass immediately. Frontend calls this when the mobile
/// app comes back to the foreground so the user doesn't have to wait
/// up to SYNC_INTERVAL (20s) before seeing fresh data from peers.
#[tauri::command]
pub async fn sync_now(app: AppHandle) -> AppResult<()> {
    use tauri::Manager;
    let db = {
        let st: State<'_, AppState> = app.state();
        st.db.clone()
    };
    crate::sync::task::run_one_pass(&db, &app).await;
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

/// Start a pair handshake with the peer at `peer_node_id` over the iroh
/// `klaxon/pair/0` ALPN. The same command serves both flows:
///   - mDNS tap-to-pair — UI passes the node_id from a `DiscoveredPeer`.
///   - Ticket pairing — UI passes a node_id the user pasted (from a QR
///     scan or copy-paste).
/// The peer's `device_id` is no longer required up front; we learn it
/// from the `PairAck`.
#[tauri::command]
pub async fn start_pair_with(
    state: State<'_, AppState>,
    app: AppHandle,
    peer_node_id: String,
    peer_name: String,
) -> AppResult<crate::sync::types::PairOutcome> {
    use crate::sync::proto::{PairAck, PairOffer};
    use crate::sync::types::PairOutcome;

    let peer_node_id = peer_node_id.trim().to_string();
    if peer_node_id.is_empty() {
        return Err(AppError::Invalid("peer iroh node id is required".into()));
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

    let sas = sync::confirmation_code(&request_id, &ephemeral, &our_node_id, &peer_node_id);

    let _ = app.emit(
        "klaxon://pair-progress",
        serde_json::json!({
            "request_id": request_id,
            "peer_node_id": peer_node_id,
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
                    endpoint_addrs_json: None,
                    last_sync_ok_at: None,
                    last_sync_error: None,
                    last_sync_error_at: None,
                    last_app_version: None,
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

// ── Thoughts (v0.5) ──────────────────────────────────────────────────

/// The feed, newest first. `tag` narrows to a single tag when present.
#[tauri::command]
pub fn list_thoughts(
    state: State<'_, AppState>,
    tag: Option<String>,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<Thought>> {
    let conn = state.db.lock();
    match tag.as_deref() {
        Some(t) => thoughts::list_by_tag(&conn, t, limit, offset),
        None => thoughts::list(&conn, limit, offset),
    }
}

#[tauri::command]
pub fn search_thoughts(
    state: State<'_, AppState>,
    query: String,
    tag: Option<String>,
    limit: i64,
    offset: i64,
) -> AppResult<Vec<ThoughtHit>> {
    let conn = state.db.lock();
    thoughts::search(&conn, &query, tag.as_deref(), limit, offset)
}

#[tauri::command]
pub fn create_thought(
    state: State<'_, AppState>,
    app: AppHandle,
    input: ThoughtCreate,
) -> AppResult<Thought> {
    let thought = {
        let conn = state.db.lock();
        thoughts::create(&conn, input)?
    };
    let _ = app.emit("klaxon://thoughts-changed", ());
    nudge_write(&state);
    Ok(thought)
}

#[tauri::command]
pub fn update_thought(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    patch: ThoughtUpdate,
) -> AppResult<Thought> {
    let thought = {
        let conn = state.db.lock();
        thoughts::update(&conn, &id, patch)?
    };
    let _ = app.emit("klaxon://thoughts-changed", ());
    nudge_write(&state);
    Ok(thought)
}

/// `thoughts::delete` writes the tombstone, so paired devices drop their
/// copy on the next sync.
#[tauri::command]
pub fn delete_thought(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        thoughts::delete(&conn, &id)?;
    }
    let _ = app.emit("klaxon://thoughts-changed", ());
    nudge_write(&state);
    Ok(())
}

#[tauri::command]
pub fn thought_tag_counts(state: State<'_, AppState>) -> AppResult<Vec<TagCount>> {
    let conn = state.db.lock();
    thoughts::tag_counts(&conn)
}

/// Mobile: re-arm OS notifications from the current reminders table.
/// Called by the webview on launch and after reminders-changed — the
/// same trigger points the old JS reconcile used. The arming decision
/// itself lives in alarm_plan.rs, shared with the cold and warm
/// background sync passes.
#[cfg(mobile)]
#[tauri::command]
pub fn reconcile_notifications(state: State<'_, AppState>) -> AppResult<()> {
    crate::os_alarms::reconcile_os_alarms(&state.db)
}
