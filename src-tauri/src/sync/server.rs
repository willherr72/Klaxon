use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Deserialize;

use crate::db::{peers, reminders as repo, tombstones};
use crate::models::now_ms;
use crate::sync::types::{
    ChangeSet, PingResponse, PushResponse, RemoteReminder, RemoteTombstone,
};
use crate::sync::DeviceIdentity;

#[derive(Clone)]
pub struct ServerState {
    pub db: Arc<Mutex<Connection>>,
    pub identity: DeviceIdentity,
}

pub async fn run(state: ServerState, port: u16) -> std::io::Result<()> {
    let auth_state = state.clone();
    let api = Router::new()
        .route("/ping", get(handle_ping))
        .route("/sync/pull", get(handle_pull))
        .route("/sync/push", post(handle_push))
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware));

    let app = Router::new().nest("/klaxon/v1", api).with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    log::info!("sync server listening on 0.0.0.0:{port}");
    axum::serve(listener, app).await
}

async fn auth_middleware(
    State(s): State<ServerState>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|s| s.to_string());

    let Some(token) = token else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    let valid = {
        let conn = s.db.lock();
        let peer_id: Option<String> = conn
            .query_row(
                "SELECT id FROM peers WHERE shared_secret = ?1",
                rusqlite::params![token],
                |r| r.get::<_, String>(0),
            )
            .ok();
        if let Some(pid) = &peer_id {
            let _ = peers::touch_seen(&conn, pid);
        }
        peer_id.is_some()
    };

    if !valid {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

async fn handle_ping(State(s): State<ServerState>) -> Json<PingResponse> {
    Json(PingResponse {
        device_id: s.identity.device_id.clone(),
        device_name: s.identity.device_name.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        server_time_ms: now_ms(),
    })
}

#[derive(Deserialize)]
struct PullQuery {
    since: Option<i64>,
}

async fn handle_pull(
    State(s): State<ServerState>,
    Query(q): Query<PullQuery>,
) -> Result<Json<ChangeSet>, StatusCode> {
    let since = q.since.unwrap_or(0);
    let conn = s.db.lock();

    let reminders = repo::updated_since(&conn, since)
        .map_err(|e| {
            log::error!("pull list reminders: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .iter()
        .map(RemoteReminder::from)
        .collect();

    let ts = tombstones::dirty_since(&conn, since)
        .map_err(|e| {
            log::error!("pull list tombstones: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })?
        .iter()
        .map(RemoteTombstone::from)
        .collect();

    Ok(Json(ChangeSet {
        server_time_ms: now_ms(),
        reminders,
        tombstones: ts,
    }))
}

async fn handle_push(
    State(s): State<ServerState>,
    Json(set): Json<ChangeSet>,
) -> Result<Json<PushResponse>, StatusCode> {
    let conn = s.db.lock();
    let mut accepted_reminders = 0usize;
    let mut accepted_tombstones = 0usize;

    for r in &set.reminders {
        match repo::apply_remote(&conn, r) {
            Ok(true) => accepted_reminders += 1,
            Ok(false) => {}
            Err(e) => log::warn!("apply remote reminder {}: {e}", r.id),
        }
    }

    for t in &set.tombstones {
        match tombstones::apply_remote(&conn, &t.id, t.deleted_at) {
            Ok(()) => accepted_tombstones += 1,
            Err(e) => log::warn!("apply remote tombstone {}: {e}", t.id),
        }
    }

    Ok(Json(PushResponse {
        server_time_ms: now_ms(),
        accepted_reminders,
        accepted_tombstones,
    }))
}
