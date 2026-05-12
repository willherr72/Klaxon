# Klaxon — Design Document

> A self-hosted, open-source reminder app that actually gets your attention.

**Status:** v0.2 in development on `main`. v0.1 released as a tagged binary.
**Last updated:** 2026-05-12

---

## 1. Goal

A reminder app that:

- Lets you set a reminder for a specific date/time with a few clicks
- Fires notifications that **persist** until acknowledged (configurable repeat count + interval)
- Escalates to a **fullscreen popup** for high-priority reminders
- Treats "task" items distinctly — same lifecycle, no alarm
- Runs in the background from system tray, autostarts on login
- Is self-hosted and open source — no cloud dependency, no subscription
- Syncs between paired devices on the same LAN with TLS-encrypted traffic
- Will eventually sync across networks without forcing users to set up Tailscale or port-forward their router

The personality: a klaxon. Loud, clear, hard to ignore — but only when you've asked for it.

---

## 2. Tech Stack

| Layer          | Choice                                            | Why                                                                                  |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Shell          | Tauri 2                                           | Cross-platform (desktop now, mobile later), small binaries, Rust backend             |
| Frontend       | Svelte 5 + TypeScript                             | Lightweight, ergonomic, runes API                                                    |
| Backend        | Rust                                              | One language for scheduler, sync, audio, OS integration                              |
| Storage        | SQLite via `rusqlite`                             | Sync metadata earns its keep early; UUID primary keys ready for distributed use      |
| Async          | `tokio`                                           | Scheduler, sync task, sync server                                                    |
| Audio          | `rodio`                                           | Sine-wave synthesis for built-in tones (Klaxon / Chime / Siren / Pulse)              |
| Sync transport | `axum-server` + `rustls` (server) + `reqwest` w/ pinned cert (client) | HTTPS with self-signed certs; mutual fingerprint pinning instead of CA chain         |
| Discovery      | `mdns-sd`                                         | LAN service announce + browse for paired peers                                       |
| Certificates   | `rcgen` + `rustls-pemfile`                        | Self-signed cert generation; PEM parsing for the SHA-256 fingerprint                 |
| Notifications  | `tauri-plugin-notification` + custom Tauri windows | Native toasts for low priority; own windows for persistent / fullscreen alerts       |
| Tray           | `tauri-plugin-tray` / `tray-icon`                 | System tray menu, background residency                                               |
| Autostart      | `tauri-plugin-autostart`                          | Run on login                                                                         |
| Single instance| `tauri-plugin-single-instance`                    | Second launch focuses existing window                                                |
| Global hotkey  | `tauri-plugin-global-shortcut`                    | System-wide "new reminder" hotkey                                                    |

### Key architectural decisions

- **Persistent alerts come from our own Tauri windows, not OS toasts.** Windows Action Center toasts auto-dismiss and cannot be made to "keep ringing." Driving alert windows ourselves gives us full control over visuals, sound, repeat logic, and fullscreen escalation.

- **TLS with cert pinning, not CA chains.** Sync runs between paired devices that have already exchanged trust during a face-to-face pairing. CAs add nothing in that model. Each device generates a self-signed cert at first run; the SHA-256 fingerprint is exchanged via mDNS TXT + the pairing handshake. A peer with a non-matching fingerprint is rejected at the TLS layer.

- **Last-write-wins by `updated_at`, no Lamport clocks (yet).** Simpler to reason about and adequate for personal sync (2–3 devices, mostly disjoint edits). Tombstones handle deletes. If we hit real-world conflicts we can layer on Lamport clocks without schema changes.

