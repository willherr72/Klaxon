//! Offline recovery regressions using the production Iroh client and handler.
//! Run: cargo run --locked --example sync_recovery
//! Uses fresh loopback identities and disposable databases, never app data.

use std::{future::Future, path::PathBuf, sync::Arc, task::Poll, time::Duration};

use iroh::{endpoint::presets, protocol::Router, Endpoint, RelayMode, TransportAddr};
use klaxon_lib::{
    db::{self, migrations, sync_log, thoughts},
    sync::{
        iroh_client::Session,
        iroh_handler::SyncHandler,
        proto::ALPN_SYNC,
        storage,
        types::{ChangeSet, RemoteThought},
        DeviceIdentity,
    },
};
use parking_lot::Mutex;
use rusqlite::Connection as Database;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const SECRET: &str = "recovery-test-pairing-not-a-user-secret";
const DEADLINE: Duration = Duration::from_secs(10);

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let path =
            std::env::temp_dir().join(format!("klaxon-sync-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            eprintln!(
                "could not clean temporary test directory {}: {error}",
                self.0.display()
            );
        }
    }
}

fn pair(db: &Database, peer: &str) -> Result {
    db.execute(
        "INSERT INTO peers(id,name,shared_secret,created_at) VALUES (?1,?1,?2,1)",
        [peer, SECRET],
    )?;
    Ok(())
}

fn database() -> Result<Database> {
    let db = Database::open_in_memory()?;
    migrations::run(&db)?;
    pair(&db, "peer")?;
    Ok(db)
}

fn thought(db: &Database, id: &str, body: &str, clock: i64) -> Result {
    assert!(
        thoughts::apply_remote(
            db,
            &RemoteThought {
                id: id.into(),
                body: body.into(),
                tags: vec!["recovery".into()],
                created_at: 1,
                updated_at: clock,
            }
        )?,
        "fixture must write a new revision"
    );
    Ok(())
}

fn assert_thoughts(db: &Database, expected: &[(&str, &str)]) -> Result {
    let mut rows: Vec<_> = thoughts::list(db, 100, 0)?
        .into_iter()
        .map(|row| (row.id, row.body))
        .collect();
    rows.sort();
    let mut expected: Vec<_> = expected
        .iter()
        .map(|(id, body)| (id.to_string(), body.to_string()))
        .collect();
    expected.sort();
    assert_eq!(
        rows, expected,
        "stored data must have no duplicates or skipped rows"
    );
    Ok(())
}

fn assert_empty(changes: &ChangeSet) {
    assert!(
        changes.reminders.is_empty()
            && changes.thoughts.is_empty()
            && changes.day_notes.is_empty()
            && changes.lanes.is_empty()
            && changes.tombstones.is_empty(),
        "acknowledged data must not be retransmitted: {changes:?}"
    );
}

async fn endpoint() -> Result<Endpoint> {
    let endpoint = tokio::time::timeout(
        DEADLINE,
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr("127.0.0.1:0")?
            .bind(),
    )
    .await??;
    let address = endpoint.addr();
    assert!(!address.addrs.is_empty());
    assert!(address
        .addrs
        .iter()
        .all(|addr| matches!(addr, TransportAddr::Ip(ip) if ip.ip().is_loopback())));
    Ok(endpoint)
}

struct Peer {
    db: Arc<Mutex<Database>>,
    endpoint: Endpoint,
    router: Router,
}

impl Peer {
    async fn new(db: Database) -> Result<Self> {
        let db = Arc::new(Mutex::new(db));
        let endpoint = endpoint().await?;
        let router = Router::builder(endpoint.clone())
            .accept(
                ALPN_SYNC.to_vec(),
                SyncHandler {
                    db: db.clone(),
                    app: None,
                    identity: DeviceIdentity {
                        device_id: endpoint.id().to_string(),
                        device_name: "Recovery fixture".into(),
                    },
                },
            )
            .spawn();
        Ok(Self {
            db,
            endpoint,
            router,
        })
    }

    async fn connect(&self, client: &Endpoint) -> Result<Session> {
        let seeds: Vec<_> = self.endpoint.addr().addrs.into_iter().collect();
        let session =
            Session::connect(client, &self.endpoint.id().to_string(), &seeds, SECRET).await?;
        assert!(!session.dial.used_relay);
        Ok(session)
    }

