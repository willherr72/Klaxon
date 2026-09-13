//! One version-negotiated Iroh connection per sync pass, with one stream per RPC.
use crate::db::sync_log::{Batch, Cursor};
use crate::error::{AppError, AppResult};
use crate::sync::proto::{
    self, PairAck, PairOffer, RpcEnvelope, RpcRequest, RpcResponse, ALPN_LEGACY, ALPN_PAIR,
    ALPN_SYNC,
};
use crate::sync::types::PingResponse;
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};
use std::collections::BTreeSet;
use std::str::FromStr;
use std::time::{Duration, Instant};

const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
const RPC_TIMEOUT: Duration = Duration::from_secs(8);
const PAIR_DIAL_TIMEOUT: Duration = Duration::from_secs(15);

pub struct DialInfo {
    pub duration_ms: u64,
    pub used_relay: bool,
    pub remote_addrs_json: Option<String>,
}

pub struct Session {
    conn: Connection,
    secret: String,
    pub peer_version: String,
    pub dial: DialInfo,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.conn.close(0u32.into(), b"sync pass ended");
    }
}

async fn request(
    conn: &Connection,
    secret: &str,
    req: RpcRequest,
    phase: &str,
) -> AppResult<RpcResponse> {
    tokio::time::timeout(RPC_TIMEOUT, async {
        let (mut send, mut recv) = conn
            .open_bi()
            .await
            .map_err(|e| AppError::Invalid(format!("{phase}: open stream failed: {e}")))?;
        proto::write_frame(
            &mut send,
            &RpcEnvelope {
                secret: secret.into(),
                request: req,
            },
        )
        .await?;
        send.finish()
            .map_err(|e| AppError::Invalid(format!("{phase}: finish request: {e}")))?;
        let response: RpcResponse = proto::read_frame(&mut recv).await?;
        match response {
            RpcResponse::Error(message) => Err(AppError::Invalid(format!("{phase}: {message}"))),
            response => Ok(response),
        }
    })
    .await
    .map_err(|_| AppError::Invalid(format!("{phase} timed out after 8s; retrying")))?
}

impl Session {
    pub async fn connect(
        endpoint: &Endpoint,
        node_id: &str,
        seeds: &[TransportAddr],
        secret: &str,
    ) -> AppResult<Self> {
        let id = EndpointId::from_str(node_id)
            .map_err(|e| AppError::Invalid(format!("invalid endpoint id: {e}")))?;
        let addr = EndpointAddr {
            id,
            addrs: seeds.iter().cloned().collect::<BTreeSet<_>>(),
        };
        let started = Instant::now();
        let connected =
            tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(addr.clone(), ALPN_SYNC)).await;
        let conn = match connected {
            Ok(Ok(conn)) => conn,
            failed => {
                // Only a successful legacy exchange identifies an old app. An offline
                // phone remains a transport error, never a guessed version mismatch.
                let legacy = tokio::time::timeout(Duration::from_secs(3), async {
                    let conn = endpoint.connect(addr, ALPN_LEGACY).await.ok()?;
                    let response = request(
                        &conn,
                        secret,
                        RpcRequest::Hello {
                            app_version: env!("CARGO_PKG_VERSION").into(),
                        },
                        "version check",
                    )
                    .await;
                    conn.close(0u32.into(), b"version check finished");
                    match response.ok()? {
                        RpcResponse::Hello { app_version } => Some(app_version),
                        _ => None,
                    }
                })
                .await;
                if let Ok(Some(version)) = legacy {
                    return Err(AppError::Invalid(format!(
                        "Peer runs Klaxon {version}. {}",
                        proto::UPDATE_REQUIRED
                    )));
                }
                let detail = match failed {
                    Ok(Err(e)) => e.to_string(),
                    _ => "connect timed out after 5s".into(),
                };
                return Err(AppError::Invalid(format!("Iroh connection unavailable: {detail}. The other device may be asleep or offline; retrying.")));
            }
        };
        let path_info = conn.paths();
        let paths: Vec<TransportAddr> = path_info.iter().map(|p| p.remote_addr().clone()).collect();
        let dial = DialInfo {
            duration_ms: started.elapsed().as_millis() as u64,
            used_relay: !path_info.is_empty() && path_info.iter().all(|p| p.is_relay()),
            remote_addrs_json: serde_json::to_string(&paths)
                .ok()
                .filter(|_| !paths.is_empty()),
        };
        let mut session = Self {
            conn,
            secret: secret.into(),
            peer_version: String::new(),
            dial,
        };
        let hello = request(
            &session.conn,
            &session.secret,
            RpcRequest::HelloV1 {
                protocol: proto::PROTOCOL_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
            },
            "protocol negotiation",
        )
        .await?;
        match hello {
            RpcResponse::HelloV1 {
                protocol,
                app_version,
            } => {
                proto::validate_protocol(protocol)?;
                session.peer_version = app_version;
            }
            _ => {
                return Err(AppError::Invalid(format!(
                    "Unexpected protocol negotiation response. {}",
                    proto::UPDATE_REQUIRED
                )))
            }
        }
        Ok(session)
    }

    pub async fn pull(&self, since: Option<Cursor>) -> AppResult<Batch> {
        match request(
            &self.conn,
            &self.secret,
            RpcRequest::PullV1 { since },
            "receive changes",
        )
        .await?
        {
            RpcResponse::PullV1(batch) => Ok(batch),
            _ => Err(AppError::Invalid(
                "Unexpected receive-changes response".into(),
            )),
        }
    }

    pub async fn push(&self, batch: Batch) -> AppResult<Cursor> {
        let expected = batch.cursor.clone();
        match request(
            &self.conn,
            &self.secret,
            RpcRequest::PushV1(batch),
            "send changes",
        )
        .await?
        {
            RpcResponse::PushV1 { cursor }
                if cursor.epoch == expected.epoch && cursor.revision == expected.revision =>
            {
                Ok(cursor)
            }
            _ => Err(AppError::Invalid(
                "Peer did not acknowledge the transmitted delivery cursor; changes will be retried"
                    .into(),
            )),
        }
    }
}

pub async fn ping(
    endpoint: &Endpoint,
    node_id: &str,
    seeds: &[TransportAddr],
    secret: &str,
) -> AppResult<PingResponse> {
    let session = Session::connect(endpoint, node_id, seeds, secret).await?;
    match request(&session.conn, &session.secret, RpcRequest::Ping, "ping").await? {
        RpcResponse::Pong(pong) => Ok(pong),
        _ => Err(AppError::Invalid("Unexpected ping response".into())),
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

    let conn = tokio::time::timeout(PAIR_DIAL_TIMEOUT, endpoint.connect(id, ALPN_PAIR))
        .await
        .map_err(|_| {
            AppError::Invalid(format!(
                "pair connect timed out after {PAIR_DIAL_TIMEOUT:?}"
            ))
        })?
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