- **Active-state model.** A reminder is `active` (Pending or Snoozed — waiting for the scheduler to ring), `done` (Completed — terminal), or in an intermediate state (Fired = one-shot whose alarm played, Dismissed = user closed the alarm). Fired/Dismissed remain in the active list so the user can complete or delete on their own time; the user doesn't want "I'll come back to it" to disappear.

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Klaxon Process                              │
│                                                                       │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐       │
│  │ Main Window  │   │ Tray Icon    │   │ Alert Windows       │       │
│  │ (Svelte UI)  │   │ (always on)  │   │ (spawned on demand) │       │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬──────────┘       │
│         │                  │                      │                   │
│         └──────────────────┼──────────────────────┘                   │
│                            │ Tauri commands (IPC)                     │
│                            │                                          │
│  ┌─────────────────────────▼─────────────────────────────────────┐   │
│  │                       Rust Backend                              │   │
│  │                                                                 │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐         │   │
│  │  │ Scheduler  │  │ Alert      │  │ Audio engine      │         │   │
│  │  │ (tokio)    │─▶│ Dispatcher │─▶│ (rodio thread)    │         │   │
│  │  └─────┬──────┘  └─────┬──────┘  └──────────────────┘         │   │
│  │        │               │                                       │   │
│  │        │  ┌──────────────────────────┐  ┌──────────────────┐  │   │
│  │        │  │  Sync Task (tokio)        │◀▶│  Sync Server     │  │   │
│  │        │  │  Periodic push/pull       │  │  (axum + rustls) │  │   │
│  │        │  └─────────────┬─────────────┘  └────────┬─────────┘  │   │
│  │        │                │   reqwest+pinned cert    │             │   │
│  │        │                │                          │             │   │
│  │        │  ┌─────────────▼──────────────────────────▼─────────┐ │   │
│  │        │  │       mDNS Discovery (browse + announce)          │ │   │
│  │        │  └───────────────────────────────────────────────────┘ │   │
│  │        ▼               ▼                                         │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │              SQLite (rusqlite, bundled)                   │  │   │
│  │  │  reminders · tombstones · peers · settings · schema_v    │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Process model:** single binary, single process. The scheduler, sync task, and (when enabled) sync server all run as `tokio` tasks. The audio engine lives on a dedicated OS thread because `rodio::OutputStream` has lifetime constraints that don't play nicely with async. mDNS browse runs on its own thread for the same reason (it's a blocking receiver).

**Window lifecycle:** main window can be closed to tray without exiting (`CloseRequested → prevent_close + hide`). Alert windows are short-lived — created when a reminder fires, destroyed when dismissed. Pair-request modal in the main webview listens for `klaxon://pair-request` events emitted from the sync server.

---

## 4. Data Model

### `reminders`

```sql
CREATE TABLE reminders (
    id              TEXT PRIMARY KEY,        -- UUID v4 (sync-ready)
    title           TEXT NOT NULL,
    description     TEXT,
    due_at          INTEGER NOT NULL,        -- unix epoch ms (UTC)
    priority        INTEGER NOT NULL,        -- 0=low, 1=normal, 2=high
    sound_path      TEXT,                    -- reserved; unused
    repeat_rule     TEXT,                    -- JSON; NULL = one-shot
    state           TEXT NOT NULL,           -- pending|fired|snoozed|dismissed|completed
    snooze_until    INTEGER,                 -- unix epoch ms; NULL unless snoozed
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    source          TEXT NOT NULL DEFAULT 'local',  -- local|remote|<provider>
    external_id     TEXT,                    -- ID in source system, if any
    last_synced_at  INTEGER,
    dirty           INTEGER NOT NULL DEFAULT 0,  -- legacy; sync uses updated_at watermarks
    silent          INTEGER NOT NULL DEFAULT 0   -- 1 = "Task", scheduler skips it
);
```

States (current model):

| State       | Set by                             | In active list? | Scheduler will ring? |
| ----------- | ---------------------------------- | --------------- | -------------------- |
| `pending`   | Created or rescheduled             | ✅              | ✅ at `due_at`       |
| `snoozed`   | User snoozed                       | ✅              | ✅ at `snooze_until` |
| `fired`     | Scheduler — one-shot alarm played  | ✅              | ❌                   |
| `dismissed` | User clicked Dismiss on a one-shot | ✅              | ❌                   |
| `completed` | User marked done                   | ❌ → Completed channel | ❌            |

