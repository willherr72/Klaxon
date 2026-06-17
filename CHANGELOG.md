# Changelog

All notable changes to Klaxon are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-06-17

Klaxon goes **mobile**. v0.4 brings the app to Android (Tauri 2 mobile), reusing the Rust scheduler + iroh sync core under a touch-friendly Svelte UI — plus native notification action buttons, a warm-only background sync, and a batch of fixes.

> Roadmap note: mobile was originally slated for v1.0; it was pulled forward to v0.4. Calendar integrations (the previous v0.4 plan) move to a later release.

### Added

- **Android app (Tauri 2 mobile).** The full Klaxon UI runs on Android, reusing the Rust scheduler, recurrence, and iroh sync core under a touch-first Svelte UI.
- **Native notifications with action buttons.** Scheduled reminders post through per-priority OS notification channels (low / normal / high importance, heads-up for high). Each notification carries **Snooze 10m** and **Dismiss** buttons, and tapping the body deep-links into the editor for that reminder. Ships with a vendored fork of `tauri-plugin-notification` 2.3.3 that fixes an upstream bug where action-button titles rendered empty.
- **Warm-only background sync (Android).** A WorkManager job runs one iroh pull/push pass roughly every 25 minutes while the app's process is resident, so paired-device data stays fresh without the app in the foreground. A Kotlin worker calls a JNI entry point into Rust that reuses the existing sync pass. (Cold-process sync and arming alarms in the background are intentionally out of scope for this step.)
- **Sync-on-foreground.** Returning the app to the foreground triggers an immediate sync pass.
- **Touch drag-and-drop** on the Tasks board (via `svelte-dnd-action`) so cards and lanes move on mobile, not just desktop.
- **Editor lane picker** — a Klaxon-styled chip row replaces the native `<select>` for a task's lane.
- **Mobile editor sheet, Android back-button handling, klaxon-lamp app icons, and Settings polish.**

### Changed

- **Editor "Done" action.** The reminder/task editor now has a **✓ Done** button (next to Delete) to complete the item directly.
- **Per-priority notification channels** drive importance, heads-up display, vibration, and lights on Android.

### Fixed

- **Per-peer sync timeout.** Each peer's sync attempt is bounded to 10 seconds; an unreachable peer can no longer stall the whole pass (which previously hung the sync loop and, on mobile, held the background worker until the OS killed it). Shared by the desktop loop, the foreground loop, and the mobile background worker.
- **Tasks can be completed, not only deleted** — via the editor's new Done button.
- **Converting a reminder to a task no longer makes it vanish.** A silent reminder saved without an explicit lane is now assigned the default (Todo) lane, instead of becoming laneless and invisible in both the Reminders list and the Tasks board. (Root cause: a serde `Option<Option<_>>` collapse made the update path treat an explicit `null` lane as "unchanged.")
- **The Upcoming filter now shows everything still to come** — items due later today plus all future days — instead of only strictly-future days, which often looked empty.
- **Reminder-row action buttons stay visible** instead of revealing on hover, eliminating a touch misclick where an invisible-but-hit-testable button swallowed taps.

### Schema / sync

- No schema changes; the `ChangeSet` wire format is unchanged, so mobile and desktop peers sync identically.

---

## [0.3.1] — 2026-05-20

User-defined swim lanes for the Tasks panel. Same scope as rc.1 — promoted to stable after live-testing the DnD + sync paths.

### Added

- **Swim-lane Tasks board.** Replaces the flat Tasks list. Lanes are first-class rows the user can create / rename / reorder / delete.
- **`Todo` is the seed lane** (deterministic UUID so two devices upgrading to v0.3.1 converge on a single row after first sync). Cannot be deleted; surfaces a muted `DEFAULT` badge in its header. Tasks orphaned by a lane-delete cascade here.
- **Drag-and-drop** between lanes (moves the task) and on lane headers (reorders the columns). Cards within a lane sort by `updated_at desc` so a freshly-moved card pops to the top of its new column.
- **`+ Add task` per column** opens the editor pre-set to `silent: true` and the column's lane id.
- **Lane delete confirmation modal** — Klaxon-styled, replaces the native `confirm()` and explains the cascade-to-default behavior.
- **`ConfirmModal` component** for future destructive flows.

