//! Disposable emulator peer: production SyncHandler, real QUIC and memory-only DB.
//! Usage: android_sync_peer <new-fixture-directory>
//! stage.txt selects a fixture; fixture.json seeds Android; report.json proves pushes.

use std::{path::PathBuf, sync::Arc, time::Duration};

use iroh::{endpoint::presets, protocol::Router, Endpoint, RelayMode, TransportAddr};
use klaxon_lib::{
    db::{migrations, reminders},
    models::{Priority, ReminderState},
    sync::{iroh_handler::SyncHandler, proto::ALPN_SYNC, types::RemoteReminder, DeviceIdentity},
};
use parking_lot::Mutex;
use rusqlite::Connection;
use serde_json::json;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

async fn run() -> Result {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("expected fixture directory")?,
    );
    // Refuse reuse, so a previous passing run cannot satisfy this run's assertions.
    std::fs::create_dir(&directory)?;
    let db = Arc::new(Mutex::new(Connection::open_in_memory()?));
    migrations::run(&db.lock())?;
    let secret = uuid::Uuid::new_v4().to_string();
    db.lock().execute(
        "INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('android','Disposable emulator',?1,1)",
        [&secret],
    )?;
    let endpoint = tokio::time::timeout(
        Duration::from_secs(20),
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr("0.0.0.0:0")?
            .bind(),
    )
    .await??;
    let port = endpoint
        .bound_sockets()
        .into_iter()
        .find(|addr| addr.is_ipv4())
        .ok_or("no IPv4 socket")?
        .port();
    let address: std::net::SocketAddr = format!("10.0.2.2:{port}").parse()?;
    let router = Router::builder(endpoint.clone())
        .accept(
            ALPN_SYNC,
            SyncHandler {
                db: db.clone(),
                app: None,
                identity: DeviceIdentity {
                    device_id: "ci-host".into(),
                    device_name: "Disposable CI host".into(),
                },
            },
        )
        .spawn();
    std::fs::write(
        directory.join("fixture.json"),
        serde_json::to_vec(&json!({
            "node_id": endpoint.id().to_string(),
            "secret": secret,
            "endpoint_addrs": [TransportAddr::Ip(address)],
        }))?,
    )?;
    println!("Emulator peer ready on UDP {port}; no relay; synthetic memory-only data");
    let mut stage = String::new();
    loop {
        if directory.join("stop").exists() {
            break;
        }
        if let Ok(requested) = std::fs::read_to_string(directory.join("stage.txt")) {
            let requested = requested.trim();
            if requested != stage {
                if !["initial", "resume", "restart", "outage", "upgrade"].contains(&requested) {
                    return Err(format!("unknown stage: {requested}").into());
                }
                reminders::apply_remote(
                    &db.lock(),
                    &RemoteReminder {
                        id: format!("host-{requested}"),
                        title: format!("Host fixture {requested}"),
                        description: Some("Synthetic CI data".into()),
                        due_at: 2_000_000_000_000,
                        priority: Priority::High,
                        sound_path: None,
                        repeat_rule: None,
                        state: ReminderState::Pending,
                        snooze_until: None,
                        created_at: 1,
                        updated_at: klaxon_lib::models::now_ms(),
                        silent: true,
                        tags: vec!["ci".into()],
                        task_lane_id: None,
                        task_sort_key: None,
                    },
                )?;
                stage = requested.to_owned();
            }
        }
        let received = {
            let conn = db.lock();
            let mut query = conn
                .prepare("SELECT id,title FROM reminders WHERE id LIKE 'android-%' ORDER BY id")?;
            let rows = query.query_map([], |row| {
                Ok(json!({"id": row.get::<_, String>(0)?, "title": row.get::<_, String>(1)?}))
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        std::fs::write(
            directory.join("report.json"),
            serde_json::to_vec(&json!({"stage": stage, "received": received}))?,
        )?;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    tokio::time::timeout(Duration::from_secs(10), router.shutdown()).await??;
    Ok(())
}

#[tokio::main]
async fn main() -> Result {
    env_logger::init();
    tokio::time::timeout(Duration::from_secs(1800), run()).await??;
    Ok(())
}