    async fn close(self) -> Result {
        tokio::time::timeout(DEADLINE, self.router.shutdown()).await??;
        Ok(())
    }
}

// Catches acknowledging the current journal head instead of the sent snapshot,
// which loses a write made while an earlier network request is still pending.
async fn write_during_push() -> Result {
    let source = database()?;
    thought(&source, "editing", "Before send", 100)?;
    let target = Peer::new(database()?).await?;
    let client = endpoint().await?;
    let session = target.connect(&client).await?;
    let sending = sync_log::snapshot(&source, None)?;
    let mut pending = Box::pin(session.push(sending.clone()));
    // Prevent the handler from committing while the first poll runs, even on
    // a very fast machine. Release before awaiting any network progress.
    let server_guard = target.db.lock();
    // Poll the real network operation before writing. Unlike a timing sleep,
    // this proves the request started and has not returned its acknowledgment.
    std::future::poll_fn(|cx| {
        assert!(
            matches!(pending.as_mut().poll(cx), Poll::Pending),
            "first network poll must await delivery"
        );
        Poll::Ready(())
    })
    .await;
    thought(&source, "editing", "Written during send", 101)?;
    thought(&source, "old-clock", "New row with an older clock", 2)?;
    drop(server_guard);
    let ack = pending.await?;
    assert_eq!(ack, sending.cursor);
    sync_log::mark_pushed(&source, "peer", &ack)?;
    assert_thoughts(&target.db.lock(), &[("editing", "Before send")])?;
    let (_, cursor) = sync_log::cursors(&source, "peer")?;
    assert_eq!(cursor, Some(sending.cursor));
    let next = sync_log::snapshot(&source, cursor.as_ref())?;
    assert_eq!(next.changes.thoughts.len(), 2);
    assert!(next.cursor.revision > ack.revision);
    let ack = session.push(next).await?;
    sync_log::mark_pushed(&source, "peer", &ack)?;
    assert_thoughts(
        &target.db.lock(),
        &[
            ("editing", "Written during send"),
            ("old-clock", "New row with an older clock"),
        ],
    )?;
    assert_empty(&sync_log::snapshot(&source, Some(&ack))?.changes);
    drop(session);
    tokio::time::timeout(DEADLINE, client.close()).await?;
    target.close().await?;
    println!("PASS write during in-flight push: exact snapshot ACK preserves subsequent edits and old-clock inserts");
    Ok(())
}

// Catches timestamp/origin filtering that prevents A's late import from B
// reaching C after C has already acknowledged a newer-timestamp B snapshot.
async fn late_mesh_forwarding() -> Result {
    let a = Peer::new(database()?).await?;
    let b = Peer::new(database()?).await?;
    let c = Peer::new(database()?).await?;
    thought(&b.db.lock(), "recent", "B already delivered this", 9000)?;
    let c_to_b = b.connect(&c.endpoint).await?;
    let initial = c_to_b.pull(None).await?;
    assert!(initial.cursor.revision > 0);
    storage::apply_pulled(&c.db.lock(), "peer", &initial)?;
    thought(&a.db.lock(), "late", "A arrived late via B", 2)?;
    let a_to_b = b.connect(&a.endpoint).await?;
    let imported = sync_log::snapshot(&a.db.lock(), None)?;
    a_to_b.push(imported).await?;
    let delta = c_to_b.pull(Some(initial.cursor.clone())).await?;
    assert_eq!(delta.changes.thoughts.len(), 1);
    assert_eq!(delta.changes.thoughts[0].id, "late");
    assert_eq!(delta.changes.thoughts[0].updated_at, 2);
    assert!(delta.cursor.revision > initial.cursor.revision);
    storage::apply_pulled(&c.db.lock(), "peer", &delta)?;
    assert_thoughts(
        &c.db.lock(),
        &[
            ("recent", "B already delivered this"),
            ("late", "A arrived late via B"),
        ],
    )?;
    assert_empty(
        &c_to_b
            .pull(sync_log::cursors(&c.db.lock(), "peer")?.0)
            .await?
            .changes,
    );
    drop((a_to_b, c_to_b));
    a.close().await?;
    b.close().await?;
    c.close().await?;
    println!("PASS three-peer late forwarding: a nonzero delivery cursor does not hide older-timestamp imports");
    Ok(())
}