### Schema

- Migration 008 adds the `task_lanes` table and the `reminders.task_lane_id` column. Seeds the `Todo` lane and points all existing silent reminders at it.

### Sync

- `ChangeSet.lanes` flows lane creates/renames/reorders through Pull/Push, last-write-wins by `updated_at`. Lane deletes ride the shared `tombstones` table. Field is `#[serde(default)]` so v0.3.0 peers ignore it gracefully — same-version peers stay in sync; cross-version pairs sync reminders but not lane definitions until both sides upgrade.

### Fixed

- **Tauri DnD** — set `dragDropEnabled: false` on the main window so HTML5 drag events reach the webview. Without it Tauri 2's OS-level file-drop handler eats every drag before it can fire `dragstart` in the frontend.
- **Card user-select** — set `user-select: none` on cards and lane headers so Chromium starts an element drag instead of a text-selection drag.

---

## [0.3.1-rc.1] — 2026-05-20

First RC of v0.3.1. The Tasks panel is now a Kanban board with user-defined swim lanes.

### Added

- **Swim-lane Tasks board.** Replaces the flat Tasks list. Lanes are first-class rows the user can create / rename / reorder / delete.
- **`Todo` is the seed lane** (deterministic UUID so two devices upgrading to v0.3.1 converge on a single row after first sync). Cannot be deleted; surfaces a muted `DEFAULT` badge in its header. Tasks orphaned by a lane-delete cascade here.
- **Drag-and-drop** between lanes (moves the task) and on lane headers (reorders the columns). Cards within a lane sort by `updated_at desc` so a freshly-moved card pops to the top of its new column.
- **`+ Add task` per column** opens the editor pre-set to `silent: true` and the column's lane id.
- **Lane delete confirmation modal** — Klaxon-styled, replaces the native `confirm()` and explains the cascade-to-default behavior.
- **`ConfirmModal` component** for future destructive flows.

### Schema

- Migration 008 adds the `task_lanes` table and the `reminders.task_lane_id` column. Seeds the `Todo` lane and points all existing silent reminders at it.

### Sync

- `ChangeSet.lanes` flows lane creates/renames/reorders through Pull/Push, last-write-wins by `updated_at`. Lane deletes ride the shared `tombstones` table. Field is `#[serde(default)]` so v0.3.0 peers ignore it gracefully — same-version peers stay in sync; cross-version pairs sync reminders but not lane definitions until both sides upgrade.

### Fixed

- **Tauri DnD** — set `dragDropEnabled: false` on the main window so HTML5 drag events reach the webview. Without it Tauri's OS-level file-drop handler eats every drag before it can fire `dragstart` in the frontend.
- **Card user-select** — set `user-select: none` on cards and lane headers so Chromium starts an element drag instead of a text-selection drag (would otherwise show a "no drop" cursor).

---

## [0.3.0] — 2026-05-20

Klaxon syncs **across networks** — peers on different LANs, behind different NATs, even on different platforms can pair and stay in sync via iroh's QUIC + relay network.

### Added

- **iroh transport.** Each device gets a stable `NodeId` (Ed25519 pubkey, persisted in app data dir). The single iroh `Endpoint` accepts two ALPNs:
  - `klaxon/sync/0` — authenticated RPC (Ping / Pull / Push), one bidi stream per call, length-prefixed `postcard` envelope, per-pair shared secret in the envelope.
  - `klaxon/pair/0` — pre-auth pair handshake.
- **Cross-network reachability** via n0's relay network + hole punching. Same connection auto-picks direct LAN when both peers are on the same network, falls back to relays when not.
- **Pairing tickets** — a single base32 string IS the device's pairing token. Settings → Sync → 'Pairing ticket' opens a modal with the ticket as a QR code (klaxon-amber on near-black, scan-friendly for the mobile client when it lands) plus a Copy button. A 'Pair from a ticket' input in the same modal accepts a pasted ticket from the other device.
- **mDNS still works** for same-LAN tap-to-pair — TXT record carries the `NodeId` so the handshake routes through iroh from the first byte.
- **NodeId-based SAS.** The 6-digit pairing code is derived from both peers' `NodeId`s, not their `device_id`s. Lets ticket pairing work without the initiator knowing the responder's identity ahead of time.
- **Version row in System Config** now reads from `tauri.conf.json` at runtime so it can't drift away from what was actually built.

