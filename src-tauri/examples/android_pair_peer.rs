//! Disposable incoming-pair fixture. Never persists an endpoint key or secret.
//! Usage: android_pair_peer <new-directory> <input.json>
//! input: {scenario,node_id,endpoint_addrs}; offer.json precedes the real offer;
//! report.json records the actual decision and authenticated sync evidence.

use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use iroh::{endpoint::presets, Endpoint, EndpointAddr, EndpointId, RelayMode, TransportAddr};
use klaxon_lib::{
    db::{migrations, reminders, sync_log},
    models::{Priority, ReminderState},
    sync::{
        confirmation_code,
        iroh_client::Session,
        proto::{self, PairAck, PairOffer, ALPN_PAIR},
        types::RemoteReminder,
    },
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Deserialize)]
struct Input {
    scenario: String,
    node_id: String,
    endpoint_addrs: Vec<TransportAddr>,
}

fn publish(directory: &Path, name: &str, value: Value) -> Result {
    let temporary = directory.join(format!("{name}.pending"));
    std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
    std::fs::rename(temporary, directory.join(name))?;
    Ok(())
}

async fn run(directory: &Path, input: &Input) -> Result<Value> {
    if !["approve", "decline", "expire"].contains(&input.scenario.as_str()) {
        return Err("unknown pairing scenario".into());
    }
    if input.endpoint_addrs.is_empty() {
        return Err("at least one forwarded UDP address is required".into());
    }
    // Every seed must be a loopback UDP forwarding destination, never a public
    // device. The Android test and host harness independently guard the emulator.
    for address in &input.endpoint_addrs {
        match address {
            TransportAddr::Ip(address) if address.ip().is_loopback() => (),
            _ => return Err("pairing fixture only accepts loopback UDP forwarding".into()),
        }
    }
    let target: EndpointId = input.node_id.parse()?;
    let endpoint = tokio::time::timeout(
        Duration::from_secs(20),
        Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Disabled)
            .clear_ip_transports()
            .bind_addr("0.0.0.0:0")?
            .bind(),
    )
    .await??;
    let peer_id = format!("ci-pair-{}", input.scenario);
    let peer_name = format!("Disposable pairing host {}", input.scenario);
    let offer = PairOffer {
        request_id: uuid::Uuid::new_v4().to_string(),
        initiator_id: peer_id.clone(),
        initiator_name: peer_name.clone(),
        initiator_node_id: endpoint.id().to_string(),
        ephemeral_token: uuid::Uuid::new_v4().to_string(),
    };
    publish(
        directory,
        "offer.json",
        json!({
            "scenario": input.scenario,
            "peer_id": peer_id,
            "peer_name": peer_name,
            "node_id": endpoint.id().to_string(),
            "request_id": offer.request_id,
            "confirmation_code": confirmation_code(&offer.request_id, &offer.ephemeral_token, &offer.initiator_node_id, &input.node_id),
        }),
    )?;

    // Android may own other UDP sockets (DNS/mDNS). Try the forwarded candidates
    // against the exact public endpoint identity; only its real QUIC endpoint
    // can complete this authenticated transport handshake.
    let mut connected = None;
    for seed in &input.endpoint_addrs {
        let address = EndpointAddr {
            id: target,
            addrs: [seed.clone()].into_iter().collect(),
        };
        if let Ok(Ok(connection)) =
            tokio::time::timeout(Duration::from_secs(6), endpoint.connect(address, ALPN_PAIR)).await
        {
            connected = Some((connection, seed.clone()));
            break;
        }
    }
    let (connection, seed) =
        connected.ok_or("no forwarded UDP port reached Android's pairing endpoint")?;
    let (mut send, mut receive) = connection.open_bi().await?;
    let started = Instant::now();
    proto::write_frame(&mut send, &offer).await?;
    send.finish()?;
    let ack: PairAck =
        tokio::time::timeout(Duration::from_secs(150), proto::read_frame(&mut receive)).await??;
    let elapsed = started.elapsed().as_millis() as u64;
    connection.close(0u32.into(), b"pair fixture received decision");

    let mut report = json!({ "scenario": input.scenario, "decision_elapsed_ms": elapsed });
    match ack {
        PairAck::Approved {
            responder_id,
            responder_node_id,
            shared_secret,
            ..
        } => {
            if input.scenario != "approve" {
                return Err("Android approved a declined or expired request".into());
            }
            if responder_id.is_empty()
                || responder_node_id != input.node_id
                || shared_secret.is_empty()
            {
                return Err("approved identity or shared secret was invalid".into());
            }
            report["outcome"] = json!("approved");
            report["shared_secret_sha256"] =
                json!(hex::encode(Sha256::digest(shared_secret.as_bytes())));
            // Negotiate the production sync protocol using exactly the secret
            // from PairAck, push a real batch, then pull Android's actual row.
            let session =
                Session::connect(&endpoint, &input.node_id, &[seed], &shared_secret).await?;
            let db = Connection::open_in_memory()?;
            migrations::run(&db)?;
            reminders::apply_remote(
                &db,
                &RemoteReminder {
                    id: "host-paired".into(),
                    title: "Host fixture paired".into(),
                    description: None,
                    due_at: 2_000_000_000_000,
                    priority: Priority::High,
                    sound_path: None,
                    repeat_rule: None,
                    state: ReminderState::Pending,
                    snooze_until: None,
                    created_at: 1,
                    updated_at: klaxon_lib::models::now_ms(),
                    silent: true,
                    tags: vec![],
                    task_lane_id: None,
                    task_sort_key: None,
                },
            )?;
            session.push(sync_log::snapshot(&db, None)?).await?;
            let batch = session.pull(None).await?;
            if !batch
                .changes
                .reminders
                .iter()
                .any(|row| row.id == "android-paired" && row.title == "Android fixture paired")
            {
                return Err("authenticated sync did not return Android's fixture reminder".into());
            }
            report["sync_verified"] = json!(true);
            report["received"] = json!({"id": "android-paired", "title": "Android fixture paired"});
        }
        PairAck::Declined => {
            if input.scenario == "approve" {
                return Err("Android declined the approved request".into());
            }
            if input.scenario == "expire" && elapsed < 119_000 {
                return Err("expiration ended before the real 120-second approval window".into());
            }
            report["outcome"] = json!("declined");
            report["sync_verified"] = json!(false);
        }
        PairAck::Error(message) => return Err(format!("Android pairing error: {message}").into()),
    }
    endpoint.close().await;
    Ok(report)
}

#[tokio::main]
async fn main() -> Result {
    env_logger::init();
    let mut args = std::env::args().skip(1);
    let directory = PathBuf::from(args.next().ok_or("expected new fixture directory")?);
    let input: Input =
        serde_json::from_slice(&std::fs::read(args.next().ok_or("expected input JSON")?)?)?;
    // Fresh directory means old reports can never make this run pass.
    std::fs::create_dir(&directory)?;
    let outcome = tokio::time::timeout(Duration::from_secs(230), run(&directory, &input)).await;
    match outcome {
        Ok(Ok(report)) => {
            publish(&directory, "report.json", report)?;
            println!("PASS real incoming pairing {}", input.scenario);
            Ok(())
        }
        failure => {
            let message = match failure {
                Ok(Err(error)) => error.to_string(),
                Err(_) => "pairing fixture exceeded its deadline".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            publish(
                &directory,
                "report.json",
                json!({"scenario": input.scenario, "error": message}),
            )?;
            Err(message.into())
        }
    }
}