// Catches volatile or incorrect pull/push cursor persistence and replay that
// inserts duplicate data/revisions after the database and endpoint restart.
async fn restart_delivery() -> Result {
    let scratch = Scratch::new()?;
    let path = scratch.0.join("restart.sqlite");
    let source = db::open(&path)?;
    pair(&source, "peer")?;
    thought(&source, "outgoing", "Persisted outgoing", 100)?;
    let target = Peer::new(database()?).await?;
    thought(&target.db.lock(), "incoming", "Persisted incoming", 200)?;
    let client = endpoint().await?;
    let session = target.connect(&client).await?;
    let received = session.pull(None).await?;
    storage::apply_pulled(&source, "peer", &received)?;
    let sent = sync_log::snapshot(&source, None)?;
    let ack = session.push(sent.clone()).await?;
    sync_log::mark_pushed(&source, "peer", &ack)?;
    let received = session.pull(Some(received.cursor)).await?;
    storage::apply_pulled(&source, "peer", &received)?;
    let saved = sync_log::cursors(&source, "peer")?;
    assert!(saved.0.as_ref().is_some_and(|c| c.revision > 0));
    assert!(saved.1.as_ref().is_some_and(|c| c.revision > 0));
    drop(session);
    tokio::time::timeout(DEADLINE, client.close()).await?;
    source.close().map_err(|(_, error)| error)?;

    // Changes while the client is closed must survive resuming its old cursor.
    thought(
        &target.db.lock(),
        "offline-incoming",
        "Arrived during restart",
        1,
    )?;
    let source = db::open(&path)?;
    assert_eq!(sync_log::cursors(&source, "peer")?, saved);
    assert_thoughts(
        &source,
        &[
            ("outgoing", "Persisted outgoing"),
            ("incoming", "Persisted incoming"),
        ],
    )?;
    assert_empty(&sync_log::snapshot(&source, saved.1.as_ref())?.changes);
    let client = endpoint().await?;
    let session = target.connect(&client).await?;
    let server_head = sync_log::snapshot(&target.db.lock(), None)?.cursor;
    session.push(sent).await?;
    assert_eq!(
        sync_log::snapshot(&target.db.lock(), None)?.cursor,
        server_head,
        "replaying a committed batch after restart must not create delivery revisions"
    );
    let received = session.pull(saved.0).await?;
    assert_eq!(received.changes.thoughts.len(), 1);
    assert_eq!(received.changes.thoughts[0].id, "offline-incoming");
    storage::apply_pulled(&source, "peer", &received)?;
    thought(&source, "offline-outgoing", "Created after restart", 1)?;
    let (_, push) = sync_log::cursors(&source, "peer")?;
    let sent = sync_log::snapshot(&source, push.as_ref())?;
    assert_eq!(sent.changes.thoughts.len(), 2);
    let ack = session.push(sent).await?;
    sync_log::mark_pushed(&source, "peer", &ack)?;
    let received = session.pull(Some(received.cursor)).await?;
    storage::apply_pulled(&source, "peer", &received)?;
    let expected = [
        ("outgoing", "Persisted outgoing"),
        ("incoming", "Persisted incoming"),
        ("offline-incoming", "Arrived during restart"),
        ("offline-outgoing", "Created after restart"),
    ];
    assert_thoughts(&source, &expected)?;
    assert_thoughts(&target.db.lock(), &expected)?;
    let saved = sync_log::cursors(&source, "peer")?;
    assert_empty(&sync_log::snapshot(&source, saved.1.as_ref())?.changes);
    assert_empty(&session.pull(saved.0.clone()).await?.changes);
    drop(session);
    tokio::time::timeout(DEADLINE, client.close()).await?;
    source.close().map_err(|(_, error)| error)?;
    let source = db::open(&path)?;
    assert_eq!(sync_log::cursors(&source, "peer")?, saved);
    assert_thoughts(&source, &expected)?;
    source.close().map_err(|(_, error)| error)?;
    target.close().await?;
    println!("PASS file-backed restart: pull/push cursors persist, replay is idempotent, and offline changes converge without duplicates");
    Ok(())
}

