//! Length-prefixed Postcard RPC. Versioned delivery uses klaxon/sync/1;
//! klaxon/sync/0 is retained only for compatibility diagnostics.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::sync_log::{Batch, Cursor};
use crate::error::{AppError, AppResult};
use crate::sync::types::{ChangeSet, PingResponse, PushResponse};

/// ALPN identifier handshook between iroh peers. Bump the suffix when the
/// envelope shape changes incompatibly.
pub const ALPN_SYNC: &[u8] = b"klaxon/sync/1";
pub const ALPN_LEGACY: &[u8] = b"klaxon/sync/0";
pub const PROTOCOL_VERSION: u16 = 1;
pub const UPDATE_REQUIRED: &str = "Update Klaxon on both devices to v0.10.3 or later to resume syncing. Your data and pairing are preserved.";

pub fn validate_protocol(version: u16) -> AppResult<()> {
    if version != PROTOCOL_VERSION {
        return Err(AppError::Invalid(format!(
            "Unsupported sync protocol {version}. {UPDATE_REQUIRED}"
        )));
    }
    Ok(())
}

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
    Pull {
        since: i64,
    },
    Push(ChangeSet),
    /// v0.7.1: version exchange. Trailing on purpose — postcard tags
    /// variants by index, so older peers decode the earlier variants
    /// unchanged and drop only the one stream carrying a Hello they
    /// can't parse (the handler's per-stream error isolation).
    Hello {
        app_version: String,
    },
    HelloV1 {
        protocol: u16,
        app_version: String,
    },
    PullV1 {
        since: Option<Cursor>,
    },
    PushV1(Batch),
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
    Hello {
        app_version: String,
    },
    HelloV1 {
        protocol: u16,
        app_version: String,
    },
    PullV1(Batch),
    PushV1 {
        cursor: Cursor,
    },
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
    let (message, remaining) = postcard::take_from_bytes(&buf)
        .map_err(|e| AppError::Invalid(format!("sync frame decode failed: {e}")))?;
    if !remaining.is_empty() {
        return Err(AppError::Invalid(
            "sync frame contains unexpected trailing data".into(),
        ));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incompatible_protocol_is_rejected_before_data_exchange() {
        assert!(validate_protocol(1).is_ok());
        let err = validate_protocol(2).unwrap_err().to_string();
        assert!(err.contains("Update"), "{err}");
        assert!(validate_protocol(0).is_err());
    }
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

    /// A recurring reminder must not make the receiver drop the whole
    /// Push stream (which the sender sees as `read frame length: early eof`).
    #[tokio::test]
    async fn roundtrip_recurring_reminders() {
        use crate::models::{Priority, ReminderState, RepeatRule};
        use crate::sync::types::RemoteReminder;

        for rule in [
            None,
            Some(RepeatRule::Daily),
            Some(RepeatRule::Weekly {
                weekdays: vec![1, 3, 5],
            }),
            Some(RepeatRule::Interval {
                every_seconds: 604800,
            }),
            Some(RepeatRule::Monthly { day: 31 }),
        ] {
            let expected_rule = serde_json::to_value(&rule).unwrap();
            let set = ChangeSet {
                server_time_ms: 42,
                reminders: vec![RemoteReminder {
                    id: "recurring".into(),
                    title: "Weekly reminder".into(),
                    description: None,
                    due_at: 123,
                    priority: Priority::High,
                    sound_path: None,
                    repeat_rule: rule,
                    state: ReminderState::Pending,
                    snooze_until: Some(456),
                    created_at: 1,
                    updated_at: 2,
                    silent: false,
                    tags: vec!["keep".into()],
                    task_lane_id: None,
                    task_sort_key: Some(3.5),
                }],
                tombstones: vec![],
                lanes: vec![],
                thoughts: vec![],
                day_notes: vec![],
            };
            let (mut a, mut b) = duplex(64 * 1024);
            write_frame(
                &mut a,
                &RpcEnvelope {
                    secret: "test-secret".into(),
                    request: RpcRequest::Push(set),
                },
            )
            .await
            .unwrap();
            let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
            let RpcRequest::Push(got) = got.request else {
                panic!("expected Push")
            };
            let reminder = &got.reminders[0];
            assert_eq!(
                serde_json::to_value(&reminder.repeat_rule).unwrap(),
                expected_rule
            );
            // Reading the variable-shaped rule must not consume the next fields.
            assert_eq!(reminder.state, ReminderState::Pending);
            assert_eq!(reminder.snooze_until, Some(456));
            assert_eq!(reminder.tags, vec!["keep"]);
            assert_eq!(reminder.task_sort_key, Some(3.5));

            write_frame(&mut a, &RpcResponse::Pull(got)).await.unwrap();
            let reply: RpcResponse = read_frame(&mut b).await.unwrap();
            let RpcResponse::Pull(got) = reply else {
                panic!("expected Pull")
            };
            assert_eq!(
                serde_json::to_value(&got.reminders[0].repeat_rule).unwrap(),
                expected_rule
            );
        }
    }

    #[tokio::test]
    async fn roundtrip_hello_both_directions() {
        let (mut a, mut b) = duplex(64 * 1024);
        let req = RpcEnvelope {
            secret: "s".into(),
            request: RpcRequest::Hello {
                app_version: "0.7.1".into(),
            },
        };
        write_frame(&mut a, &req).await.unwrap();
        let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
        assert!(
            matches!(got.request, RpcRequest::Hello { ref app_version } if app_version == "0.7.1")
        );

        let resp = RpcResponse::Hello {
            app_version: "0.7.2".into(),
        };
        write_frame(&mut a, &resp).await.unwrap();
        let got: RpcResponse = read_frame(&mut b).await.unwrap();
        assert!(matches!(got, RpcResponse::Hello { ref app_version } if app_version == "0.7.2"));
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
        let hello = postcard::to_allocvec(&RpcRequest::Hello {
            app_version: "x".into(),
        })
        .unwrap();
        assert_eq!(hello[0], 3, "Hello is the new trailing variant 3");
        let hello_resp = postcard::to_allocvec(&RpcResponse::Hello {
            app_version: "x".into(),
        })
        .unwrap();
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
                day_notes: vec![],
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
    async fn roundtrip_changeset_with_day_notes() {
        use crate::sync::types::{ChangeSet, RemoteDayNote};

        let (mut a, mut b) = duplex(64 * 1024);
        let sent = RpcEnvelope {
            secret: "deadbeef".into(),
            request: RpcRequest::Push(ChangeSet {
                server_time_ms: 42,
                reminders: vec![],
                tombstones: vec![],
                lanes: vec![],
                thoughts: vec![],
                day_notes: vec![RemoteDayNote {
                    day: "2026-08-23".into(),
                    body: "shipped v0.9.0".into(),
                    created_at: 1,
                    updated_at: 2,
                }],
            }),
        };
        write_frame(&mut a, &sent).await.unwrap();
        let got: RpcEnvelope = read_frame(&mut b).await.unwrap();
        match got.request {
            RpcRequest::Push(set) => {
                assert_eq!(set.day_notes.len(), 1);
                assert_eq!(set.day_notes[0].day, "2026-08-23");
                assert_eq!(set.day_notes[0].body, "shipped v0.9.0");
                assert_eq!(set.day_notes[0].updated_at, 2);
            }
            _ => panic!("expected a Push"),
        }
    }

    /// The v0.9 `ChangeSet`, field-for-field. postcard is positional, so
    /// decoding with this shape is exactly what a 0.9 peer does.
    ///
    /// Most of these fields are never read. They are not dead — their
    /// presence is the whole point, because each one consumes its bytes in
    /// order and puts `thoughts` at the offset a 0.9 peer expects. Deleting
    /// the "unused" ones would shift that offset and quietly make the test
    /// pass for the wrong reason.
    #[allow(dead_code)]
    #[derive(serde::Deserialize)]
    struct V09ChangeSet {
        server_time_ms: i64,
        reminders: Vec<crate::sync::types::RemoteReminder>,
        tombstones: Vec<crate::sync::types::RemoteTombstone>,
        lanes: Vec<crate::db::task_lanes::Lane>,
        thoughts: Vec<crate::sync::types::RemoteThought>,
    }

    /// `day_notes` being the LAST field is the entire reason a 0.9 peer
    /// survives a 0.10 changeset: it reads the five fields it knows and
    /// stops, leaving our bytes unread. Move it anywhere else and 0.9
    /// silently misparses `thoughts` as day notes. Nothing else in the
    /// suite pins that ordering — the mesh test passes structs in-process
    /// and never encodes.
    #[test]
    fn a_v09_peer_still_decodes_a_v010_changeset() {
        use crate::sync::types::{ChangeSet, RemoteDayNote, RemoteThought};

        let new = ChangeSet {
            server_time_ms: 7,
            reminders: vec![],
            tombstones: vec![],
            lanes: vec![],
            thoughts: vec![RemoteThought {
                id: "t1".into(),
                body: "an idea".into(),
                tags: vec!["x".into()],
                created_at: 1,
                updated_at: 2,
            }],
            day_notes: vec![RemoteDayNote {
                day: "2026-08-23".into(),
                body: "a note the old peer cannot see".into(),
                created_at: 1,
                updated_at: 2,
            }],
        };
        let bytes = postcard::to_allocvec(&new).unwrap();

        let old: V09ChangeSet = postcard::take_from_bytes(&bytes).unwrap().0;
        assert_eq!(old.server_time_ms, 7);
        assert_eq!(old.thoughts.len(), 1, "thoughts must survive intact");
        assert_eq!(
            old.thoughts[0].body, "an idea",
            "a reordered day_notes field would corrupt this"
        );
    }

    /// The other direction is the documented break: a 0.10 peer runs out of
    /// buffer on a 0.9 changeset. It fails the frame rather than corrupting,
    /// which is why sync stalls instead of losing data — `pull` runs before
    /// `push`, so the error propagates before any watermark moves.
    #[test]
    fn a_v010_peer_cannot_decode_a_v09_changeset() {
        use crate::sync::types::ChangeSet;

        // Encode in the v0.9 shape: the five fields, no day_notes.
        let old_bytes = postcard::to_allocvec(&(0i64, (), (), (), ())).unwrap();
        // Truncate to be certain nothing trails that could parse as a Vec.
        let starved = &old_bytes[..old_bytes.len().saturating_sub(1)];
        assert!(
            postcard::from_bytes::<ChangeSet>(starved).is_err(),
            "a 0.10 peer must reject a short frame, not invent an empty day_notes"
        );
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

    #[tokio::test]
    async fn rejects_trailing_payload_instead_of_accepting_a_different_schema() {
        let env = RpcEnvelope {
            secret: "test".into(),
            request: RpcRequest::Ping,
        };
        let mut body = postcard::to_allocvec(&env).unwrap();
        body.push(42);
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend(body);
        let result = read_frame::<_, RpcEnvelope>(&mut frame.as_slice()).await;
        assert!(
            result.is_err(),
            "a frame with unconsumed bytes must be rejected"
        );
    }

    #[tokio::test]
    async fn revision_batch_frame_preserves_epoch_and_cursor() {
        let changes = ChangeSet {
            server_time_ms: 500,
            reminders: vec![],
            tombstones: vec![],
            lanes: vec![],
            thoughts: vec![],
            day_notes: vec![],
        };
        let env = RpcEnvelope {
            secret: "test".into(),
            request: RpcRequest::PushV1(Batch {
                cursor: Cursor {
                    epoch: "epoch-a".into(),
                    revision: 42,
                },
                changes,
            }),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &env).await.unwrap();
        let decoded: RpcEnvelope = read_frame(&mut bytes.as_slice()).await.unwrap();
        match decoded.request {
            RpcRequest::PushV1(batch) => {
                assert_eq!(batch.cursor.epoch, "epoch-a");
                assert_eq!(batch.cursor.revision, 42);
                assert_eq!(batch.changes.server_time_ms, 500);
            }
            _ => panic!("wrong RPC decoded"),
        }
    }
}