For **recurring** reminders, the scheduler reschedules `due_at` to the next occurrence and keeps the state at `pending`. The `dismiss_reminder` command intentionally does NOT change state when the reminder is recurring or already in `fired`/`dismissed` — that would orphan the next occurrence. Only a `Pending` one-shot transitions to `Dismissed` via Dismiss.

### `tombstones`

```sql
CREATE TABLE tombstones (
    id         TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL,
    dirty      INTEGER NOT NULL DEFAULT 1
);
```

When `delete_reminder` runs, the row is removed from `reminders` and a tombstone is written so peers learn about the deletion through normal sync.

### `peers`

```sql
CREATE TABLE peers (
    id                TEXT PRIMARY KEY,        -- the remote device's device_id
    name              TEXT NOT NULL,
    url               TEXT NOT NULL,           -- https://<host>:<port>
    shared_secret     TEXT NOT NULL,           -- bearer token, exchanged at pair time
    last_pull_at      INTEGER NOT NULL DEFAULT 0,
    last_push_at      INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    last_seen_at      INTEGER,
    cert_fingerprint  TEXT                     -- SHA-256 of peer's leaf cert (DER, hex upper)
);
```

### `settings`

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Default keys (non-exhaustive): per-priority `repeat_count_*` / `repeat_interval_secs_*` / `tone_*`, `global_hotkey_new`, `autostart_enabled`, `sync_enabled`, `sync_port`, `device_id`, `device_name`, `list_sort_order`.

### Migration history

1. Initial: `reminders`, `settings`, `sync_state` (placeholder)
2. v0.2 sync foundation: `peers`, `tombstones`, drop `sync_state`
3. v0.2 TLS: `peers.cert_fingerprint`
4. v0.2 task reminders: `reminders.silent`

`repeat_rule` JSON shape:

```json
{ "kind": "daily" }
{ "kind": "weekly", "weekdays": [1, 3, 5] }
{ "kind": "interval", "every_seconds": 3600 }
{ "kind": "monthly", "day": 15 }
```

---

## 5. Sync architecture (v0.2)

### Pairing handshake (tap-to-pair)

```
Initiator                                Responder
   │                                        │
   │ 1. mDNS browse → finds Responder       │ announces _klaxon._tcp.local
   │    (TXT: device_id, device_name, fp)   │
   │                                        │
   │ 2. User clicks Pair on Responder       │
   │ 3. Generate request_id, ephemeral_token│
   │ 4. Compute SAS = SHA256(req|tok|i|r)   │
   │    Show SAS on initiator screen        │
   │                                        │
   │ 5. POST /klaxon/v1/pair/initiate       │
   │    body: PairRequest with init id +    │
   │    init cert fingerprint               │
   │  ─────────────────────────────────────▶│
   │                                        │ 6. Compute SAS identically
   │                                        │ 7. Emit klaxon://pair-request
   │                                        │    to its UI; show SAS +
   │                                        │    Approve/Decline buttons
   │                                        │
   │                                        │ 8. User taps Approve
   │                                        │ 9. Generate shared_secret
   │                                        │10. Store peer entry for Initiator
   │                                        │    (with init's cert fingerprint)
   │                                        │
   │ 11. PairResponse body returned         │
   │     {responder_id, name, url, secret,  │
   │      cert_fingerprint}                 │
   │ ◀───────────────────────────────────── │
   │                                        │
   │ 12. Verify body fingerprint matches    │
   │     the one from mDNS (rejects MITM)   │
   │ 13. Store peer entry for Responder     │
   │     (with responder's cert fingerprint)│
   │                                        │
   │ 14. Both devices now know each other.  │
   │     Sync task starts pushing/pulling.  │
```

The `pair/initiate` endpoint is the only **unauthenticated** route on the sync server. It's gated by the explicit user-confirmation step. All other routes (`ping`, `sync/pull`, `sync/push`) require a `Bearer <shared_secret>` header.

