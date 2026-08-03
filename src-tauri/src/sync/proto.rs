//! Klaxon RPC wire protocol for the v0.3 iroh transport.
//!
//! Every RPC call rides one bidi stream on the `klaxon/sync/0` ALPN. The
//! caller writes a single `RpcEnvelope` frame and reads a single
//! `RpcResponse` frame back — no streaming, no out-of-order pipelining,
//! one round-trip per call. Auth lives in the envelope as the per-pair
//! shared secret so the responder can reject anything that isn't from a
//! paired peer before doing any DB work.
//!
//! Phase 2 implements Ping end-to-end and leaves Pull/Push stubbed; the
//! full sync codepath cuts over to this transport in phase 3.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::sync::types::{ChangeSet, PingResponse, PushResponse};

/// ALPN identifier handshook between iroh peers. Bump the suffix when the
/// envelope shape changes incompatibly.
pub const ALPN_SYNC: &[u8] = b"klaxon/sync/0";

/// Pre-auth pair-handshake ALPN. Deliberately separate from `ALPN_SYNC`:
/// pairing has no shared secret yet, so the handler skips secret check —
/// keeping it on its own ALPN guards against accidental "Ping with no
/// secret" requests landing in the sync handler.
pub const ALPN_PAIR: &[u8] = b"klaxon/pair/0";

/// Body of an incoming pair-handshake stream. The initiator writes this,
/// the responder echoes a `PairAck` back. The shared secret is established
/// during the exchange — neither side has one before this point.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairOffer {
    pub request_id: String,
    pub initiator_id: String,
    pub initiator_name: String,
    pub initiator_node_id: String,
    /// Random per-attempt token, mixed into the SAS so a previous SAS
    /// can't be replayed.
    pub ephemeral_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PairAck {
    Approved {
        responder_id: String,
        responder_name: String,
        responder_node_id: String,
        shared_secret: String,
    },
    Declined,
    Error(String),
}

