//! Diagnostic: can THIS machine reach a paired peer right now?
//!
//! Brings up a throwaway iroh endpoint with a fresh identity and dials the
//! given endpoint id on the sync ALPN, reporting how far it got. Nothing is
//! written and no RPC is attempted — the peer sees a connection that closes
//! immediately, and the running app is untouched.
//!
//! The point is to separate two failure modes that look identical from the
//! app's side, where every failure surfaces as "timed out — peer
//! unreachable":
//!
//!   * a fresh endpoint reaches the peer  → the app's long-lived endpoint is
//!     the broken part (stale after a network change)
//!   * a fresh endpoint cannot either     → the peer really is unreachable
//!
//! Run: cargo run --example dial_probe -- <endpoint-id-hex>
use std::str::FromStr;
use std::time::{Duration, Instant};

use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, Watcher};

const ALPN_SYNC: &[u8] = b"klaxon/sync/0";
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);

#[tokio::main]
async fn main() {
    let Some(target) = std::env::args().nth(1) else {
        eprintln!("usage: cargo run --example dial_probe -- <endpoint-id-hex>");
        std::process::exit(2);
    };
    let id = match EndpointId::from_str(&target) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("bad endpoint id: {e}");
            std::process::exit(2);
        }
    };

    let t0 = Instant::now();
    println!("binding a fresh endpoint (random identity, N0 preset)...");
    let endpoint = match Endpoint::builder(presets::N0).bind().await {
        Ok(ep) => ep,
        Err(e) => {
            println!("RESULT: bind failed after {:?}: {e}", t0.elapsed());
            println!("  -> this machine cannot bind an iroh socket at all.");
            std::process::exit(1);
        }
    };
    println!("  bound in {:?}, our id = {}", t0.elapsed(), endpoint.id());

    // Give the endpoint a moment to reach its home relay, then report it.
    // A healthy endpoint with working internet has a home relay within a
    // couple of seconds; no home relay means our own connectivity is the
    // problem, not the peer's.
    // Wait for a fully handshaked relay, not merely "Connecting" — dialing
    // before the relay is up would make an unreachable-looking result that
    // is really our own impatience. RelayConnectionState is crate-private,
    // so match on its Debug form ("Connecting" does not contain
    // "Connected", so this is unambiguous).
    let mut relay_status = endpoint.home_relay_status();
    let mut connected = false;
    for _ in 0..60 {
        let s = format!("{:?}", relay_status.get());
        if s.contains("Connected") {
            connected = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    println!(
        "  home relay: {} — {:?}",
        if connected { "CONNECTED" } else { "NOT CONNECTED after 15s" },
        relay_status.get()
    );
    println!("  our addr: {:?}", endpoint.addr());
    if !connected {
        println!("  -> our own relay path is down; a failed dial below would be");
        println!("     inconclusive about the peer.");
    }

    println!("dialing {} on klaxon/sync/0 ...", &target[..16]);
    let dial_start = Instant::now();
    match tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(id, ALPN_SYNC)).await {
        Ok(Ok(conn)) => {
            println!("RESULT: CONNECTED in {:?}", dial_start.elapsed());
            println!("  paths: {:?}", conn.paths());
            println!("  -> the peer IS reachable from this machine right now.");
            conn.close(0u32.into(), b"probe");
        }
        Ok(Err(e)) => {
            println!("RESULT: dial FAILED after {:?}: {e}", dial_start.elapsed());
            println!("  -> refused/errored rather than timing out; see the error above.");
        }
        Err(_) => {
            println!("RESULT: dial TIMED OUT after {:?}", dial_start.elapsed());
            println!("  -> the peer did not answer; it is offline, asleep, or its");
            println!("     endpoint is not listening.");
        }
    }
    endpoint.close().await;
}
