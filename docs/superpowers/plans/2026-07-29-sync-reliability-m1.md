# Sync Reliability M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sync event-driven and dials fast, so a change leaves the device within seconds of the write and every awake-window gets used — instead of requiring both apps open simultaneously.

**Architecture:** A nudge channel feeds the existing sync loop (`select!` alongside the 20s tick) with debounce and bounded retry. Dials stop relying on iroh's address lookup (the "Address Lookup failed" warnings in our own logs) by seeding `connect()` with an `EndpointAddr` built from persisted last-known-good addresses plus mDNS-fresh LAN addresses. Successful connections harvest `conn.paths()` back into persistence. Windows power events and app launch fire nudges.

**Tech Stack:** Rust (tokio, iroh 1.0.0-rc.0, rusqlite), `windows` crate for `WM_POWERBROADCAST`, mdns-sd, Svelte 5.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-sync-reliability-design.md`. This plan is **M1 only** — cold-capable Android (M2) is separate.
- **API deviation from spec, discovered during planning:** iroh 1.0 has no `add_node_addr`. Addresses are supplied *at dial time* — `Endpoint::connect(impl Into<EndpointAddr>, alpn)` where `EndpointAddr { id: EndpointId, addrs: BTreeSet<TransportAddr> }`. The spec's intent (skip discovery, dial direct) is unchanged; the mechanism is "seed the connect call", not "feed an address book".
- **The mDNS record's port is cosmetic** (`discovery.rs:23`, hardcoded 7124). The iroh QUIC port must be advertised explicitly in TXT or discovered addresses are undialable.
- **Second API deviation:** the spec's "re-warm the endpoint (rebind sockets)" on resume has no public API in iroh 1.0.0-rc.0 — there is no exposed rebind. The realized mechanism is: resume nudges an immediate pass, and the seeded dial (Task 5) supplies concrete addresses so QUIC path-probes re-establish connectivity without waiting on address lookup. If manual testing shows post-resume dials still failing, that's evidence for an upstream issue, not a missing call here.
- Migration number is **010**. The unmerged calendar branch renumbers to 011–013 when it rebases.
- `cargo test` green, `cargo build` **0 warnings**. Baseline on `main`: **76 tests, 0 warnings**. `npx svelte-check` **0 errors** (7 pre-existing warnings).
- No wire-format (`ChangeSet`/`RpcEnvelope`) changes in M1 — 0.5.0 peers stay compatible.
- Success criteria to verify at the end: LAN write ≤ 3s; cross-network write ≤ 10s; login/resume catch-up ≤ 30s.
- Windows dev environment; Android builds (not needed for M1) require JDK 17–21.

---

### Task 1: Nudge channel, debounce, bounded retry

**Files:**
- Create: `src-tauri/src/sync/trigger.rs`
- Modify: `src-tauri/src/sync/mod.rs` (module declaration)
- Modify: `src-tauri/src/sync/task.rs:65-116` (`run`, `run_one_pass`)
- Modify: `src-tauri/src/lib.rs` (AppState field, channel creation, launch nudge)

**Interfaces:**
- Produces:
  - `pub enum Nudge { Write, Launch, Resume, Retry(u8) }`
  - `pub fn next_retry_delay(attempt: u8) -> Option<Duration>` — `Some(5s)/Some(15s)/Some(45s)` for attempts 0/1/2, `None` after
  - `pub const DEBOUNCE: Duration` (1.5s)
  - `AppState.sync_nudge: tokio::sync::mpsc::UnboundedSender<Nudge>`
  - `task::run` gains parameter `rx: UnboundedReceiver<Nudge>`
  - `run_one_pass` returns `PassOutcome { attempted: usize, failed: usize }`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/sync/trigger.rs`:

```rust
//! Event-driven sync triggers.
//!
//! The sync loop used to be purely clock-driven (every 20s), which meant a
//! write could sit locally for up to 20s before its first attempt to leave
//! the device — long enough to lose the race against a lid-close. Local
//! mutations, app launch, and Windows resume now nudge the loop through a
//! channel; nudges within [`DEBOUNCE`] coalesce so bulk edits cost one
//! dial, and a failed nudge-triggered pass retries on a bounded backoff
//! before going quiet until the next trigger.

use std::time::Duration;

/// Why the sync loop is being poked. `Retry(n)` carries the attempt count
/// so the backoff schedule stays bounded without extra state in the loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nudge {
    Write,
    Launch,
    Resume,
    Retry(u8),
}

/// Coalescing window: nudges arriving within this of the first are folded
/// into a single pass, so pasting five reminders dials once, not five times.
pub const DEBOUNCE: Duration = Duration::from_millis(1500);

/// Bounded backoff after a failed triggered pass. Three retries, then
/// silence until the next real trigger — no dial storms against a peer
/// that's asleep.
pub fn next_retry_delay(attempt: u8) -> Option<Duration> {
    match attempt {
        0 => Some(Duration::from_secs(5)),
        1 => Some(Duration::from_secs(15)),
        2 => Some(Duration::from_secs(45)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_bounded_and_increasing() {
        let d0 = next_retry_delay(0).unwrap();
        let d1 = next_retry_delay(1).unwrap();
        let d2 = next_retry_delay(2).unwrap();
        assert!(d0 < d1 && d1 < d2, "backoff must increase");
        assert_eq!(next_retry_delay(3), None, "must give up after 3 attempts");
        assert_eq!(next_retry_delay(200), None);
    }
}
```

