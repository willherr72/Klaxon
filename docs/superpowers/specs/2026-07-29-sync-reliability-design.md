# Sync Reliability (v0.5.1) — Design

**Status:** Approved, ready for implementation planning
**Date:** 2026-07-29
**Branch:** new branch off `main`
**Author:** William Herr (with Claude)

---

## 1. Problem

Sync works, but slowly enough that in practice it only happens when both
devices have Klaxon open and in use at the same moment. The user's report:
write something on the phone or the laptop, the laptop sleeps or shuts down
(both, roughly evenly — lid-close during the day, shutdown at night), and the
change is stranded until the next time both devices happen to be awake
together. PC sessions are often short, which shrinks the window further.

This is compounding latency, not a single bug. As of v0.5.0:

- **No push-on-write.** Local mutations trigger nothing; the only sync
  triggers are a 20-second timer (`sync/task.rs:33`), the manual `sync_now`
  command, and mobile foregrounding. A write waits up to 20s before its
  first attempt to leave the device.
- **No desktop power handling.** `lib.rs` has no suspend/resume hooks. After
  wake, iroh's sockets are stale; the first dial tends to consume the 10s
  per-peer timeout and fail silently.
- **mDNS discovery is decorative for dialing.** `sync/discovery.rs` browses
  and announces LAN addresses but never calls `add_node_addr`, so dials go
  through iroh's relay/discovery machinery even for a peer one router hop
  away. No last-known-good address is persisted, so the first dial after
  launch aims at nothing.
- **Android background sync is warm-only.** `mobile_bg.rs` deliberately
  no-ops once Android kills the process, so a pocketed phone is unreachable
  and non-initiating until the app is foregrounded.
- **`ShareActivity` cannot trigger sync at all.** It writes from its own
  short-lived process with no iroh endpoint; a shared thought sits until the
  app next opens or a warm WorkManager slot happens to fire.

On a short session these stack: 20s until the first attempt, a slow or
failed dial, retry only on the next tick — the session ends before a pass
completes, which reads as "sync mostly doesn't happen."

## 2. Constraints (standing, re-affirmed)

- **Pure P2P.** No central server, no store-and-forward, no push-trigger
  infrastructure. Privacy is the product.
- **No Android foreground service** and no persistent notification.
- **LAN + both-awake already syncs** — leave that path working; make it
  faster, not different.
