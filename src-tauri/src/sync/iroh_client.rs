//! Client side of the v0.3 RPC over iroh streams.
//!
//! Given a local `Endpoint` and a paired peer's `iroh_node_id` +
//! `shared_secret`, this module dials the peer on the `klaxon/sync/0`
//! ALPN, opens a bidi stream, writes one `RpcEnvelope`, and reads one
//! `RpcResponse`. Connections are one-shot for now — every call dials
//! fresh. Phase 3b can cache `Connection` handles on the sync task once
//! we measure the overhead matters.

use std::str::FromStr;
use std::time::Duration;

use iroh::{Endpoint, EndpointId};

use crate::error::{AppError, AppResult};
use crate::sync::proto::{self, RpcEnvelope, RpcRequest, RpcResponse, ALPN_SYNC};
use crate::sync::types::{ChangeSet, PingResponse, PushResponse};

const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
const RPC_TIMEOUT: Duration = Duration::from_secs(15);

/// Make a single RPC call to the peer at `node_id`, authenticating with
/// `shared_secret`. Returns the decoded `RpcResponse`. Caller decides
/// whether `Error(_)` is fatal or expected (e.g. "unauthorized").
async fn call(
    endpoint: &Endpoint,
    node_id: &str,
    shared_secret: &str,
    request: RpcRequest,
) -> AppResult<RpcResponse> {
    let id = EndpointId::from_str(node_id)
        .map_err(|e| AppError::Invalid(format!("invalid iroh node_id {node_id:?}: {e}")))?;

    let conn = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(id, ALPN_SYNC))
        .await
        .map_err(|_| AppError::Invalid(format!("iroh connect timed out after {DIAL_TIMEOUT:?}")))?
        .map_err(|e| AppError::Invalid(format!("iroh connect failed: {e}")))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| AppError::Invalid(format!("open bi: {e}")))?;

    let env = RpcEnvelope {
        secret: shared_secret.to_string(),
        request,
    };
    proto::write_frame(&mut send, &env).await?;
    let _ = send.finish();

    let resp: RpcResponse = tokio::time::timeout(RPC_TIMEOUT, proto::read_frame(&mut recv))
        .await
        .map_err(|_| AppError::Invalid(format!("rpc read timed out after {RPC_TIMEOUT:?}")))??;

    // Drop the connection cleanly. We don't reuse it for phase 3a.
    conn.close(0u32.into(), b"done");

    Ok(resp)
}

/// Convenience: Ping the peer and return its PingResponse, mapping the
/// auth/unimplemented error variants to AppError so callers don't have
/// to unwrap themselves.
pub async fn ping(
    endpoint: &Endpoint,
    node_id: &str,
    shared_secret: &str,
) -> AppResult<PingResponse> {
    match call(endpoint, node_id, shared_secret, RpcRequest::Ping).await? {
        RpcResponse::Pong(p) => Ok(p),
        RpcResponse::Error(msg) => Err(AppError::Invalid(format!("peer rejected ping: {msg}"))),
        other => Err(AppError::Invalid(format!(
            "expected Pong, got {other:?}"
        ))),
    }
}

pub async fn pull(
    endpoint: &Endpoint,
    node_id: &str,
    shared_secret: &str,
    since: i64,
) -> AppResult<ChangeSet> {
    match call(endpoint, node_id, shared_secret, RpcRequest::Pull { since }).await? {
        RpcResponse::Pull(cs) => Ok(cs),
        RpcResponse::Error(msg) => Err(AppError::Invalid(format!("peer rejected pull: {msg}"))),
        other => Err(AppError::Invalid(format!("expected Pull, got {other:?}"))),
    }
}

pub async fn push(
    endpoint: &Endpoint,
    node_id: &str,
    shared_secret: &str,
    set: ChangeSet,
) -> AppResult<PushResponse> {
    match call(endpoint, node_id, shared_secret, RpcRequest::Push(set)).await? {
        RpcResponse::Push(ack) => Ok(ack),
        RpcResponse::Error(msg) => Err(AppError::Invalid(format!("peer rejected push: {msg}"))),
        other => Err(AppError::Invalid(format!("expected Push, got {other:?}"))),
    }
}