- [ ] **Step 2: Register the module and verify the test compiles and passes**

In `src-tauri/src/sync/mod.rs`, add `pub mod trigger;` beside the other module declarations.

Run: `cd src-tauri && cargo test trigger::`
Expected: 1 test PASS. (Pure function — written and tested in one step; the loop integration below is the part that can't be unit-tested and is covered by compile + manual.)

- [ ] **Step 3: Rework the sync loop around `select!`**

In `src-tauri/src/sync/task.rs`, replace `run` and give `run_one_pass` an outcome. The loop: a tick fires a plain pass; a nudge debounces, drains coalesced nudges, passes, and on failure schedules a bounded retry by re-sending `Nudge::Retry(n+1)` after a delay.

```rust
use crate::sync::trigger::{next_retry_delay, Nudge, DEBOUNCE};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// Outcome of one pass: how many peers we attempted and how many failed.
/// The trigger loop uses `failed > 0` to decide whether to schedule a retry.
pub struct PassOutcome {
    pub attempted: usize,
    pub failed: usize,
}

pub async fn run(
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
    mut nudges: UnboundedReceiver<Nudge>,
    nudge_tx: UnboundedSender<Nudge>,
) {
    log::info!("sync task online (event-driven)");
    let mut tick = tokio::time::interval(SYNC_INTERVAL);
    tick.tick().await; // first tick fires immediately; skip
    loop {
        let triggered: Option<Nudge> = tokio::select! {
            _ = tick.tick() => None,
            n = nudges.recv() => match n {
                Some(n) => Some(n),
                None => return, // channel closed — app shutting down
            },
        };

        let retry_attempt = if let Some(nudge) = triggered {
            // Coalesce the burst: wait out the debounce window, then drain
            // whatever else arrived. Retry nudges skip the debounce — their
            // delay already happened.
            if !matches!(nudge, Nudge::Retry(_)) {
                tokio::time::sleep(DEBOUNCE).await;
            }
            let mut latest = nudge;
            while let Ok(n) = nudges.try_recv() {
                latest = n;
            }
            match latest {
                Nudge::Retry(n) => n,
                _ => 0,
            }
        } else {
            0
        };

        let outcome = run_one_pass(&db, &app).await;

        // Only nudge-triggered passes retry; the 20s tick is its own retry.
        if triggered.is_some() && outcome.failed > 0 {
            if let Some(delay) = next_retry_delay(retry_attempt) {
                let tx = nudge_tx.clone();
                let next = retry_attempt + 1;
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = tx.send(Nudge::Retry(next));
                });
            } else {
                log::debug!("sync retries exhausted; waiting for next trigger");
            }
        }
    }
}
```

Change `run_one_pass` to count and return (early-return paths return `PassOutcome { attempted: 0, failed: 0 }`):

```rust
pub async fn run_one_pass(db: &Arc<Mutex<Connection>>, app: &AppHandle) -> PassOutcome {
    // ... existing body; in the peer loop:
    let mut attempted = 0usize;
    let mut failed = 0usize;
    for peer in peer_list {
        attempted += 1;
        match with_peer_timeout(sync_one(db, app, &endpoint, &peer), SYNC_PEER_TIMEOUT).await {
            PeerSyncResult::Ok => {}
            PeerSyncResult::Failed(e) => {
                failed += 1;
                log::debug!("sync with {} ({}) failed: {e}", peer.name, peer.id);
            }
            PeerSyncResult::TimedOut => {
                failed += 1;
                log::warn!(/* existing message unchanged */);
            }
        }
    }
    PassOutcome { attempted, failed }
}
```

Callers that ignore the outcome (`commands::sync_now`, `mobile_bg`) need `let _ =` or no change (expression-statement of a non-`#[must_use]` struct is fine).

- [ ] **Step 4: Create the channel in `lib.rs` and send the launch nudge**

In `lib.rs` setup, where the sync task is spawned (search `sync::task::run`):

```rust
let (nudge_tx, nudge_rx) = tokio::sync::mpsc::unbounded_channel::<crate::sync::trigger::Nudge>();
```

Pass `nudge_rx` and a clone of `nudge_tx` into `sync::task::run`, store `nudge_tx.clone()` in `AppState` as `sync_nudge`, and immediately after the iroh endpoint is confirmed up, send the eager launch pass:

```rust
// Eager launch pass — the short-session fix. Klaxon autostarts at login;
// this makes "boot → synced" take seconds instead of waiting for a tick.
let _ = nudge_tx.send(crate::sync::trigger::Nudge::Launch);
```

Add to `AppState`:

```rust
    /// Pokes the sync loop. Send on every local mutation (push-on-write),
    /// at launch, and on Windows resume. Cheap, unbounded, coalesced by
    /// the receiver.
    pub sync_nudge: tokio::sync::mpsc::UnboundedSender<crate::sync::trigger::Nudge>,
```

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result"` — expect 77 passing.
Run: `cd src-tauri && cargo build 2>&1 | grep -c "^warning"` — expect `0`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync/trigger.rs src-tauri/src/sync/mod.rs src-tauri/src/sync/task.rs src-tauri/src/lib.rs
git commit -m "feat(sync): event-driven trigger channel with debounce + bounded retry"
```

---

### Task 2: Push-on-write call sites

**Files:**
- Modify: `src-tauri/src/commands.rs` (every mutating command)

**Interfaces:**
- Consumes: `AppState.sync_nudge`, `Nudge::Write` from Task 1.

- [ ] **Step 1: Add a nudge helper and call it from every mutation**

At the top of `commands.rs` (after imports):

```rust
/// Push-on-write: poke the sync loop after a local mutation so the change
/// leaves this device in ~seconds instead of waiting for the 20s tick.
/// Failures are impossible in practice (unbounded channel); ignore them.
fn nudge_write(state: &State<'_, AppState>) {
    let _ = state.sync_nudge.send(crate::sync::trigger::Nudge::Write);
}
```

Call `nudge_write(&state);` as the last statement before `Ok(...)`/return in **every** command that mutates synced data:

- `create_reminder`, `update_reminder`, `delete_reminder`, `snooze_reminder`, `dismiss_reminder`, `complete_reminder`
- `create_lane`, `rename_lane`, `delete_lane`, `reorder_lanes`, `set_task_lane`
- `create_thought`, `update_thought`, `delete_thought`

Do **not** nudge in read commands, settings commands, or `sync_now` (it already runs a pass). The scheduler's own state flips (`fired`) are deliberately left to the tick — a ringing alarm doesn't need sub-second propagation.

- [ ] **Step 2: Verify**

Run: `cd src-tauri && cargo test 2>&1 | grep "test result"` and `cargo build 2>&1 | grep -c "^warning"`.
Expected: 77 passing, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(sync): push-on-write — every local mutation nudges the sync loop"
```

---

### Task 3: Migration 010 + peer address/diagnostics persistence

**Files:**
- Modify: `src-tauri/src/db/migrations.rs` (append migration 010 + test)
- Modify: `src-tauri/src/db/peers.rs` (Peer fields, persistence functions)

**Interfaces:**
- Produces:
  - Columns on `peers`: `endpoint_addrs TEXT` (JSON `Vec<TransportAddr>`), `addrs_updated_at INTEGER`, `last_sync_ok_at INTEGER`, `last_sync_error TEXT`, `last_sync_error_at INTEGER`
  - `Peer` gains: `pub endpoint_addrs_json: Option<String>`, `pub last_sync_ok_at: Option<i64>`, `pub last_sync_error: Option<String>`, `pub last_sync_error_at: Option<i64>`
  - `pub fn record_sync_ok(conn, peer_id: &str, addrs_json: Option<&str>, now: i64) -> AppResult<()>`
  - `pub fn record_sync_err(conn, peer_id: &str, msg: &str, now: i64) -> AppResult<()>`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `src-tauri/src/db/migrations.rs`:

```rust
    /// Migration 010: the sync loop records per-peer outcomes and
    /// last-known-good addresses. A success must clear a previous error —
    /// stale failure text in Settings would read as "still broken".
    #[test]
    fn migration_010_peer_sync_state_roundtrips() {
        let conn = test_conn();
        conn.execute(
            "INSERT INTO peers (id, name, shared_secret, created_at)
             VALUES ('p1', 'Phone', 's3cret', 1)",
            [],
        )
        .unwrap();

        crate::db::peers::record_sync_err(&conn, "p1", "dial timed out", 100).unwrap();
        let p = crate::db::peers::list_all(&conn)
            .unwrap()
            .into_iter()
            .find(|p| p.id == "p1")
            .unwrap();
        assert_eq!(p.last_sync_error.as_deref(), Some("dial timed out"));
        assert_eq!(p.last_sync_error_at, Some(100));

        crate::db::peers::record_sync_ok(&conn, "p1", Some("[\"fake-addr\"]"), 200).unwrap();
        let p = crate::db::peers::list_all(&conn)
            .unwrap()
            .into_iter()
            .find(|p| p.id == "p1")
            .unwrap();
        assert_eq!(p.last_sync_ok_at, Some(200));
        assert_eq!(p.endpoint_addrs_json.as_deref(), Some("[\"fake-addr\"]"));
        assert!(p.last_sync_error.is_none(), "success must clear the error");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test migration_010`
Expected: FAIL — no such column / function.

- [ ] **Step 3: Write the migration**

Append to the `MIGRATIONS` array in `migrations.rs`:

```rust
    // 010 — sync reliability (v0.5.1 M1).
    //
    // `endpoint_addrs` is the peer's last-known-good iroh addresses
    // (JSON Vec<TransportAddr>: direct socket addrs + relay URL), seeded
    // into Endpoint::connect() so the first dial after launch aims at a
    // concrete target instead of waiting on iroh's address lookup — which
    // we have watched fail ("Address Lookup failed" in the logs).
    //
    // `last_sync_ok_at` / `last_sync_error{,_at}` drive the per-peer
    // status in Sync settings: evidence, not vibes.
    r#"
    ALTER TABLE peers ADD COLUMN endpoint_addrs TEXT;
    ALTER TABLE peers ADD COLUMN addrs_updated_at INTEGER;
    ALTER TABLE peers ADD COLUMN last_sync_ok_at INTEGER;
    ALTER TABLE peers ADD COLUMN last_sync_error TEXT;
    ALTER TABLE peers ADD COLUMN last_sync_error_at INTEGER;
    "#,
```

- [ ] **Step 4: Extend `Peer` and add the two writers**

In `db/peers.rs`: add the four new fields to `Peer`, include the new columns in every `SELECT` and the row-mapper, and append:

```rust
/// Record a successful sync: timestamp, refreshed addresses, and clear any
/// previous error so Settings doesn't show a stale failure.
pub fn record_sync_ok(
    conn: &Connection,
    peer_id: &str,
    addrs_json: Option<&str>,
    now: i64,
) -> AppResult<()> {
    conn.execute(
        "UPDATE peers SET
            last_sync_ok_at = ?2,
            last_sync_error = NULL,
            last_sync_error_at = NULL,
            endpoint_addrs = COALESCE(?3, endpoint_addrs),
            addrs_updated_at = CASE WHEN ?3 IS NULL THEN addrs_updated_at ELSE ?2 END
         WHERE id = ?1",
        params![peer_id, now, addrs_json],
    )?;
    Ok(())
}

/// Record a failed sync attempt. Keeps the last-good addresses — a dial
/// failure doesn't invalidate what worked before.
pub fn record_sync_err(conn: &Connection, peer_id: &str, msg: &str, now: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE peers SET last_sync_error = ?2, last_sync_error_at = ?3 WHERE id = ?1",
        params![peer_id, msg, now],
    )?;
    Ok(())
}
```

- [ ] **Step 5: Verify**

Run: `cd src-tauri && cargo test` — all pass (78), 0 warnings. The compiler will flag every `Peer` literal missing the new fields — fix each with `None`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/db/peers.rs
git commit -m "feat(sync): migration 010 — persisted peer addresses + sync diagnostics"
```

---

### Task 4: Advertise and parse iroh addresses over mDNS

**Files:**
- Modify: `src-tauri/src/sync/discovery.rs`
- Modify: `src-tauri/src/lib.rs` (discovery start call gains the iroh port)

**Interfaces:**
- Produces:
  - `discovery::start(identity, node_id, iroh_port: Option<u16>)` — new third parameter
  - `DiscoveredPeer.sock_addrs: Vec<std::net::SocketAddr>` — the peer's dialable iroh addresses
  - `DiscoveryHandle::addrs_for_node(&self, node_id: &str) -> Vec<std::net::SocketAddr>`
  - TXT key `"addrs"`: comma-joined `ip:port` strings

- [ ] **Step 1: Write the failing test**

Append to `discovery.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{compose_addrs_txt, parse_addrs_txt};
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn addrs_txt_roundtrips() {
        let ips = vec![
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 10)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
        ];
        let txt = compose_addrs_txt(&ips, 54321);
        let parsed = parse_addrs_txt(&txt);
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().all(|sa| sa.port() == 54321));
    }

    #[test]
    fn garbage_addrs_are_skipped_not_fatal() {
        let parsed = parse_addrs_txt("not-an-addr,192.168.1.7:4444,,999.9.9.9:1");
        assert_eq!(parsed.len(), 1, "only the valid entry survives");
    }

    #[test]
    fn empty_txt_parses_to_empty() {
        assert!(parse_addrs_txt("").is_empty());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src-tauri && cargo test discovery::`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement**

In `discovery.rs`:

```rust
use std::net::SocketAddr;

/// Compose the TXT `addrs` value: our LAN IPs each paired with the iroh
/// QUIC port. The mDNS A-record port (`ADVERTISED_PORT`) is cosmetic —
/// this key is what makes discovered peers actually dialable.
/// TXT values are capped at 255 bytes; cap at 6 addresses to stay under.
fn compose_addrs_txt(ips: &[IpAddr], iroh_port: u16) -> String {
    ips.iter()
        .take(6)
        .map(|ip| SocketAddr::new(*ip, iroh_port).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Parse a peer's TXT `addrs` value. Malformed entries are skipped —
/// a peer on a future version with a different format must not break us.
fn parse_addrs_txt(raw: &str) -> Vec<SocketAddr> {
    raw.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect()
}
```

Wire them in:

1. `start(...)` gains `iroh_port: Option<u16>`. When `Some`, add to the TXT props: `props.insert("addrs".to_string(), compose_addrs_txt(&local_ips, port));`
2. `DiscoveredPeer` gains `pub sock_addrs: Vec<SocketAddr>` (add `#[serde(skip)]` — the frontend pairing list doesn't need it). In the `ServiceResolved` arm: `sock_addrs: props.get_property_val_str("addrs").map(parse_addrs_txt).unwrap_or_default(),`
3. Add to `DiscoveryHandle`:

```rust
    /// Dialable iroh addresses for a peer, by its iroh node id — fresh from
    /// the LAN right now, or empty if the peer isn't currently visible.
    pub fn addrs_for_node(&self, node_id: &str) -> Vec<SocketAddr> {
        self.peers
            .lock()
            .values()
            .find(|p| p.node_id.as_deref() == Some(node_id))
            .map(|p| p.sock_addrs.clone())
            .unwrap_or_default()
    }
```

4. In `lib.rs`, the `discovery::start(...)` call site: derive the port from the endpoint — `iroh_node` is started just before discovery; pass `iroh_node.as_ref().and_then(|n| n.endpoint.bound_sockets().first().map(|sa| sa.port()))`. (Adapt to the actual local variable names at the call site; the endpoint is in scope there because its node_id is already passed in.)

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo test` — 81 passing, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync/discovery.rs src-tauri/src/lib.rs
git commit -m "feat(sync): advertise the real iroh port over mDNS; parse peer addresses"
```

---

### Task 5: Seeded dialing + dial diagnostics + address harvesting

**Files:**
- Modify: `src-tauri/src/sync/iroh_client.rs` (`call`, `ping`, `pull`, `push`)
- Modify: `src-tauri/src/sync/task.rs` (`sync_one` assembles addresses, records outcomes)
- Modify: `src-tauri/src/commands.rs` (`ping_peer` adapts to new signature)

**Interfaces:**
- Produces:
  - `pub struct DialInfo { pub duration_ms: u64, pub used_relay: bool, pub remote_addrs_json: Option<String> }`
  - `call`/`ping`/`pull`/`push` gain a `seed_addrs: &[iroh::TransportAddr]` parameter; `pull` and `push` return `(T, DialInfo)`
  - `sync_one` persists outcomes via `peers::record_sync_ok` / `record_sync_err`

- [ ] **Step 1: Extend `call` to seed the dial and harvest the connection**

In `iroh_client.rs`:

```rust
use std::collections::BTreeSet;
use std::time::Instant;

use iroh::{Endpoint, EndpointAddr, EndpointId, TransportAddr};

/// What actually happened on the wire for one RPC dial. Logged for
/// diagnostics and, on success, persisted so the next dial can skip
/// address lookup entirely.
pub struct DialInfo {
    pub duration_ms: u64,
    pub used_relay: bool,
    /// JSON `Vec<TransportAddr>` of the connection's live remote paths —
    /// the freshest possible last-known-good addresses.
    pub remote_addrs_json: Option<String>,
}

async fn call(
    endpoint: &Endpoint,
    node_id: &str,
    seed_addrs: &[TransportAddr],
    shared_secret: &str,
    request: RpcRequest,
) -> AppResult<(RpcResponse, DialInfo)> {
    let id = EndpointId::from_str(node_id)
        .map_err(|e| AppError::Invalid(format!("invalid iroh node_id {node_id:?}: {e}")))?;

    // Seed the dial with everything we know: persisted last-known-good
    // addresses plus mDNS-fresh LAN addresses. With any usable seed, the
    // dial skips iroh's address lookup — the stage we've watched fail
    // ("Address Lookup failed: All address lookup services failed").
    // With no seed it falls back to lookup, exactly as before.
    let addr = EndpointAddr {
        id,
        addrs: seed_addrs.iter().cloned().collect::<BTreeSet<_>>(),
    };

    let started = Instant::now();
    let conn = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(addr, ALPN_SYNC))
        .await
        .map_err(|_| AppError::Invalid(format!("iroh connect timed out after {DIAL_TIMEOUT:?}")))?
        .map_err(|e| AppError::Invalid(format!("iroh connect failed: {e}")))?;
    let duration_ms = started.elapsed().as_millis() as u64;

    // Harvest the live paths before doing any RPC — cheap, and it tells us
    // direct-vs-relay for the log line plus fresh addresses to persist.
    let paths: Vec<TransportAddr> = conn
        .paths()
        .iter()
        .map(|p| p.remote_addr().clone())
        .collect();
    let used_relay = conn.paths().iter().all(|p| p.is_relay());
    let dial = DialInfo {
        duration_ms,
        used_relay,
        remote_addrs_json: serde_json::to_string(&paths).ok().filter(|_| !paths.is_empty()),
    };
    log::debug!(
        "dial {}: {}ms, path={}",
        crate::sync::iroh_node::short(node_id),
        duration_ms,
        if used_relay { "relay" } else { "direct" },
    );

    // ... existing open_bi / write_frame / read_frame / close body unchanged ...

    Ok((resp, dial))
}
```

Update the wrappers: `ping`, `pull`, `push`, each gaining `seed_addrs: &[TransportAddr]` after `node_id` and threading it through. `pull` returns `AppResult<(ChangeSet, DialInfo)>`, `push` returns `AppResult<(PushResponse, DialInfo)>`, `ping` keeps returning just `PingResponse` (drop its `DialInfo` — `commands::ping_peer` passes `&[]` as the seed). `pair_initiate` is unchanged (pairing dials a peer we've never stored).

- [ ] **Step 2: Assemble seeds and record outcomes in `sync_one`**

In `task.rs`, `sync_one` builds the seed before the pull and records the outcome after:

```rust
    // Seed = persisted last-known-good ∪ mDNS-fresh LAN addresses.
    let mut seed: Vec<iroh::TransportAddr> = peer
        .endpoint_addrs_json
        .as_deref()
        .and_then(|j| serde_json::from_str(j).ok())
        .unwrap_or_default();
    if let Some(st) = app.try_state::<crate::AppState>() {
        if let Some(disc) = st.discovery.lock().as_ref() {
            for sa in disc.addrs_for_node(node_id) {
                seed.push(iroh::TransportAddr::Ip(sa));
            }
        }
    }
```

Thread `&seed` into the `pull` and `push` calls. After the pull succeeds, and again after the push (whichever ran last wins), persist:

```rust
    let (pulled, dial) = iroh_client::pull(endpoint, node_id, &seed, &peer.shared_secret, peer.last_pull_at).await?;
    // ... existing apply logic ...
    {
        let conn = db.lock();
        let _ = peers::record_sync_ok(
            &conn,
            &peer.id,
            dial.remote_addrs_json.as_deref(),
            crate::models::now_ms(),
        );
    }
```

And in `run_one_pass`'s failure arms (`Failed`/`TimedOut`), record the error:

```rust
    let conn = db.lock();
    let _ = peers::record_sync_err(&conn, &peer.id, &msg, crate::models::now_ms());
```

where `msg` is `e.to_string()` for `Failed` and `"timed out after 10s — peer unreachable"` for `TimedOut`.

**Check the `TransportAddr` variant name before writing `TransportAddr::Ip`:** run `grep -n "pub enum TransportAddr" -A 8 ~/.cargo/registry/src/*/iroh-base-*/src/endpoint_addr.rs` and use the actual variant that wraps a `SocketAddr`.

- [ ] **Step 3: Verify**

Run: `cd src-tauri && cargo test` — all passing, 0 warnings. The compiler drives the remaining call-site fixes (`commands::ping_peer` passes `&[]`).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync/iroh_client.rs src-tauri/src/sync/task.rs src-tauri/src/commands.rs
git commit -m "feat(sync): seed dials with persisted + mDNS addresses; record dial diagnostics"
```

---

### Task 6: Windows suspend/resume hooks

**Files:**
- Create: `src-tauri/src/power.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration + spawn in setup)
- Modify: `src-tauri/Cargo.toml` (windows dependency)

**Interfaces:**
- Consumes: `AppState.sync_nudge`, `Nudge` from Task 1.
- Produces: `pub fn spawn_power_watcher(nudge: UnboundedSender<Nudge>)` — Windows-only, no-op elsewhere.

- [ ] **Step 1: Add the dependency**

In `src-tauri/Cargo.toml`:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
    "Win32_Foundation",
    "Win32_UI_WindowsAndMessaging",
    "Win32_System_LibraryLoader",
] }
```

(If `cargo build` reports 0.58 conflicts with a transitive tauri dependency, match whatever `windows` version already appears in `cargo tree -i windows 2>/dev/null | head -1`.)

- [ ] **Step 2: Write the watcher**

Create `src-tauri/src/power.rs`:

```rust
//! Windows suspend/resume notifications → sync nudges.
//!
//! Push-on-write means data leaves the device seconds after a write, so
//! there is rarely anything to flush at suspend. The valuable edge is
//! resume: iroh's sockets are stale after sleep and the first dial used to
//! eat the 10s timeout and fail silently. Nudging a pass at resume (with
//! the seeded-dial path from iroh_client) turns wake-up into a fast,
//! evidence-logged catch-up.
//!
//! Implementation: a message-only window on its own thread receiving
//! WM_POWERBROADCAST. Tao/Tauri don't surface these events, and a
//! message-only window (HWND_MESSAGE parent) needs no visible surface.

#![cfg(windows)]

use tokio::sync::mpsc::UnboundedSender;

use crate::sync::trigger::Nudge;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_POWERBROADCAST, WNDCLASSW,
};

