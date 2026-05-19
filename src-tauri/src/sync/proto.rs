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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RpcResponse {
    Pong(PingResponse),
    Pull(ChangeSet),
    Push(PushResponse),
    /// Responder rejected the call. `unauthorized` is the special string
    /// the client uses to surface "your shared secret didn't match".
    Error(String),
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
    postcard::from_bytes(&buf)
        .map_err(|e| AppError::Invalid(format!("postcard decode: {e}")))
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
