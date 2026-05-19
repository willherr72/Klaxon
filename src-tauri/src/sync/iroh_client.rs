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
use crate::sync::proto::{
    self, PairAck, PairOffer, RpcEnvelope, RpcRequest, RpcResponse, ALPN_PAIR, ALPN_SYNC,
};
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

/// Initiate a pair handshake with the peer at `node_id`. Returns the
/// responder's `PairAck` — caller is responsible for matching the SAS
/// against what they're showing the user and for persisting the new
/// peer on `Approved`.
///
/// This rides the `klaxon/pair/0` ALPN — there's no shared secret yet,
/// so this is the only RPC path that's unauthenticated. The user's
/// explicit Approve/Decline on each device is the only authorization.
pub async fn pair_initiate(
    endpoint: &Endpoint,
    node_id: &str,
    offer: PairOffer,
) -> AppResult<PairAck> {
    let id = EndpointId::from_str(node_id)
        .map_err(|e| AppError::Invalid(format!("invalid iroh node_id {node_id:?}: {e}")))?;

    // Pair flow needs to wait up to ~2 minutes for the remote user to
    // approve, so this gets a generous timeout that just outlasts the
    // server-side 120s window.
    let pair_timeout = Duration::from_secs(150);

    let conn = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(id, ALPN_PAIR))
        .await
        .map_err(|_| AppError::Invalid(format!("pair connect timed out after {DIAL_TIMEOUT:?}")))?
        .map_err(|e| AppError::Invalid(format!("pair connect failed: {e}")))?;

    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| AppError::Invalid(format!("pair open bi: {e}")))?;

    proto::write_frame(&mut send, &offer).await?;
    let _ = send.finish();

    let ack: PairAck = tokio::time::timeout(pair_timeout, proto::read_frame(&mut recv))
        .await
        .map_err(|_| AppError::Invalid(format!("pair wait timed out after {pair_timeout:?}")))??;

    conn.close(0u32.into(), b"done");
    Ok(ack)
}