// PBT_* constants live in Win32_System_Power in some windows-rs versions;
// they are stable numeric values, so define them locally and skip a feature.
const PBT_APMSUSPEND: usize = 0x0004;
const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

static NUDGE: std::sync::OnceLock<UnboundedSender<Nudge>> = std::sync::OnceLock::new();

extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_POWERBROADCAST {
        match wparam.0 {
            PBT_APMRESUMEAUTOMATIC => {
                log::info!("resume detected — nudging sync");
                if let Some(tx) = NUDGE.get() {
                    let _ = tx.send(Nudge::Resume);
                }
            }
            PBT_APMSUSPEND => {
                // Best-effort: one last nudge. The pass races the OS's
                // suspend deadline and may not finish — push-on-write is
                // the real answer; this is a free extra chance.
                log::info!("suspend imminent — best-effort sync nudge");
                if let Some(tx) = NUDGE.get() {
                    let _ = tx.send(Nudge::Write);
                }
            }
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Spawn the watcher thread. Failures are logged, never fatal — losing
/// power events degrades to the pre-M1 behaviour (tick-driven catch-up).
pub fn spawn_power_watcher(nudge: UnboundedSender<Nudge>) {
    let _ = NUDGE.set(nudge);
    std::thread::Builder::new()
        .name("klaxon-power-watch".into())
        .spawn(|| unsafe {
            let hinstance = match GetModuleHandleW(None) {
                Ok(h) => h,
                Err(e) => {
                    log::warn!("power watcher: GetModuleHandleW failed: {e}");
                    return;
                }
            };
            let class = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance.into(),
                lpszClassName: w!("KlaxonPowerWatch"),
                ..Default::default()
            };
            if RegisterClassW(&class) == 0 {
                log::warn!("power watcher: RegisterClassW failed");
                return;
            }
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("KlaxonPowerWatch"),
                w!(""),
                WINDOW_STYLE(0),
                0, 0, 0, 0,
                HWND_MESSAGE, // message-only window: no surface, just messages
                None,
                hinstance,
                None,
            );
            if hwnd.is_err() {
                log::warn!("power watcher: CreateWindowExW failed");
                return;
            }
            log::info!("power watcher online");
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                DispatchMessageW(&msg);
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("power watcher spawn failed: {e}"));
}
```

(windows-rs API signatures shift between versions — `CreateWindowExW` returning `Result` vs raw `HWND`, `HINSTANCE` conversions. Fix to match the pinned version; the structure stands.)

- [ ] **Step 3: Declare and spawn**

In `lib.rs`:

```rust
#[cfg(windows)]
mod power;
```

In setup, right after the nudge channel exists (Task 1 Step 4):

```rust
#[cfg(windows)]
power::spawn_power_watcher(nudge_tx.clone());
```

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo test` and `cargo build 2>&1 | grep -c "^warning"` — all passing, 0.
Manual: run `npm run tauri dev`, sleep the machine (Start → Sleep), wake it, and confirm the log shows `resume detected — nudging sync` followed by a pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/power.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(sync): Windows suspend/resume hooks nudge the sync loop"
```

---

### Task 7: Per-peer sync status in Settings

**Files:**
- Modify: `src-tauri/src/commands.rs` (`list_peers` / `PeerView`)
- Modify: `src/lib/api.ts` (`PeerView` interface)
- Modify: `src/lib/components/SyncSection.svelte`

**Interfaces:**
- Consumes: `Peer.last_sync_ok_at` / `last_sync_error` / `last_sync_error_at` from Task 3.
- Produces: those three fields on the `PeerView` struct (Rust) and interface (TS).

- [ ] **Step 1: Extend PeerView**

Find the `PeerView` struct in `commands.rs` (it backs `list_peers`) and add:

```rust
    pub last_sync_ok_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub last_sync_error_at: Option<i64>,
```

populated straight from the `Peer` fields in the `list_peers` mapping. Mirror in `src/lib/api.ts`'s `PeerView`:

```ts
  last_sync_ok_at: number | null;
  last_sync_error: string | null;
  last_sync_error_at: number | null;
```

- [ ] **Step 2: Show it in SyncSection**

Read `src/lib/components/SyncSection.svelte` first and follow its existing peer-row markup. Under each peer's name/status line add:

```svelte
  {#if peer.last_sync_error && (!peer.last_sync_ok_at || (peer.last_sync_error_at ?? 0) > peer.last_sync_ok_at)}
    <div class="sync-status err mono-caps-faint" title={peer.last_sync_error}>
      ✗ {relativeTime(peer.last_sync_error_at ?? 0)} · {peer.last_sync_error}
    </div>
  {:else if peer.last_sync_ok_at}
    <div class="sync-status ok mono-caps-faint">
      ✓ synced {relativeTime(peer.last_sync_ok_at)}
    </div>
  {/if}
```

with `import { relativeTime } from "../time";` and modest styling following the file's conventions (`.err` in the failure color, `.ok` muted). The condition prefers the *most recent* of ok/error — an old error must not outrank a fresh success.

- [ ] **Step 3: Verify**

Run: `npx svelte-check --threshold error` — 0 errors. `cd src-tauri && cargo test` — green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src/lib/api.ts src/lib/components/SyncSection.svelte
git commit -m "feat(sync): per-peer last-sync status in Settings"
```

---

### Task 8: End-to-end verification against the success criteria

**Files:** none. Both devices on this branch (wire format is unchanged from 0.5.0, so the phone can stay on 0.5.0 — but the phone only *benefits* from seeded dials once it runs this build too).

- [ ] **Step 1: LAN write ≤ 3s**

Both devices awake, same Wi-Fi, Klaxon open on both. Create a reminder on the desktop; count seconds until it appears on the phone. Repeat phone→desktop. Target ≤ 3s. The dial log line should say `path=direct` with a duration in the low tens of ms.

- [ ] **Step 2: Lid-close race**

Create a reminder on the laptop, close the lid ~3s later. Check the phone: the reminder must be there — push-on-write beat the lid.

- [ ] **Step 3: Resume catch-up**

With the laptop asleep, create a thought on the phone (app open). Wake the laptop, watch the log: `resume detected` → pass → thought visible. Target ≤ 30s from wake.

- [ ] **Step 4: Login catch-up**

Same but reboot the laptop instead of sleeping. After login + autostart, target ≤ 30s.

- [ ] **Step 5: Cross-network ≤ 10s (best-effort now, evidence either way)**

Phone on LTE (Wi-Fi off), both apps open. Create on desktop; target ≤ 10s on the phone. Log should show `path=relay` or direct-after-holepunch. If it exceeds 10s, capture the dial duration from the log — that's the evidence the 10s budget discussion needs.

- [ ] **Step 6: Settings evidence**

Sync settings shows "✓ synced …" per peer; unplug the router / kill the phone's Wi-Fi mid-test and confirm a "✗" row appears with a reason after the next attempt.

- [ ] **Step 7: Changelog + commit**

Add an Unreleased → 0.5.1 section to `CHANGELOG.md` describing M1 (event-driven sync, seeded dials, power hooks, per-peer status).

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for sync reliability M1"
```
