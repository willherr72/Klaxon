//! v0.3 phase 3c: pair handshake over iroh.
//!
//! Mirrors what `sync::server::handle_pair_initiate` does over HTTPS, but
//! on its own `klaxon/pair/0` ALPN. Flow:
//!
//!   1. Initiator dials our endpoint on ALPN_PAIR, opens a bidi stream,
//!      writes a `PairOffer` (initiator id + name + node_id + ephemeral
//!      token).
//!   2. We compute the 6-digit SAS, emit `klaxon://pair-request` so the
//!      local UI shows it, register a oneshot for the user's decision.
//!   3. Up to 120s for the user to hit Approve / Decline. On approve we
//!      generate a fresh shared secret, persist the peer with the
//!      initiator's node_id, write back `PairAck::Approved` with our
//!      identity + the new secret.
//!   4. On decline / timeout, write `PairAck::Declined` and close.
//!
//! No shared-secret check on this ALPN — pairing IS the bootstrap that
//! creates a shared secret. Defense against unsolicited dial attempts is
//! the explicit user-confirmation step (SAS match → Approve).

use std::sync::Arc;
use std::time::Duration;

use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use parking_lot::Mutex;
use rusqlite::Connection as DbConnection;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::db::peers;
use crate::models::now_ms;
use crate::sync::proto::{self, PairAck, PairOffer};
use crate::sync::types::{PairDecision, PendingPairEvent};
use crate::sync::{DeviceIdentity, PendingPairs};

#[derive(Clone)]
pub struct PairHandler {
    pub db: Arc<Mutex<DbConnection>>,
    pub identity: DeviceIdentity,
    pub pending_pairs: PendingPairs,
    pub app: AppHandle,
    pub local_node_id: String,
}

impl std::fmt::Debug for PairHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairHandler")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

impl ProtocolHandler for PairHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        // One incoming pair attempt per connection. The first bidi stream
        // is the offer; once we ack, we wait for the initiator to close.
        let (mut send, mut recv) = match conn.accept_bi().await {
            Ok(s) => s,
            Err(e) => {
                log::debug!("pair stream accept ended: {e}");
                return Ok(());
            }
        };

        if let Err(e) = self.handle_offer(&mut send, &mut recv).await {
            log::warn!("pair handler error: {e}");
            let _ = proto::write_frame(&mut send, &PairAck::Error(e.to_string())).await;
        }
        let _ = send.finish();

        // Critical: hold the QUIC connection alive until the initiator
        // gracefully closes it from its side. Returning here would let
        // iroh's router tear down the underlying connection immediately,
        // dropping the ack frame before the initiator's `read_frame` can
        // drain it from its receive buffer (surfaces as
        // "INVALID INPUT: READ FRAME LENGTH: CONNECTION LOST").
        conn.closed().await;
        Ok(())
    }
}

impl PairHandler {
    async fn handle_offer<S, R>(
        &self,
        send: &mut S,
        recv: &mut R,
    ) -> crate::error::AppResult<()>
    where
        S: tokio::io::AsyncWriteExt + Unpin,
        R: tokio::io::AsyncReadExt + Unpin,
    {
        let offer: PairOffer = proto::read_frame(recv).await?;

        // Compute the SAS identically on both sides. Uses NodeIds so the
        // initiator can pair via ticket without knowing our device_id.
        let sas = crate::sync::confirmation_code(
            &offer.request_id,
            &offer.ephemeral_token,
            &offer.initiator_node_id,
            &self.local_node_id,
        );

        let (tx, rx) = oneshot::channel::<PairDecision>();
        self.pending_pairs
            .lock()
            .insert(offer.request_id.clone(), tx);

        let _ = self.app.emit(
            "klaxon://pair-request",
            PendingPairEvent {
                request_id: offer.request_id.clone(),
                initiator_id: offer.initiator_id.clone(),
                initiator_name: offer.initiator_name.clone(),
                // Field kept for UI back-compat; with iroh-only the URL
                // concept is gone — surface the NodeId so the user has a
                // peer fingerprint to compare in unusual cases.
                initiator_url: format!("iroh://{}", offer.initiator_node_id),
                confirmation_code: sas,
            },
        );

        let decision = tokio::time::timeout(Duration::from_secs(120), rx).await;
        self.pending_pairs.lock().remove(&offer.request_id);

        match decision {
            Ok(Ok(PairDecision::Approve)) => {
                let secret = crate::sync::generate_secret();

                {
                    let conn = self.db.lock();
                    let peer = peers::Peer {
                        id: offer.initiator_id.clone(),
                        name: if offer.initiator_name.is_empty() {
                            "Klaxon Device".to_string()
                        } else {
                            offer.initiator_name.clone()
                        },
                        shared_secret: secret.clone(),
                        last_pull_at: 0,
                        last_push_at: 0,
                        created_at: now_ms(),
                        last_seen_at: Some(now_ms()),
                        iroh_node_id: Some(offer.initiator_node_id.clone()),
                    };
                    peers::upsert(&conn, &peer)?;
                }

                let _ = self
                    .app
                    .emit("klaxon://peer-paired", offer.initiator_id.clone());

                proto::write_frame(
                    send,
                    &PairAck::Approved {
                        responder_id: self.identity.device_id.clone(),
                        responder_name: self.identity.device_name.clone(),
                        responder_node_id: self.local_node_id.clone(),
                        shared_secret: secret,
                    },
                )
                .await?;
            }
            Ok(Ok(PairDecision::Decline)) | Err(_) | Ok(Err(_)) => {
                proto::write_frame(send, &PairAck::Declined).await?;
            }
        }
        Ok(())
    }
}
