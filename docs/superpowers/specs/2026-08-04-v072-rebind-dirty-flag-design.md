# v0.7.2 — Network Rebind + Dirty-Flag Retirement — Design

**Date:** 2026-08-04
**Status:** Approved (design conversation 2026-08-04)
**Closes:** #3 (endpoint deaf after network migration), #2 (dirty-flag
redesign). Ships as one release with the markdown-notes rendering
already on main (`b5c4392`).

## 1. Network rebind (#3)

Field evidence (2026-08-03): after a Wi-Fi move, both platforms' iroh
endpoints stayed bound to the dead network for hours; a process restart
fixed each instantly. iroh 1.0.3 provides the sanctioned remedy:
`Endpoint::network_change()` — built for exactly the "Android doesn't
expose network changes to native code" case, documented as harmless to
call redundantly. The design is detection per platform + one shared
reaction; **no endpoint teardown**, so the one-identity/one-endpoint
rule is untouched.

### Detection

- **Windows:** `NotifyIpInterfaceChange` (iphlpapi, `windows` crate —
  add `Win32_NetworkManagement_IpHelper` feature). Registered once at
  setup alongside the existing power hooks (`power.rs`); the callback
  fires on interface add/remove/parameter change (Wi-Fi hop, VPN,
  dock). Callback context is a bare OS thread: it must only signal —
  post into the nudge channel / a tokio handle, never touch app state
  directly.
- **Android (warm):** `ConnectivityManager.registerDefaultNetworkCallback`
  registered from Kotlin at app init (MainActivity, alongside the
  existing init JNI). `onAvailable` and `onLost` invoke a new guarded
  JNI export `Java_com_klaxon_app_MainActivity_nativeNetworkChanged`
  (same catch_unwind discipline as the other entry points). No-op when
  the app never finished setup.
- **Android (cold):** immune by construction — each headless pass builds
  a fresh endpoint from the persisted secret and closes it after.

### Reaction (shared, both platforms)

On any detection signal:
1. `endpoint.network_change().await` — tells iroh to re-evaluate
   sockets, paths, and relay connections.
2. Send the existing sync nudge (`Nudge` channel) so a pass runs as
   soon as paths re-form. The channel's 1.5 s debounce absorbs the
   bursts interface events arrive in; `network_change()` itself is
   documented safe to spam, so no extra debounce layer.

The wake-from-sleep path (existing `power.rs` resume hook) additionally
calls `network_change()` — sleep frequently implies a network change and
the machinery is adjacent.

### Error handling

Registration failure (either platform) is logged and non-fatal — the
app degrades to today's behavior. Signals arriving before the endpoint
exists are dropped silently.

## 2. Dirty-flag retirement (#2)

Discovery: since the issue-#1 fix, **no sync selection reads `dirty`**.
All four synced tables (reminders, thoughts, task_lanes, tombstones)
already select by `updated_at`/`deleted_at` against per-peer cursors —
which *is* the per-peer forwarding state issue #2 asked for. The flag
is written on every local mutation and consulted by nobody. Remaining
work is retirement, in strict order:

1. **Mesh regression test first** (proves inertness before any removal):
   three in-process databases A, B, C wired pairwise through the real
   `ops::pull`/`ops::push` with per-peer cursors mimicking `task.rs` —
   assert a reminder, thought, lane, and tombstone created on A reach C
   via B, and that a change applied from a peer (dirty = 0 today)
   forwards onward identically. No iroh involved.
2. **Remove the writes:** drop `dirty` from the four row structs, all
   INSERT/UPDATE statements, the four partial indexes
   (`idx_*_dirty`), and the share-path test assertion (assert on
   `updated_at` instead). `ChangeSet` wire shapes never carried the
   flag — wire format untouched.
3. **Migration 013:** `ALTER TABLE … DROP COLUMN dirty` for the four
   tables (bundled SQLite ≥ 3.35 supports it). Old snapshots restore
   fine — restore runs migrations forward.

Issue #2 closes as "resolved by the watermark architecture; vestige
removed; mesh semantics pinned by test."

## Out of scope

Clock-skew hardening for cross-device `updated_at` comparisons (cursors
advance on row-time maxima, adequate today); any wire change; a third
physical device (the mesh test simulates one).

## Testing & verification

- Rust suite + new mesh test (expected +1 substantial test; total ≥ 110)
  at zero warnings; svelte-check stays 0/0.
- **Hardware rebind drill (the release gate):** both devices running
  v0.7.2 and synced; move the laptop to a different network (phone
  hotspot suffices); without restarting anything, sync must recover
  within ~2 minutes (nudge-on-change + debounce + pass). Repeat in the
  other direction (phone hops networks) if convenient.
- Markdown notes verified visually in the update panel during the
  self-update to v0.7.2 itself.

## Release

v0.7.2: rebind fix (#3), dirty-flag retirement (#2), markdown release
notes (already on main). No wire break — 0.7.1 peers interoperate;
version warnings handle stragglers.