### Changed

- Sync section in Settings: "LAN Sync" → "Sync"; copy reflects iroh / direct-LAN / relay behavior. Device-identity row shows the iroh node id and a 'Pairing ticket' button next to Copy.
- "Next in" countdown now skips silent tasks and past-due reminders, so a forgotten silent task can't peg the countdown at 00:00:00.

### Removed

- HTTPS transport entirely. `sync::server`, `sync::client`, `sync::tls` deleted; `axum`, `axum-server`, `tower`, `tower-http`, `reqwest`, `rcgen`, `rustls-pemfile` deps dropped. `peers.url` and `peers.cert_fingerprint` schema columns dropped (migration 007). `DeviceInfo.sync_port` / `sync_url_hint` gone — there's no more URL.
- Manual `Add Peer` form (URL + cert fingerprint + secret) — replaced by the pairing-ticket modal.

### Migration from 0.2.x

- **Database is forward-compatible.** Migrations 001-007 run automatically on first launch under 0.3.0.
- **Existing pairs must be re-paired.** Peers paired under 0.2.x have a `NULL` `iroh_node_id` and the sync task hard-skips them. Use Sync → tap-to-pair (or paste a ticket) once on each side after both devices are on 0.3.0.

---

## [0.3.0-rc.3] — 2026-05-19

Hotfix for ticket pairing surfaced during the rc.2 cross-platform validation pass.

### Fixed

- **Ticket pairing failed with "CONNECTION LOST" before the responder's ack could be read.** `PairHandler::accept` returned as soon as it wrote the `PairAck` frame, which let iroh's router tear down the QUIC connection before the initiator's `read_frame` could drain the ack from its receive buffer. Fixed by holding the connection until the initiator gracefully closes it (matches the pattern in iroh's own `Echo` example).
- **Ticket modal stayed open on top of the SAS-confirmation modal.** Submitting a ticket now closes the ticket modal immediately so the pair-progress overlay isn't stacked on top of it.

---

## [0.3.0-rc.2] — 2026-05-19

Second release candidate. Phases 3c and 3d landed on top of rc.1.

### Removed

- **HTTPS transport entirely.** `sync::server`, `sync::client`, `sync::tls` modules deleted; `axum`, `axum-server`, `tower`, `tower-http`, `reqwest`, `rcgen`, `rustls-pemfile` Cargo deps dropped.
- `peers.url` and `peers.cert_fingerprint` schema columns dropped (migration 007).
- `DiscoveredPeer.url` / `DiscoveredPeer.cert_fingerprint`, `PeerView.url`, `DeviceInfo.{sync_port, sync_url_hint}`, `AddPeerInput.{url, cert_fingerprint}` — all gone. The UI no longer collects URLs or fingerprints anywhere.
- `ping_peer_iroh` command merged into the single `ping_peer`.

### Added

- **Pair handshake over iroh** — new `klaxon/pair/0` ALPN with `sync::pair_handler` mirroring the old HTTPS handshake (SAS code, user Approve/Decline, oneshot decision channel).
- **Pairing tickets** — replaces the manual "Add Peer" form. New `Pairing ticket` button in Sync settings opens a modal with the device's NodeId rendered as a QR code (klaxon-amber on near-black, 240px) plus the base32 string with a Copy button. A "Pair from a ticket" input in the same modal accepts a pasted ticket and starts the standard SAS handshake.
- **NodeId-based SAS.** `confirmation_code` now derives the 6-digit pairing code from both peers' NodeIds instead of their `device_id`s. Lets ticket pairing work without knowing the responder's `device_id` up front.
- `qrcode` npm dep for client-side QR generation.

### Changed

- `start_pair_with` Tauri command drops its `peer_id` argument — the peer's `device_id` is now learned from `PairAck`, not required up front.
- `klaxon://pair-progress` event payload: `peer_id` field renamed to `peer_node_id`.

---

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
