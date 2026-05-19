# Changelog

All notable changes to Klaxon are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.3.0-rc.1] — 2026-05-19

First release candidate of the v0.3 iroh transport. Cross-network sync via iroh's QUIC + relay network; LAN HTTPS fallback retained for pairs that haven't re-paired since the upgrade.

### Added

- **iroh transport** for cross-network sync.
  - Each device generates and persists a 32-byte Ed25519 secret key on first run (`klaxon-iroh-secret.bin` in the app data dir). The matching public key is the device's stable `NodeId`.
  - Endpoint is bound on app start with `iroh::presets::N0` — uses n0's public relay network for hole-punching and address discovery.
  - `klaxon/sync/0` ALPN with a length-prefixed `postcard` RPC envelope: `Ping`, `Pull{since}`, `Push(ChangeSet)`. Auth is the per-pair shared secret carried inside the envelope.
- **Pair handshake carries node_id.** `PairRequest` and `PairResponse` gained optional `initiator_iroh_node_id` / `responder_iroh_node_id` fields. Both sides persist the other's NodeId on the new `peers.iroh_node_id` column (migration 006).
- **mDNS TXT records now include `nid`** (the device's iroh NodeId) so LAN-discovered peers carry their NodeId from the start.
- **Sync task auto-selects transport per peer.** If the peer has an `iroh_node_id` and our local endpoint is up, sync rides iroh; otherwise it falls back to the v0.2 HTTPS path. The per-tick debug log records which transport was used.
- **Debug `Ping (iroh)` action** in the Sync settings, next to the existing HTTPS Ping. Appears only for peers paired on v0.3+.

### Changed

- **Internal refactor:** the per-RPC logic (Ping / Pull / Push) lives in a new transport-agnostic `sync::ops` module. Both the HTTPS server and the iroh ProtocolHandler dispatch into it — single source of truth.
- **iroh log verbosity dialed down.** `env_logger` filter explicitly silences `iroh::*` and `iroh::net_report` span-entry events so the terminal stays useful for app debugging.

### Known limitations

- v0.2 peers won't sync via iroh until both sides re-pair. The HTTPS path keeps them working in the meantime.
- The end-to-end iroh RPC test is currently disabled on Windows due to a STATUS_ENTRYPOINT_NOT_FOUND when `iroh::Endpoint::bind` is reachable from `#[cfg(test)]`. Production builds are unaffected; documented at the top of `sync/iroh_handler.rs`.
- No QR-code or ticket-string pairing yet — cross-network bootstrap still requires the first pair to happen on the same LAN.

---

## [Unreleased] — 0.2.0-dev

Tagged release pending: cross-device sync needs to be validated on a second physical machine before `v0.2.0`.

### Added

- **LAN sync** between paired devices on the same network.
  - Embedded HTTPS server (axum + rustls) on port 7124 by default.
  - mDNS auto-discovery — devices announce themselves as `_klaxon._tcp.local.` and browse for others.
  - Tap-to-pair handshake with a 6-digit confirmation code shown identically on both screens.
  - TLS with self-signed certs; SHA-256 fingerprints exchanged via mDNS + the pair body and pinned per peer.
  - Per-pair shared-secret bearer auth on top of TLS.
  - Background sync task every 20 s: last-write-wins delta sync by `updated_at`, with tombstones for deletes.
  - Dismiss / snooze / complete on one paired device cancels the local alert on every other paired device once the change propagates.
- **Task reminders** — a "silent" flag turns a reminder into a to-do item that appears in the list but never rings. New `Tasks` channel in the sidebar.
- **Calendar view** — month grid with prev/next/today nav, reminder pills, today highlight, dim past/out-of-month cells.
- **Right-click on a calendar cell** opens a context menu (`Make Reminder` / `Make Task`) that pre-fills the editor's date.
- **Text search** (`Ctrl+F`) — slide-down search row filters by title and description.
- **Sort order** preference in System Config (oldest → newest, newest → oldest).
- **Per-priority tone picker** — choose between Klaxon, Chime, Siren, Pulse, with a Preview button.
- **Configurable global hotkey** with a "press to record" widget in Settings.
- **Multi-monitor aware alert positioning** — popup and fullscreen alerts appear on the monitor that contains the main window.
- **Collapsible Settings sections** — all sections start collapsed; click a header to expand the one you're editing.
- **Smooth LED animations** — brand light and scheduler-active indicator now breathe instead of stuttering.
- **Effective-time display** — snoozed reminders show their next-fire time in the list and calendar with a `⏱ snoozed` badge, so the countdown lines up with what you see.
- **Rang badge** — fired and dismissed reminders stay in the active list with a small `● rang` badge instead of vanishing.
- **Delete key on a focused reminder** removes it (no confirm, matching the row's `×` button).
- **CHANGELOG.md** (this file).

### Changed

- **Sidebar nav** condensed to four primary modes (`Reminders`, `Tasks`, `Calendar`, `Completed`). Time filters (`Today`, `Upcoming`, `Recurring`, `All`) moved into the top bar as chips that apply to the Reminders and Tasks modes.
- **State semantics clarified.** `Fired` and `Dismissed` no longer count as "done" — they stay in the active list so the user can come back to them.
- **Dismiss on recurring reminders no longer kills the series.** Previously `dismiss_reminder` set state to `Dismissed` unconditionally, which clobbered the scheduler's rescheduled `Pending` state and prevented future occurrences from firing. Now Dismiss is "stop the audio, no state change" for items the scheduler is still going to ring.
- **Editor reseeds form state every time it opens** (previously, reopening "New Reminder" twice would keep the previous title).
- **CPU-aware ticker.** The 1 Hz now-tick is paused when the window is hidden and slowed to 30 s when the soonest countdown is >1 day away. Brings the `WebView2: Klaxon` process close to zero CPU when running invisibly.
- **URL scheme** for sync changed from `http://` to `https://`; mDNS announces include a `fp` TXT record with the cert fingerprint.

### Migration

Schema migrations applied automatically on startup:

- `002` — added `peers` and `tombstones` tables, dropped placeholder `sync_state`.
- `003` — added `peers.cert_fingerprint`.
- `004` — added `reminders.silent`.

Existing peer rows from a pre-TLS DB will have `cert_fingerprint = NULL`; sync to those peers fails fast with a clear "re-pair the device" message. There are no production v0.2-dev users yet, so this is benign.

---

## [0.1.0] — 2026-05-06

### Added

- **Single-device reminder app.**
- Three priority tiers with distinct alert behaviors:
  - **Low** — native OS toast (fire-and-forget).
  - **Normal** — always-on-top corner popup with a repeating two-tone alarm.
  - **High** — fullscreen window with an urgent escalating tone, demands dismissal.
- Persistent alerts — configurable repeat count + interval per priority tier.
- Snooze presets (5 / 15 / 60 min) and a custom-duration picker in the alert.
- Recurring reminders: daily, weekdays (Mon–Fri), every-N-seconds, monthly. 9 unit tests covering `recurrence::next_after` including DST and the 28-day month clamp.
- System tray with quick-add, close-to-tray (X hides the window instead of quitting), single-instance enforcement.
- Autostart on login (toggle in Settings).
- Configurable global hotkey (default `Ctrl+Alt+N`) + in-app `Ctrl+N`.
- Settings panel: repeat count + interval per priority, autostart, hotkey, data-folder reveal.
- SQLite persistence with UUID primary keys (sync-ready from day one).
- Migration system.
- NSIS + MSI installers via `npm run tauri build`.

[Unreleased]: https://github.com/willherr72/Klaxon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/willherr72/Klaxon/releases/tag/v0.1.0