- Agreed target from the earlier sync session: background catch-up within
  ~15 min (Android's periodic-job floor) plus instant sync whenever either
  device is actively used.

The physics these constraints impose: sync requires a simultaneous-awake
window. This design maximizes the number of windows and makes each one
count — it cannot and does not promise delivery to a powered-off machine.

## 3. Approach

Two milestones, independently shippable.

| Milestone | Theme | Fixes |
| --- | --- | --- |
| **M1** | Use every awake-window instantly | The lid-close race, slow LAN dials, short sessions, wake-up catch-up |
| **M2** | Create windows while the phone is cold | Pocketed-phone unreachability, share-target latency |

A desktop sync daemon (endpoint in a separate always-on process) was
considered and rejected: close-to-tray plus autostart means the app already
is the resident process; the gap is that it behaves like a timer-driven
batch job instead of an event-driven one.

## 4. M1 — use every awake-window instantly

### 4.1 Triggers: event-driven, not clock-driven

**Push-on-write.** Every local mutation (reminder, task lane, thought,
delete) nudges the sync task via a channel it `select`s on alongside the
existing 20s tick (the tick stays, as the catch-all). Nudges within a
~1.5s debounce window coalesce into one pass so bulk edits don't spam
dials. A failed pass retries on a bounded backoff (~5s / 15s / 45s), then
goes quiet until the next trigger — no infinite retry, no battery drain.
The phone gets this for free: writes there happen while the app is
foregrounded, which is exactly when it can dial.

**Eager launch pass.** Fire a pass at startup, immediately after the iroh
endpoint is up — before UI interaction. Klaxon autostarts at login, so this
is the short-session fix: boot → sync within seconds.

**Resume/suspend hooks (Windows).** On resume: re-warm the endpoint
(rebind sockets), then run a pass. On suspend: one best-effort flush
within the ~2s budget Windows allows; push-on-write means there is rarely
anything left to flush. Implementation detail (message hook vs.
`RegisterSuspendResumeNotification`) is left to the plan.

### 4.2 Dial fast: no relay tax on the LAN

- Feed mDNS-discovered peer addresses into iroh via `add_node_addr` as
  they are observed, so LAN dials go direct immediately.
- Persist last-known-good direct addresses **and the peer's relay URL**
  per peer (new columns on `peers`, **migration 010**) and seed the
  endpoint with them at startup, so the first dial after launch — LAN or
  cross-network — has a concrete target before discovery warms up.

### 4.3 Diagnostics

- Every dial logs outcome, path (direct vs. relay), and duration.
- Per-peer "last sync / last failure and why" surfaced in Sync settings.
- Purpose: the next "it didn't sync" report comes with evidence naming the
  failing stage, not another investigation by feel.

## 5. M2 — create windows while the phone is cold

**Cold-capable WorkManager sync.** The existing ~25-min periodic job
currently calls `nativeSyncOnce`, which no-ops when the process is cold.
Upgrade it: when no live `AppHandle` exists, initialize a headless context —
open the database directly (path known from the Android `Context`), start a
minimal tokio runtime, construct the iroh endpoint from the persisted
identity (`klaxon-iroh-secret.bin`), run one pull/push pass against
persisted peers, tear down.

**Prerequisite refactor:** `run_one_pass` takes `&AppHandle` (for event
emission and alert cancellation). Split the pass core from its
app-integration so the headless path can run it with those effects absent.

**Share-triggered sync.** After a successful save, `ShareActivity` enqueues
an expedited one-shot WorkManager job running the same cold-capable pass, so
a shared link propagates within minutes even with Klaxon fully closed. The
`busy_timeout` added in v0.5.0 already covers the two-process write case.

**Named non-goal (carried from v0.4):** a cold sync delivers *data*; arming
alarms for freshly synced reminders still waits for the next foreground.
Pre-existing limitation, unchanged by this work.

## 6. Success criteria

| Scenario | Target |
| --- | --- |
| Both awake, same LAN, local write | Visible on peer ≤ 3s |
| Both awake, cross-network (iroh relay/holepunch), local write | Visible on peer ≤ 10s — inside the existing 10s per-peer dial budget. Relay-only fallback (failed holepunch) is acceptable; the relay carries ciphertext only. |
| Login / resume, peer reachable | Catch-up pass completes ≤ 30s |
| Phone cold, laptop awake (M2) | Propagation ≤ ~20 min (WorkManager floor + jitter) |
| Android share, app closed (M2) | Propagation within minutes |
| Laptop lid-close | Any write made while a peer was reachable has already been pushed; no flush race |

## 7. Error handling

- Push-on-write failures are silent in the UI (the badge/diagnostics carry
  the state); bounded backoff prevents dial storms against a sleeping peer.
- The suspend flush never blocks sleep beyond the OS budget — it is
  best-effort by construction.
- The cold worker treats any initialization failure (missing identity,
  locked DB, no network) as a clean no-op with a logged reason; it must
  never crash the process or leave a partial endpoint bound.
- Two iroh endpoints must never be live for one identity: the cold worker
  checks for a live `AppHandle` first and yields to the running app.

## 8. Testing

Rust unit tests: debounce/coalesce behavior, backoff schedule, address
persistence round-trip, endpoint seeding from persisted addresses, the
pass-core refactor (pass runs without an `AppHandle`).

Manual matrix (diagnostics make these evidence-based): write → lid-close
within 3s; login → catch-up; resume → catch-up; dial-path log shows
direct on LAN; phone cold + laptop awake (M2); share with app killed (M2).

## 9. Sequencing

- M1 takes **migration 010**. The unmerged calendar branch renumbers again
  (010–012 → 011–013) whenever it rebases.
- M1 ships alone as v0.5.1 if M2's cold-process JNI work drags — M1 fixes
  the reported scenario whenever the phone app is in use.
- Issue #1 (dirty-gated lane/tombstone forwarding) remains separate and is
  not addressed here.