The SAS is six digits derived from `SHA-256(request_id || ephemeral_token || initiator_id || responder_id)` mod 1,000,000, formatted `NNN-NNN`. Both sides compute it identically. LAN-trusted: a network attacker that can spoof mDNS can also feed the initiator a wrong cert fingerprint. v0.3 (iroh) gets proper PKI for the cross-network case.

### Sync protocol

Endpoints under `/klaxon/v1/` over HTTPS:

| Method | Path                | Description                                           |
| ------ | ------------------- | ----------------------------------------------------- |
| POST   | `/pair/initiate`    | Pairing handshake (unauthenticated)                   |
| GET    | `/ping`             | Health + identity check (auth required)               |
| GET    | `/sync/pull?since=<ms>` | Return reminders + tombstones changed after `since` |
| POST   | `/sync/push`        | Apply incoming reminders + tombstones                 |

The sync task wakes every 20 s. For each paired peer:

1. `client.pull(peer.last_pull_at)` → apply changes locally
2. `client.push(everything updated after peer.last_push_at)` → peer applies
3. Update `peer.last_pull_at` / `last_push_at` watermarks

Per-peer high-water marks avoid echo loops and let the sync survive disconnects. Conflict resolution on apply is **last-write-wins by `updated_at`** with skips for newer local rows and newer tombstones.

### Dismiss/snooze propagation

When sync applies a remote reminder whose new state is `Dismissed`, `Snoozed`, or `Completed`, the local active-alert window for that reminder is cancelled (audio stopped, window closed). Tombstones unconditionally cancel. This means silencing an alarm on one device silences it across all paired devices within one sync cycle.

---

## 6. Project Structure

```
Klaxon/
├── Cargo.lock
├── package.json
├── README.md
├── DESIGN.md
├── CHANGELOG.md
├── LICENSE
├── index.html                 # main app entry
├── alert.html                 # alert window entry (multi-page Vite)
│
├── src/                       # Svelte 5 frontend
│   ├── main.ts                # main app mount
│   ├── alert.ts               # alert window mount
│   ├── App.svelte
│   ├── Alert.svelte
│   ├── app.css                # global theme, fonts, animations
│   └── lib/
│       ├── api.ts             # typed Tauri command wrappers
│       ├── types.ts
│       ├── stores.ts          # reminders / editor / tick state
│       ├── time.ts            # date helpers, effectiveDueAt, countdown
│       ├── shortcut.ts        # hotkey capture helpers
│       └── components/
│           ├── Sidebar.svelte           # 4 primary modes
│           ├── TopBar.svelte            # title + time-filter chips + countdown
│           ├── ReminderList.svelte
│           ├── ReminderItem.svelte
│           ├── ReminderEditor.svelte
│           ├── CalendarView.svelte      # month grid + right-click menu
│           ├── EmptyState.svelte
│           ├── SettingsModal.svelte     # collapsible sections
│           ├── SyncSection.svelte       # peers + discovery + tap-to-pair UI
│           ├── IncomingPairModal.svelte # responder side of tap-to-pair
│           ├── SignalLight.svelte
│           └── StatusBar.svelte
│
└── src-tauri/                 # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs            # binary entry
        ├── lib.rs             # tauri::Builder setup, AppState
        ├── models.rs          # Reminder, Priority, RepeatRule, ReminderState
        ├── error.rs           # AppError + serde
        ├── recurrence.rs      # pure next_after logic + 9 unit tests
        ├── scheduler.rs       # tokio task: wake → dispatch → reschedule
        ├── audio.rs           # rodio thread + TonePattern + AudioCmd
        ├── tray.rs            # tray menu + click handlers
        ├── commands.rs        # all Tauri commands
        ├── alerts/
        │   ├── mod.rs         # dispatch by priority + repeating audio
        │   ├── toast.rs       # low priority (native toast)
        │   ├── popup.rs       # normal priority (corner window)
        │   └── fullscreen.rs  # high priority (fullscreen window)
        ├── db/
        │   ├── mod.rs
        │   ├── migrations.rs
        │   ├── reminders.rs
        │   ├── tombstones.rs
        │   ├── peers.rs
        │   └── settings.rs
        └── sync/
            ├── mod.rs         # identity, secret gen, SAS, local_url
            ├── types.rs       # wire types (ChangeSet, PairRequest, etc.)
            ├── tls.rs         # cert load/generate, pinned client config
            ├── server.rs      # axum HTTPS + pair endpoint
            ├── client.rs      # reqwest with cert pinning
            ├── discovery.rs   # mDNS announce + browse
            └── task.rs        # periodic push/pull loop
```