// Catches ignoring a restored remote epoch or losing the outbound full-resend
// requirement when the client exits after pull but before its recovery push.
async fn restore_reconciliation() -> Result {
    let scratch = Scratch::new()?;
    let path = scratch.0.join("client.sqlite");
    let backup = scratch.0.join("server-backup.sqlite");
    let source = db::open(&path)?;
    pair(&source, "peer")?;
    thought(&source, "recover-me", "Retained by the other peer", 100)?;
    let target = Peer::new(database()?).await?;
    thought(&target.db.lock(), "baseline", "Included in the backup", 10)?;
    target.db.lock().execute(
        "VACUUM INTO ?1",
        [backup.to_str().ok_or("non-UTF8 test path")?],
    )?;
    let client = endpoint().await?;
    let session = target.connect(&client).await?;
    let baseline = session.pull(None).await?;
    storage::apply_pulled(&source, "peer", &baseline)?;
    let sent = sync_log::snapshot(&source, None)?;
    let ack = session.push(sent).await?;
    sync_log::mark_pushed(&source, "peer", &ack)?;
    let before_restore = session.pull(Some(baseline.cursor)).await?;
    storage::apply_pulled(&source, "peer", &before_restore)?;
    assert!(sync_log::cursors(&source, "peer")?.1.is_some());
    drop(session);

    // Replace only our synthetic database with its real pre-delivery backup.
    // The live handler will read the replacement connection on its next RPC.
    {
        let mut server_db = target.db.lock();
        *server_db = db::open(&backup)?;
        sync_log::reset_after_restore(&server_db)?;
        assert!(thoughts::get_by_id(&server_db, "recover-me").is_err());
        let secret: String =
            server_db.query_row("SELECT shared_secret FROM peers WHERE id='peer'", [], |r| {
                r.get(0)
            })?;
        assert_eq!(secret, SECRET, "restore must retain pairing credentials");
    }
    let session = target.connect(&client).await?;
    let restored = session.pull(Some(before_restore.cursor.clone())).await?;
    assert_ne!(restored.cursor.epoch, before_restore.cursor.epoch);
    assert!(restored.cursor.revision < before_restore.cursor.revision);
    assert_eq!(restored.changes.thoughts.len(), 1);
    assert_eq!(restored.changes.thoughts[0].id, "baseline");
    storage::apply_pulled(&source, "peer", &restored)?;
    assert_eq!(
        sync_log::cursors(&source, "peer")?,
        (Some(restored.cursor.clone()), None)
    );
    drop(session);
    tokio::time::timeout(DEADLINE, client.close()).await?;
    source.close().map_err(|(_, error)| error)?;

    // Simulate process exit before the full recovery push, then reconnect.
    let source = db::open(&path)?;
    let (pull, push) = sync_log::cursors(&source, "peer")?;
    assert_eq!(pull, Some(restored.cursor));
    assert_eq!(push, None, "full outbound reset must survive restart");
    let client = endpoint().await?;
    let session = target.connect(&client).await?;
    let full = sync_log::snapshot(&source, push.as_ref())?;
    assert_eq!(full.changes.thoughts.len(), 2);
    let ack = session.push(full).await?;
    sync_log::mark_pushed(&source, "peer", &ack)?;
    let recovered = session.pull(pull).await?;
    storage::apply_pulled(&source, "peer", &recovered)?;
    let expected = [
        ("baseline", "Included in the backup"),
        ("recover-me", "Retained by the other peer"),
    ];
    assert_thoughts(&source, &expected)?;
    assert_thoughts(&target.db.lock(), &expected)?;
    assert_empty(&session.pull(Some(recovered.cursor)).await?.changes);
    assert_empty(&sync_log::snapshot(&source, Some(&ack))?.changes);
    drop(session);
    tokio::time::timeout(DEADLINE, client.close()).await?;
    source.close().map_err(|(_, error)| error)?;
    target.close().await?;
    println!("PASS restored epoch: lower remote head reconciles fully, durable outbound reset survives restart, missing server data recovers");
    Ok(())
}

#[tokio::main]
async fn main() -> Result {
    tokio::time::timeout(Duration::from_secs(120), async {
        write_during_push().await?;
        late_mesh_forwarding().await?;
        restart_delivery().await?;
        restore_reconciliation().await?;
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })
    .await??;
    println!("sync_recovery: all production recovery assertions passed (loopback, no relay or user data)");
    Ok(())
}