/// Maximum frame body we'll accept off the wire — 16 MiB is well above
/// any reasonable Klaxon ChangeSet and small enough that a malicious or
/// confused peer can't OOM us by claiming a 1 GiB length.
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcEnvelope {
    /// Shared secret the caller exchanged during pairing. The responder
    /// looks it up in `peers.shared_secret`; no match → unauthorized.
    pub secret: String,
    pub request: RpcRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RpcRequest {
    Ping,
    Pull { since: i64 },
    Push(ChangeSet),
    /// v0.7.1: version exchange. Trailing on purpose — postcard tags
    /// variants by index, so older peers decode the earlier variants
    /// unchanged and drop only the one stream carrying a Hello they
    /// can't parse (the handler's per-stream error isolation).
    Hello { app_version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RpcResponse {
    Pong(PingResponse),
    Pull(ChangeSet),
    Push(PushResponse),
    /// Responder rejected the call. `unauthorized` is the special string
    /// the client uses to surface "your shared secret didn't match".
    Error(String),
    /// v0.7.1: version exchange reply. Trailing — see `RpcRequest::Hello`.
    Hello { app_version: String },
}

/// Length-prefixed postcard frame. Big-endian u32 length, then the body.
pub async fn write_frame<W, T>(w: &mut W, msg: &T) -> AppResult<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let bytes = postcard::to_allocvec(msg)
        .map_err(|e| AppError::Invalid(format!("postcard encode: {e}")))?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(AppError::Invalid(format!(
            "outbound frame {} bytes exceeds {MAX_FRAME_BYTES}-byte cap",
            bytes.len()
        )));
    }
    let len = bytes.len() as u32;
    w.write_all(&len.to_be_bytes())
        .await
        .map_err(|e| AppError::Invalid(format!("write frame length: {e}")))?;
    w.write_all(&bytes)
        .await
        .map_err(|e| AppError::Invalid(format!("write frame body: {e}")))?;
    w.flush()
        .await
        .map_err(|e| AppError::Invalid(format!("flush frame: {e}")))?;
    Ok(())
}

pub async fn read_frame<R, T>(r: &mut R) -> AppResult<T>
where
    R: AsyncReadExt + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)
        .await
        .map_err(|e| AppError::Invalid(format!("read frame length: {e}")))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(AppError::Invalid(format!(
            "inbound frame claims {len} bytes; refusing (cap {MAX_FRAME_BYTES})"
        )));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)
        .await
        .map_err(|e| AppError::Invalid(format!("read frame body: {e}")))?;
    postcard::from_bytes(&buf).map_err(|e| {
        // postcard is not self-describing, so a peer running an older
        // Klaxon sends a ChangeSet with fewer trailing fields than we
        // expect and the decoder simply runs out of buffer. Between two
        // devices that were previously syncing fine, that is far and away
        // the likeliest cause — say so instead of leaking a bare postcard
        // error the user can do nothing with.
        log::warn!(
            "frame decode failed ({e}) — if this peer was previously syncing, \
             it is most likely running an older Klaxon; upgrade both devices"
        );
        AppError::Invalid(format!("postcard decode: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    #[tokio::test]
    async fn roundtrip_ping_envelope() {
        let (mut a, mut b) = duplex(64 * 1024);
        let sent = RpcEnvelope {
            secret: "deadbeef".into(),
            request: RpcRequest::Ping,
        };
        write_frame(&mut a, &sent).await.unwrap();
        let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
        assert_eq!(got.secret, "deadbeef");
        assert!(matches!(got.request, RpcRequest::Ping));
    }

    #[tokio::test]
    async fn roundtrip_hello_both_directions() {
        let (mut a, mut b) = duplex(64 * 1024);
        let req = RpcEnvelope {
            secret: "s".into(),
            request: RpcRequest::Hello { app_version: "0.7.1".into() },
        };
        write_frame(&mut a, &req).await.unwrap();
        let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
        assert!(
            matches!(got.request, RpcRequest::Hello { ref app_version } if app_version == "0.7.1")
        );

        let resp = RpcResponse::Hello { app_version: "0.7.2".into() };
        write_frame(&mut a, &resp).await.unwrap();
        let got: RpcResponse = read_frame(&mut b).await.unwrap();
        assert!(
            matches!(got, RpcResponse::Hello { ref app_version } if app_version == "0.7.2")
        );
    }

    /// Guards the wire-compat invariant that lets 0.7.0 peers keep
    /// syncing: Hello must be TRAILING, so the earlier variants' postcard
    /// indices are exactly what they were before Hello existed.
    #[test]
    fn hello_variants_are_trailing() {
        // Variant index is the first varint postcard writes for an enum.
        let ping = postcard::to_allocvec(&RpcRequest::Ping).unwrap();
        assert_eq!(ping[0], 0, "Ping must stay variant 0");
        let pull = postcard::to_allocvec(&RpcRequest::Pull { since: 0 }).unwrap();
        assert_eq!(pull[0], 1, "Pull must stay variant 1");
        let hello = postcard::to_allocvec(&RpcRequest::Hello { app_version: "x".into() }).unwrap();
        assert_eq!(hello[0], 3, "Hello is the new trailing variant 3");
        let hello_resp =
            postcard::to_allocvec(&RpcResponse::Hello { app_version: "x".into() }).unwrap();
        assert_eq!(hello_resp[0], 4, "response Hello is trailing variant 4");
    }

    #[tokio::test]
    async fn roundtrip_changeset_with_thoughts() {
        use crate::sync::types::{ChangeSet, RemoteThought};

        let (mut a, mut b) = duplex(64 * 1024);
        let sent = RpcEnvelope {
            secret: "deadbeef".into(),
            request: RpcRequest::Push(ChangeSet {
                server_time_ms: 42,
                reminders: vec![],
                tombstones: vec![],
                lanes: vec![],
                thoughts: vec![RemoteThought {
                    id: "t1".into(),
                    body: "an idea worth keeping".into(),
                    tags: vec!["idea".into()],
                    created_at: 1,
                    updated_at: 2,
                }],
            }),
        };
        write_frame(&mut a, &sent).await.unwrap();
        let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
        match got.request {
            RpcRequest::Push(set) => {
                assert_eq!(set.thoughts.len(), 1);
                assert_eq!(set.thoughts[0].body, "an idea worth keeping");
                assert_eq!(set.thoughts[0].tags, vec!["idea".to_string()]);
            }
            _ => panic!("expected a Push"),
        }
    }

    #[tokio::test]
    async fn rejects_oversize_frame() {
        let (mut a, mut b) = duplex(64);
        // Manually shove a length header that claims more than the cap allows
        // and confirm read_frame bails before allocating.
        let huge = (MAX_FRAME_BYTES as u32 + 1).to_be_bytes();
        a.write_all(&huge).await.unwrap();
        let err: AppResult<RpcEnvelope> = read_frame(&mut b).await;
        assert!(err.is_err());
    }
}
