use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_server::tls_rustls::RustlsConfig;
use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::db::peers;
use crate::models::now_ms;
use crate::sync::tls::LocalCert;
use crate::sync::types::{
    ChangeSet, PairDecision, PairRequest, PairResponse, PendingPairEvent, PingResponse,
    PushResponse,
};
use crate::sync::DeviceIdentity;

pub type PendingPairs =
    Arc<Mutex<HashMap<String, oneshot::Sender<PairDecision>>>>;

#[derive(Clone)]
pub struct ServerState {
    pub db: Arc<Mutex<Connection>>,
    pub identity: DeviceIdentity,
    pub pending_pairs: PendingPairs,
    pub app: AppHandle,
    pub local_cert: LocalCert,
}

pub async fn run(state: ServerState, port: u16) -> std::io::Result<()> {
    let auth_state = state.clone();
    let cert_pem = state.local_cert.cert_pem.clone();
    let key_pem = state.local_cert.key_pem.clone();
    let fp = state.local_cert.fingerprint.clone();

    let authed = Router::new()
        .route("/ping", get(handle_ping))
        .route("/sync/pull", get(handle_pull))
        .route("/sync/push", post(handle_push))
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware));

    // Pair handshake endpoint is intentionally unauthenticated — it IS the
    // pre-auth handshake. Defended by the explicit user-confirmation step.
    let app = Router::new()
        .route(
            "/klaxon/v1/pair/initiate",
            post(handle_pair_initiate),
        )
        .nest("/klaxon/v1", authed)
        .with_state(state);

    let tls_config = RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    log::info!(
        "sync server listening on https://0.0.0.0:{port} (fp {})",
        crate::sync::tls::short(&fp)
    );

    axum_server::bind_rustls(addr, tls_config)
        .serve(app.into_make_service())
        .await
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
    Json(crate::sync::ops::ping(&s.identity))
}

#[derive(Deserialize)]
struct PullQuery {
    since: Option<i64>,
}

async fn handle_pull(
    State(s): State<ServerState>,
    Query(q): Query<PullQuery>,
) -> Result<Json<ChangeSet>, StatusCode> {
    crate::sync::ops::pull(&s.db, q.since.unwrap_or(0))
        .map(Json)
        .map_err(|e| {
            log::error!("pull: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn handle_push(
    State(s): State<ServerState>,
    Json(set): Json<ChangeSet>,
) -> Result<Json<PushResponse>, StatusCode> {
    crate::sync::ops::push(&s.db, Some(&s.app), set)
        .map(Json)
        .map_err(|e| {
            log::error!("push: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

/// Handle an incoming pair handshake. The flow:
/// 1. Compute SAS (same on both ends), emit event so the local UI shows it
/// 2. Block on a oneshot channel for up to 120s — the local user must hit
///    Approve/Decline in the UI, which fires `approve_pair_request` /
///    `decline_pair_request` to flip the channel
/// 3. On Approve: generate a fresh shared secret, store the peer entry,
///    return our identity + the secret to the initiator
/// 4. On Decline / timeout: return 403 / 408 — initiator backs out
async fn handle_pair_initiate(
    State(s): State<ServerState>,
    Json(req): Json<PairRequest>,
) -> Result<Json<PairResponse>, StatusCode> {
    let sas = crate::sync::confirmation_code(
        &req.request_id,
        &req.ephemeral_token,
        &req.initiator_id,
        &s.identity.device_id,
    );

    let (tx, rx) = oneshot::channel::<PairDecision>();
    s.pending_pairs.lock().insert(req.request_id.clone(), tx);

    let _ = s.app.emit(
        "klaxon://pair-request",
        PendingPairEvent {
            request_id: req.request_id.clone(),
            initiator_id: req.initiator_id.clone(),
            initiator_name: req.initiator_name.clone(),
            initiator_url: req.initiator_url.clone(),
            confirmation_code: sas,
        },
    );

    let decision = tokio::time::timeout(Duration::from_secs(120), rx).await;
    s.pending_pairs.lock().remove(&req.request_id);

    let approved = matches!(decision, Ok(Ok(PairDecision::Approve)));
    if !approved {
        return Err(match decision {
            Ok(Ok(PairDecision::Decline)) => StatusCode::FORBIDDEN,
            Err(_) => StatusCode::REQUEST_TIMEOUT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        });
    }

    let secret = crate::sync::generate_secret();
    let port = crate::sync::read_port(&s.db);
    let our_url = crate::sync::local_url(port);

    let conn = s.db.lock();
    let peer = peers::Peer {
        id: req.initiator_id.clone(),
        name: if req.initiator_name.is_empty() {
            "Klaxon Device".to_string()
        } else {
            req.initiator_name.clone()
        },
        url: req.initiator_url.clone(),
        shared_secret: secret.clone(),
        last_pull_at: 0,
        last_push_at: 0,
        created_at: now_ms(),
        last_seen_at: Some(now_ms()),
        cert_fingerprint: Some(req.initiator_cert_fingerprint.clone()),
        iroh_node_id: req.initiator_iroh_node_id.clone(),
    };
    if let Err(e) = peers::upsert(&conn, &peer) {
        log::error!("store peer after pair: {e}");
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    drop(conn);

    let _ = s.app.emit("klaxon://peer-paired", peer.id.clone());

    // Our own iroh node_id, if the endpoint is up. Optional — the
    // responder can still pair without iroh (e.g. degraded startup).
    let our_node_id = {
        use tauri::Manager;
        s.app
            .try_state::<crate::AppState>()
            .and_then(|st| st.iroh_node.lock().as_ref().map(|n| n.node_id.clone()))
    };

    Ok(Json(PairResponse {
        responder_id: s.identity.device_id.clone(),
        responder_name: s.identity.device_name.clone(),
        responder_url: our_url,
        shared_secret: secret,
        responder_cert_fingerprint: s.local_cert.fingerprint.clone(),
        responder_iroh_node_id: our_node_id,
    }))
}
