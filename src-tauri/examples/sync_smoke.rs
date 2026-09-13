//! Real, offline transport regression against the production client and handler.
//! Run: cargo run --locked --example sync_smoke
//! Uses fresh endpoint identities and in-memory databases; never opens app data.

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use iroh::{
    endpoint::{presets, Connection},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, RelayMode,
};
use klaxon_lib::{
    db::{migrations, reminders, sync_log},
    models::{Priority, ReminderState, RepeatRule},
    sync::{
        iroh_client::Session,
        iroh_handler::SyncHandler,
        proto::{self, RpcEnvelope, RpcRequest, RpcResponse, ALPN_LEGACY, ALPN_SYNC},
        storage,
        types::RemoteReminder,
        DeviceIdentity,
    },
};
use parking_lot::Mutex;
use rusqlite::Connection as Database;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const SECRET: &str = "smoke-test-pairing-not-a-user-secret";
const DEADLINE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
struct CountedHandler {
    handler: SyncHandler,
    connections: Arc<AtomicUsize>,
}

impl ProtocolHandler for CountedHandler {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        self.connections.fetch_add(1, Ordering::SeqCst);
        self.handler.accept(connection).await
    }
}

/// Deliberately nonconforming peer to verify the production client's ACK check.
#[derive(Debug, Clone)]
struct IncorrectAckHandler;

impl ProtocolHandler for IncorrectAckHandler {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        while let Ok((mut send, mut recv)) = connection.accept_bi().await {
            let Ok(Ok(envelope)) =
                tokio::time::timeout(DEADLINE, proto::read_frame::<_, RpcEnvelope>(&mut recv))
                    .await
            else {
                break;
            };
            let response = match envelope.request {
                RpcRequest::HelloV1 { .. } => RpcResponse::HelloV1 {
                    protocol: proto::PROTOCOL_VERSION,
                    app_version: env!("CARGO_PKG_VERSION").into(),
                },
                RpcRequest::PushV1(batch) => {
                    let mut cursor = batch.cursor;
                    cursor.revision += 1;
                    RpcResponse::PushV1 { cursor }
                }
                _ => RpcResponse::Error("unsupported smoke request".into()),
            };
            if !matches!(
                tokio::time::timeout(DEADLINE, proto::write_frame(&mut send, &response)).await,
                Ok(Ok(()))
            ) {
                break;
            }
            let _ = send.finish();
        }
        Ok(())
    }
}

fn database() -> Result<Database> {
    let db = Database::open_in_memory()?;
    migrations::run(&db)?;
    db.execute(
        "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('peer','Smoke peer',?1,1)",
        [SECRET],
    )?;
    Ok(db)
}

fn recurring(id: &str, title: &str, updated_at: i64) -> RemoteReminder {
    RemoteReminder {
        id: id.into(),
        title: title.into(),
        description: Some("transport regression".into()),
        due_at: 2_000_000_000_000,
        priority: Priority::High,
        sound_path: None,
        repeat_rule: Some(RepeatRule::Weekly {
            weekdays: vec![1, 3, 5],
        }),
        state: ReminderState::Pending,
        snooze_until: None,
        created_at: 1,
        updated_at,
        silent: false,
        tags: vec!["smoke".into()],
        task_lane_id: None,
        task_sort_key: None,
    }
}

async fn endpoint() -> Result<Endpoint> {
    Ok(tokio::time::timeout(
        DEADLINE,
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")?
            .bind(),
    )
    .await??)
}

async fn rpc(connection: &Connection, request: RpcRequest) -> Result<RpcResponse> {
    tokio::time::timeout(DEADLINE, async {
        let (mut send, mut recv) = connection.open_bi().await?;
        proto::write_frame(
            &mut send,
            &RpcEnvelope {
                secret: SECRET.into(),
                request,
            },
        )
        .await?;
        send.finish()?;
        Ok(proto::read_frame(&mut recv).await?)
    })
    .await?
}

fn hello() -> RpcRequest {
    RpcRequest::HelloV1 {
        protocol: proto::PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
    }
}

