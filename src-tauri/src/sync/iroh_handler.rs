//! ProtocolHandler that serves the `klaxon/sync/0` ALPN over iroh.
//!
//! One connection can host many RPC calls; each call rides its own bidi
//! stream. The handler loops `accept_bi`, spawns a tokio task per stream,
//! reads the `RpcEnvelope`, verifies the shared secret against `peers`,
//! dispatches to the matching op, and writes back one `RpcResponse`.
//!
//! Phase 2 implements Ping. Pull and Push intentionally return
//! `RpcResponse::Error("not implemented in phase 2")` so callers can
//! exercise the wire end-to-end before the full sync logic lands in
//! phase 3.
//!
//! Auth model: every authenticated RPC carries the per-peer
//! `shared_secret` in the envelope. The responder looks it up in the
//! `peers` table; mismatch ⇒ `RpcResponse::Error("unauthorized")`.

use std::sync::Arc;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use parking_lot::Mutex;
use rusqlite::Connection as DbConnection;
use tauri::AppHandle;

use crate::error::AppResult;
use crate::sync::ops;
use crate::sync::proto::{self, RpcEnvelope, RpcRequest, RpcResponse};
use crate::sync::DeviceIdentity;

#[derive(Debug, Clone)]
pub struct SyncHandler {
    pub db: Arc<Mutex<DbConnection>>,
    pub identity: DeviceIdentity,
    /// Optional so unit tests can construct a handler without a Tauri
    /// runtime. Phase-3 Push uses it to emit `klaxon://reminders-changed`
    /// after applying remote changes; phase-2 Ping doesn't touch it.
    #[allow(dead_code)]
    pub app: Option<AppHandle>,
}

impl ProtocolHandler for SyncHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        loop {
            let (mut send, mut recv) = match conn.accept_bi().await {
                Ok(s) => s,
                Err(e) => {
                    log::debug!("iroh stream accept ended: {e}");
                    break;
                }
            };
            let me = self.clone();
            tokio::spawn(async move {
                if let Err(e) = me.handle_one(&mut send, &mut recv).await {
                    log::warn!("iroh rpc error: {e}");
                }
                // Stream finish errors are non-fatal — peer may have
                // already dropped after reading the response.
                let _ = send.finish();
            });
        }
        Ok(())
    }
}

impl SyncHandler {
    async fn handle_one<S, R>(&self, send: &mut S, recv: &mut R) -> AppResult<()>
    where
        S: tokio::io::AsyncWriteExt + Unpin,
        R: tokio::io::AsyncReadExt + Unpin,
    {
        let env: RpcEnvelope = proto::read_frame(recv).await?;

        if !self.is_authorized(&env.secret) {
            log::debug!(
                "iroh rpc rejected (unauthorized): secret prefix {}",
                env.secret.chars().take(8).collect::<String>()
            );
            return proto::write_frame(send, &RpcResponse::Error("unauthorized".into())).await;
        }

        let resp = match env.request {
            RpcRequest::Ping => RpcResponse::Pong(ops::ping(&self.identity)),
            RpcRequest::Pull { since } => match ops::pull(&self.db, since) {
                Ok(cs) => RpcResponse::Pull(cs),
                Err(e) => RpcResponse::Error(format!("pull: {e}")),
            },
            RpcRequest::Push(cs) => match ops::push(&self.db, self.app.as_ref(), cs) {
                Ok(ack) => RpcResponse::Push(ack),
                Err(e) => RpcResponse::Error(format!("push: {e}")),
            },
        };

        proto::write_frame(send, &resp).await
    }

    fn is_authorized(&self, secret: &str) -> bool {
        let conn = self.db.lock();
        conn.query_row(
            "SELECT 1 FROM peers WHERE shared_secret = ?1",
            rusqlite::params![secret],
            |_| Ok::<(), rusqlite::Error>(()),
        )
        .is_ok()
    }
}

// KNOWN ISSUE / TODO: writing an in-process integration test that brings
// up two iroh Endpoints and pings between them via this handler causes
// the test binary to fail to load on Windows with STATUS_ENTRYPOINT_NOT_FOUND
// (0xc0000139), even with the tests marked #[ignore]. The merely-compiled
// presence of `iroh::Endpoint::bind` in #[cfg(test)] code triggers a
// static initializer in an iroh dep that mismatches a vcruntime/UCRT
// export. The production klaxon.exe build is unaffected. Until that's
// figured out, phase 2 is exercised by hand against `tauri dev` — see
// the "iroh sync handler attached on ALPN klaxon/sync/0" log line and
// the runtime behavior when a paired peer dials in.
