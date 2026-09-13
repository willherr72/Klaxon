//! Versioned, authenticated RPC streams. One connection serves a full sync pass.
use crate::sync::{
    proto::{self, RpcEnvelope, RpcResponse, ALPN_LEGACY},
    service,
    storage::Applied,
    DeviceIdentity,
};
use iroh::endpoint::Connection;
use iroh::protocol::{AcceptError, ProtocolHandler};
use parking_lot::Mutex;
use rusqlite::Connection as DbConnection;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::AppHandle;

#[derive(Debug, Clone)]
pub struct SyncHandler {
    pub db: Arc<Mutex<DbConnection>>,
    pub identity: DeviceIdentity,
    pub app: Option<AppHandle>,
}

impl ProtocolHandler for SyncHandler {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let legacy = conn.alpn() == ALPN_LEGACY;
        let negotiated = Arc::new(AtomicBool::new(false));
        // Bound work from a connection, including peers that never finish a frame.
        let streams = Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            let permit = match streams.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break,
            };
            let (mut send, mut recv) = match conn.accept_bi().await {
                Ok(s) => s,
                Err(_) => break,
            };
            let me = self.clone();
            let negotiated = negotiated.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let decoded = tokio::time::timeout(
                    Duration::from_secs(8),
                    proto::read_frame::<_, RpcEnvelope>(&mut recv),
                )
                .await;
                let (response, effects) = match decoded {
                    Ok(Ok(env)) => {
                        let result = service::dispatch(
                            &me.db.lock(),
                            &me.identity,
                            env,
                            legacy,
                            negotiated.load(Ordering::Acquire),
                        );
                        match result {
                            Ok(value) => value,
                            Err(e) => {
                                log::warn!("sync request failed: {e}");
                                (
                                    RpcResponse::Error(e.to_string().chars().take(512).collect()),
                                    None,
                                )
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        log::warn!("malformed sync frame: {e}");
                        (
                            RpcResponse::Error(format!(
                                "Malformed sync request. {}",
                                proto::UPDATE_REQUIRED
                            )),
                            None,
                        )
                    }
                    Err(_) => (
                        RpcResponse::Error(
                            "Sync request frame timed out; retry when the connection is available."
                                .into(),
                        ),
                        None,
                    ),
                };
                if matches!(response, RpcResponse::HelloV1 { .. }) {
                    negotiated.store(true, Ordering::Release);
                }
                if let (Some(app), Some(applied)) = (me.app.as_ref(), effects.as_ref()) {
                    publish_applied(app, applied);
                }
                match tokio::time::timeout(
                    Duration::from_secs(8),
                    proto::write_frame(&mut send, &response),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => log::warn!("sync response write failed: {e}"),
                    Err(e) => log::warn!("sync response deadline exceeded: {e}"),
                }
                let _ = send.finish();
            });
        }
        Ok(())
    }
}

/// Storage has already committed before any alert or UI effect is published.
pub fn publish_applied(app: &AppHandle, applied: &Applied) {
    for id in &applied.to_cancel {
        crate::alerts::cancel_alert(app, id);
    }
    if applied.reminders_changed {
        crate::sync::task::emit_reminders_changed(app);
    }
    if applied.thoughts_changed {
        crate::sync::task::emit_thoughts_changed(app);
    }
    if applied.day_notes_changed {
        crate::sync::task::emit_day_notes_changed(app);
    }
}