async fn smoke() -> Result {
    let source = database()?;
    reminders::apply_remote(
        &source,
        &recurring("outgoing", "Client weekly reminder", 20),
    )?;
    let target = Arc::new(Mutex::new(database()?));
    reminders::apply_remote(
        &target.lock(),
        &recurring("incoming", "Server weekly reminder", 10),
    )?;

    let server = endpoint().await?;
    let client = endpoint().await?;
    let accepted = Arc::new(AtomicUsize::new(0));
    let handler = CountedHandler {
        handler: SyncHandler {
            db: target.clone(),
            app: None,
            identity: DeviceIdentity {
                device_id: "smoke-server".into(),
                device_name: "Smoke server".into(),
            },
        },
        connections: accepted.clone(),
    };
    let router = Router::builder(server.clone())
        .accept(ALPN_SYNC.to_vec(), handler.clone())
        .accept(ALPN_LEGACY.to_vec(), handler)
        .spawn();
    let address = server.addr();
    assert!(
        !address.addrs.is_empty(),
        "loopback endpoint must advertise a direct seed"
    );
    assert!(address
        .addrs
        .iter()
        .all(|addr| matches!(addr, iroh::TransportAddr::Ip(ip) if ip.ip().is_loopback())));
    let seeds: Vec<_> = address.addrs.iter().cloned().collect();

    // Production Session performs Hello, Pull and Push on the same connection.
    let session = Session::connect(&client, &server.id().to_string(), &seeds, SECRET).await?;
    assert_eq!(session.peer_version, env!("CARGO_PKG_VERSION"));
    assert!(!session.dial.used_relay);
    let received = session.pull(None).await?;
    assert!(received
        .changes
        .reminders
        .iter()
        .any(|row| row.id == "incoming"));
    storage::apply_pulled(&source, "peer", &received)?;
    let batch = sync_log::snapshot(&source, None)?;
    let ack = session.push(batch.clone()).await?;
    assert_eq!(
        ack, batch.cursor,
        "ack must cover exactly the sent snapshot"
    );
    sync_log::mark_pushed(&source, "peer", &ack)?;
    let roundtrip = session.pull(Some(received.cursor)).await?;
    assert!(roundtrip
        .changes
        .reminders
        .iter()
        .any(|row| row.id == "outgoing"));
    let stored = reminders::get_by_id(&target.lock(), "outgoing")?;
    assert_eq!(stored.title, "Client weekly reminder");
    assert!(
        matches!(stored.repeat_rule, Some(RepeatRule::Weekly { ref weekdays }) if weekdays == &[1, 3, 5])
    );
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "Hello/Pull/Push/Pull must reuse one connection"
    );
    drop(session);
    println!("PASS production Session: one connection, Hello/Pull/Push, recurring payload, exact committed acknowledgment");

    let raw = tokio::time::timeout(DEADLINE, client.connect(address.clone(), ALPN_SYNC)).await??;
    assert!(
        matches!(rpc(&raw, RpcRequest::PullV1 { since: None }).await?, RpcResponse::Error(message) if message.contains("negotiation"))
    );
    assert!(matches!(
        rpc(&raw, hello()).await?,
        RpcResponse::HelloV1 { protocol: 1, .. }
    ));
    // An oversized frame is rejected before allocation; its stream must not kill
    // the established connection or erase negotiation for the next stream.
    let malformed = tokio::time::timeout(DEADLINE, async {
        let (mut send, mut recv) = raw.open_bi().await?;
        send.write_all(&u32::MAX.to_be_bytes()).await?;
        send.finish()?;
        Ok::<RpcResponse, Box<dyn std::error::Error + Send + Sync>>(
            proto::read_frame(&mut recv).await?,
        )
    })
    .await??;
    assert!(
        matches!(malformed, RpcResponse::Error(message) if message.contains("Malformed") && message.len() <= 512)
    );
    assert!(matches!(
        rpc(&raw, RpcRequest::PullV1 { since: None }).await?,
        RpcResponse::PullV1(_)
    ));
    println!("PASS bounded malformed-frame rejection and subsequent stream on the same connection");

    // Deliver a complete push but discard its response, modeling a lost ACK.
    // Wait for durable commit before disconnecting so this covers the ambiguous
    // success case, rather than merely retrying a request that never arrived.
    reminders::apply_remote(&source, &recurring("outgoing", "Retry after lost ACK", 30))?;
    let retry = sync_log::snapshot(&source, Some(&ack))?;
    let (mut send, mut recv) = raw.open_bi().await?;
    proto::write_frame(
        &mut send,
        &RpcEnvelope {
            secret: SECRET.into(),
            request: RpcRequest::PushV1(retry.clone()),
        },
    )
    .await?;
    send.finish()?;
    recv.stop(0u32.into())?;
    tokio::time::timeout(DEADLINE, async {
        loop {
            if reminders::get_by_id(&target.lock(), "outgoing")
                .unwrap()
                .title
                == "Retry after lost ACK"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    raw.close(0u32.into(), b"simulate lost push acknowledgment");
    assert_eq!(sync_log::cursors(&source, "peer")?.1, Some(ack));
    let committed = sync_log::snapshot(&target.lock(), None)?.cursor;
    let retry_session = Session::connect(&client, &server.id().to_string(), &seeds, SECRET).await?;
    assert_eq!(retry_session.push(retry.clone()).await?, retry.cursor);
    assert_eq!(
        sync_log::snapshot(&target.lock(), None)?.cursor,
        committed,
        "replay must not create a new delivery revision"
    );
    let count: i64 = target.lock().query_row(
        "SELECT COUNT(*) FROM reminders WHERE id='outgoing'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);
    drop(retry_session);
    println!("PASS interrupted push: committed request with lost ACK retries idempotently");

    let legacy = tokio::time::timeout(DEADLINE, client.connect(address, ALPN_LEGACY)).await??;
    assert!(matches!(
        rpc(
            &legacy,
            RpcRequest::Hello {
                app_version: "0.10.2".into()
            }
        )
        .await?,
        RpcResponse::Hello { .. }
    ));
    assert!(
        matches!(rpc(&legacy, RpcRequest::Push(retry.changes.clone())).await?, RpcResponse::Error(message) if message.contains(proto::UPDATE_REQUIRED))
    );
    assert_eq!(sync_log::snapshot(&target.lock(), None)?.cursor, committed);
    legacy.close(0u32.into(), b"smoke finished");
    println!("PASS legacy ALPN: Hello remains reachable; data transfer requires update and does not mutate");

    // The inverse mixed-version direction: a new client reaches a server
    // advertising only legacy ALPN. The legacy Hello probe must identify it
    // as an update requirement, rather than claiming the peer is asleep.
    let old_server = endpoint().await?;
    let old_router = Router::builder(old_server.clone())
        .accept(
            ALPN_LEGACY.to_vec(),
            SyncHandler {
                db: target.clone(),
                app: None,
                identity: DeviceIdentity {
                    device_id: "old-server".into(),
                    device_name: "Legacy-only smoke server".into(),
                },
            },
        )
        .spawn();
    let old_seeds: Vec<_> = old_server.addr().addrs.into_iter().collect();
    let old_error =
        match Session::connect(&client, &old_server.id().to_string(), &old_seeds, SECRET).await {
            Ok(_) => panic!("legacy-only server must not open a versioned session"),
            Err(error) => error.to_string(),
        };
    assert!(
        old_error.contains("Peer runs Klaxon") && old_error.contains(proto::UPDATE_REQUIRED),
        "{old_error}"
    );
    assert_eq!(sync_log::snapshot(&target.lock(), None)?.cursor, committed);
    tokio::time::timeout(DEADLINE, old_router.shutdown()).await??;
    println!("PASS new client / legacy-only server: Hello fallback reports an actionable update requirement");

    let incorrect_server = endpoint().await?;
    let incorrect_router = Router::builder(incorrect_server.clone())
        .accept(ALPN_SYNC.to_vec(), IncorrectAckHandler)
        .spawn();
    let incorrect_seeds: Vec<_> = incorrect_server.addr().addrs.into_iter().collect();
    let incorrect_session = Session::connect(
        &client,
        &incorrect_server.id().to_string(),
        &incorrect_seeds,
        SECRET,
    )
    .await?;
    let mismatch = incorrect_session.push(retry).await.unwrap_err().to_string();
    assert!(
        mismatch.contains("did not acknowledge the transmitted delivery cursor"),
        "{mismatch}"
    );
    drop(incorrect_session);
    tokio::time::timeout(DEADLINE, incorrect_router.shutdown()).await??;
    println!("PASS production client rejects an acknowledgment for a different delivery revision");

    tokio::time::timeout(DEADLINE, client.close()).await?;
    tokio::time::timeout(DEADLINE, router.shutdown()).await??;
    Ok(())
}

#[tokio::main]
async fn main() -> Result {
    tokio::time::timeout(Duration::from_secs(60), smoke()).await??;
    println!(
        "sync_smoke: all production transport assertions passed (loopback, no relay or user data)"
    );
    Ok(())
}