---

## 7. Core Flows

### 7.1 Scheduler

A single `tokio` task running this loop:

```
loop:
    next = SELECT * FROM reminders
           WHERE state IN ('pending', 'snoozed') AND silent = 0
           ORDER BY COALESCE(snooze_until, due_at) ASC
           LIMIT 1

    if next is None:
        await poke from command-side mpsc channel
        continue

    sleep until min(effective_time(next), poke channel)

    if poked:
        continue   // re-query; something changed

    fire(next)    // alerts::dispatch + reschedule recurring / mark Fired
```

The `mpsc::UnboundedSender<SchedulerMsg>` in `AppState` is poked by every command that mutates a reminder (create / update / snooze / dismiss / complete / delete) so the scheduler immediately re-evaluates its next wake target.

### 7.2 Alert dispatch

```rust
fn fire(r: &Reminder) {
    match r.priority {
        Priority::Low    => toast::show(r),         // native OS toast
        Priority::Normal => popup::spawn(r),        // corner window + repeating audio
        Priority::High   => fullscreen::spawn(r),   // fullscreen window + escalating audio
    }
}
```

Multi-monitor: popup and fullscreen anchor to the monitor that currently contains the main window (fallback: primary). Audio is dispatched to the audio engine thread via `mpsc::Sender<AudioCmd>`. The tone pattern (Klaxon / Chime / Siren / Pulse) is per-priority from settings.

### 7.3 Persistent alert behavior

When an alert spawns, `alerts::start_repeating_audio` kicks off a `tokio` task that:

1. Reads `repeat_count_<priority>` and `repeat_interval_secs_<priority>` from settings
2. Reads `tone_<priority>` to know which tone to play
3. Loops: send `AudioCmd::Play`, sleep in 250 ms slices, check cancel flag

Cancellation is via an `Arc<AtomicBool>` stored in `AppState.active_alerts` keyed by reminder id. `dismiss_reminder` / `snooze_reminder` / `complete_reminder` flip the flag, send `AudioCmd::Stop`, and close the alert window.

### 7.4 Recurrence

`recurrence::next_after(rule, last_due_at, now)` returns the next `due_at > now`. Single function, fully unit-tested, no I/O. Covers daily, weekly (with weekday picker), interval, and monthly with the 28-day clamp.

---

## 8. v0.1 Scope (shipped)

- [x] Reminder CRUD
- [x] Three priority tiers with distinct alert behaviors (toast / popup / fullscreen)
- [x] One-shot reminders
- [x] Recurring reminders: daily, weekly, custom interval, monthly
- [x] Snooze with 5/15/60 presets + custom
- [x] Dismiss + Complete
- [x] Persistent alerts: configurable repeat count + interval per priority
- [x] System tray with quick-add, close-to-tray, single-instance enforcement
- [x] Autostart on login (toggle in settings)
- [x] Configurable global hotkey + in-app Ctrl+N
- [x] Settings panel with sound (default tone) and tuning
- [x] SQLite with UUID primary keys (sync-ready)
- [x] Migration system

## 9. v0.2 Scope (in `0.2.0-dev`)

Shipped on `main`:

- [x] Sync backend: HTTPS server, sync task, tombstones for deletes
- [x] mDNS discovery + tap-to-pair handshake with 6-digit SAS
- [x] TLS with self-signed certs, mutual fingerprint pinning
- [x] Dismiss/snooze propagation across paired devices
- [x] Task reminders (silent flag)
- [x] Calendar view with right-click context menu
- [x] Search (Ctrl+F) + Sort order setting
- [x] Sidebar refactor (4 primary modes) + TopBar time filter chips
- [x] Per-priority tone picker with Preview
- [x] Multi-monitor alert positioning
- [x] CPU optimizations (pause when hidden, slow tick when no sub-day countdown)
- [x] Collapsible Settings sections

Still pending before tagging v0.2.0:

- [ ] Cross-device sync validated on real hardware (waiting on a second machine)
- [ ] Potentially: TLS handshake fallback / "remind again" action for Fired one-shots

## 10. v0.3 Roadmap — Remote Sync via iroh

- Switch the sync transport from HTTPS-over-LAN to `iroh` peer-to-peer streams
- Devices identify each other by NodeId (public key) instead of URL
- iroh's built-in NAT traversal + relay fallback handles cross-network connectivity
- Pairing flow: replace mDNS+SAS with NodeId QR codes or short paste-able tokens
- Keep the existing protocol (ChangeSet wire format) — just swap the transport layer

## 11. v0.4 Roadmap — Calendar Integrations

- Microsoft Graph (Outlook + Teams)
- Google Calendar
- CalDAV
- Each integration becomes a `source` value; reminders carry `external_id` for two-way mapping
- Start with one-way (calendar → reminder) before attempting bidirectional sync

## 12. v0.5 Roadmap — Shared Groups (opt-in)

- Reminders can belong to a `group_id`. Default is the personal (private) group.
- Joining a group is an explicit invitation/accept flow — never automatic, never bulk.
- Sync only sends a reminder to peers who are members of its group.
- Each group has its own symmetric key; reminder payloads in shared groups are encrypted at rest and on the wire so peers outside the group cannot read them even if they intercept traffic.
- Leaving a group rotates the key for remaining members.
- UI clearly distinguishes shared vs private reminders (badge, color) so users know what they're sharing.

This needs careful threat-model work before implementation — it's the highest-leakage-risk feature in the roadmap. Likely a separate design doc when it lands.

## 13. v1.0 Roadmap — Mobile

- Tauri 2 mobile (iOS + Android)
- Reuse Rust scheduler + sync core, port Svelte UI
- Mobile-specific work: native push for high-priority alerts (since mobile OSes restrict background audio loops)

---

## 14. Open Questions / Known Limitations

- **Focus stealing on Windows:** how aggressive can we be with high-priority fullscreen alerts? Windows actively resists focus theft. May need `AllowSetForegroundWindow` or AttachThreadInput tricks if real-world testing shows the alert losing focus to active apps.
- **Audio when system is muted:** high-priority alerts can't override system mute (OS limitation). Visual flash/strobe could compensate but isn't implemented.
- **Sleeping laptops:** if the laptop is asleep when a reminder is due, we miss the alarm — `WaitableTimer` with `WT_EXECUTEINTIMERTHREAD` can wake from sleep but needs elevated permissions and may surprise users. Default off.
- **Time zones / DST:** stored as UTC unix epoch, rendered in local time. Recurring "every Tuesday 9 AM" is computed against the user's current local zone, not the original creation zone — right for travelers, but worth documenting.
- **mDNS spoofing on hostile networks** — pre-pairing trust comes from the mDNS-advertised fingerprint. A hostile LAN could spoof. Acceptable for trusted home WiFi; v0.3 iroh PKI solves it more thoroughly.

---

## 15. License & Distribution

- **MIT** (see `LICENSE`)
- Distribution: GitHub Releases with prebuilt NSIS installers for Windows (later: macOS, Linux, mobile stores)
- No telemetry, no analytics, no phone-home
