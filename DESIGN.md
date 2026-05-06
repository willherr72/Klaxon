# Klaxon — Design Document

> A self-hosted, open-source reminder app that actually gets your attention.

**Status:** Design — pre-implementation
**Last updated:** 2026-05-06

---

## 1. Goal

A reminder app that:

- Lets you set a reminder for a specific date/time with a few clicks
- Fires notifications that **persist** until acknowledged (configurable repeat count + interval)
- Escalates to a **fullscreen popup** for high-priority reminders
- Runs in the background from system tray, autostarts on login
- Is self-hosted and open source — no cloud dependency, no subscription
- Eventually syncs across desktop + mobile devices without forcing users to set up Tailscale or port-forward their router

The personality: a klaxon. Loud, clear, hard to ignore — but only when you've asked for it.

---

## 2. Tech Stack

| Layer        | Choice                              | Why                                                                                  |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| Shell        | Tauri 2                             | Cross-platform (desktop now, mobile later), small binaries, Rust backend              |
| Frontend     | Svelte 5 + TypeScript               | Lightweight, ergonomic, plays nicely with Tauri                                      |
| Backend      | Rust                                | One language for scheduler, sync, audio, OS integration                               |
| Storage      | SQLite via `rusqlite`               | Sync metadata earns its keep early; UUID primary keys ready for distributed use       |
| Async        | `tokio`                             | Scheduler, future sync server                                                         |
| Audio        | `rodio`                             | Play/loop alert sounds                                                                |
| Notifications | `tauri-plugin-notification` + custom Tauri windows | Native toasts for low priority; own windows for persistent/fullscreen alerts |
| Tray         | `tauri-plugin-tray` / `tray-icon`   | System tray menu, background residency                                                |
| Autostart    | `tauri-plugin-autostart`            | Run on login                                                                          |

### Key Architectural Decision: Why Own Windows for Alerts

Windows toasts auto-dismiss and cannot be made to "keep ringing." The persistent alert behavior must come from **Tauri windows we spawn ourselves**, not the OS notification system. This is a feature, not a limitation — it gives us full control over visuals, sound, repeat logic, and fullscreen escalation.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Klaxon Process                          │
│                                                                   │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────┐  │
│  │ Main Window  │   │ Tray Icon    │   │ Alert Windows       │  │
│  │ (Svelte UI)  │   │ (always on)  │   │ (spawned on demand) │  │
│  └──────┬───────┘   └──────┬───────┘   └──────────┬──────────┘  │
│         │                  │                      │              │
│         └──────────────────┼──────────────────────┘              │
│                            │ Tauri commands (IPC)                │
│                            │                                     │
│  ┌─────────────────────────▼────────────────────────────────┐   │
│  │                   Rust Backend                             │   │
│  │                                                            │   │
│  │  ┌────────────┐  ┌────────────┐  ┌──────────────────┐    │   │
│  │  │ Scheduler  │  │ Alert      │  │ Audio engine      │    │   │
│  │  │ (tokio)    │─▶│ Dispatcher │─▶│ (rodio loop)      │    │   │
│  │  └─────┬──────┘  └─────┬──────┘  └──────────────────┘    │   │
│  │        │               │                                  │   │
│  │        ▼               ▼                                  │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │           SQLite (rusqlite)                       │    │   │
│  │  │  reminders · settings · sync_state                │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  └────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

**Process model:** single binary, single process. The scheduler runs as a `tokio` task. The main window can be closed to tray without exiting. Alert windows are short-lived — created when a reminder fires, destroyed when dismissed.

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
    sound_path      TEXT,                    -- NULL = use default for priority
    repeat_rule     TEXT,                    -- JSON; NULL = one-shot
    state           TEXT NOT NULL,           -- pending|fired|snoozed|dismissed|completed
    snooze_until    INTEGER,                 -- unix epoch ms; NULL unless snoozed
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,

    -- Sync metadata (unused in v0.1, present so v0.2 doesn't need a migration)
    source          TEXT NOT NULL DEFAULT 'local',  -- local|google|msgraph|remote_peer
    external_id     TEXT,                            -- ID in source system, if any
    last_synced_at  INTEGER,
    dirty           INTEGER NOT NULL DEFAULT 0      -- 1 = needs to be pushed
);

CREATE INDEX idx_reminders_pending_due
    ON reminders(due_at) WHERE state = 'pending';
```

**`repeat_rule` JSON shape:**

```json
{ "kind": "daily" }
{ "kind": "weekly", "weekdays": [1, 3, 5] }
{ "kind": "interval", "every_seconds": 3600 }
{ "kind": "monthly", "day": 15 }
```

### `settings`

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Default keys: `repeat_count_low`, `repeat_count_normal`, `repeat_count_high`, `repeat_interval_secs_low`, `repeat_interval_secs_normal`, `repeat_interval_secs_high`, `default_sound_low`, `default_sound_normal`, `default_sound_high`, `autostart_enabled`, `theme`.

### `sync_state` (placeholder for v0.2)

```sql
CREATE TABLE sync_state (
    peer_id          TEXT PRIMARY KEY,
    last_pull_at     INTEGER NOT NULL,
    last_push_at     INTEGER NOT NULL
);
```

Empty in v0.1. Schema reserved so the v0.2 migration is additive only.

---

## 5. Project Structure

```
Klaxon/
├── Cargo.toml                    # workspace root
├── package.json                  # frontend deps
├── README.md
├── LICENSE
├── DESIGN.md                     # this file
│
├── src/                          # Svelte frontend
│   ├── app.html
│   ├── main.ts
│   ├── lib/
│   │   ├── api.ts                # typed Tauri command wrappers
│   │   ├── types.ts              # Reminder, Priority, RepeatRule, ...
│   │   ├── stores.ts             # Svelte stores (reminder list, settings)
│   │   └── components/
│   │       ├── ReminderList.svelte
│   │       ├── ReminderForm.svelte
│   │       ├── PriorityBadge.svelte
│   │       ├── RepeatRuleEditor.svelte
│   │       ├── SettingsPanel.svelte
│   │       └── AlertView.svelte  # renders inside alert windows
│   └── routes/
│       ├── main/+page.svelte     # main window
│       └── alert/+page.svelte    # alert window (popup or fullscreen)
│
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── src/
│       ├── main.rs               # Tauri setup, plugin registration, command list
│       ├── models.rs             # Reminder, Priority, RepeatRule, Settings (serde)
│       ├── error.rs              # AppError, From impls
│       │
│       ├── db/
│       │   ├── mod.rs            # connection pool, init
│       │   ├── migrations.rs     # versioned schema migrations
│       │   ├── reminders.rs      # CRUD
│       │   └── settings.rs       # get/set
│       │
│       ├── scheduler.rs          # tokio task; wakes for next reminder; channel-pokeable
│       │
│       ├── alerts/
│       │   ├── mod.rs            # Alert trait, dispatch by priority
│       │   ├── toast.rs          # low: native toast, fire-and-forget
│       │   ├── popup.rs          # normal: spawn corner window, repeat audio
│       │   └── fullscreen.rs     # high: spawn fullscreen window, escalating audio
│       │
│       ├── audio.rs              # rodio wrapper, looped playback, stop handle
│       ├── tray.rs               # system tray menu + click handlers
│       ├── recurrence.rs         # compute next due_at from RepeatRule
│       └── commands.rs           # Tauri commands exposed to frontend
│
└── assets/
    └── sounds/
        ├── low.ogg
        ├── normal.ogg
        └── high.ogg
```

---

## 6. Core Flows

### 6.1 Scheduler

A single `tokio` task running this loop:

```
loop:
    next = SELECT * FROM reminders
           WHERE state = 'pending' OR (state = 'snoozed' AND snooze_until IS NOT NULL)
           ORDER BY COALESCE(snooze_until, due_at) ASC
           LIMIT 1

    if next is None:
        wait on poke channel (no upper bound)
        continue

    sleep until min(next.due_at, poke channel)

    if poked:
        continue   // re-query; something changed

    fire(next)    // dispatch to alerts module
```

A `tokio::sync::mpsc` channel from the command handlers to the scheduler "pokes" it whenever a reminder is added, edited, snoozed, or dismissed — so it always re-queries and recomputes the next wake time.

### 6.2 Alert Dispatch

```rust
fn fire(r: &Reminder) {
    match r.priority {
        Priority::Low    => toast::show(r),
        Priority::Normal => popup::spawn(r),
        Priority::High   => fullscreen::spawn(r),
    }
    if let Some(rule) = &r.repeat_rule {
        let next = recurrence::next_after(rule, r.due_at, now());
        db::reminders::reschedule(r.id, next);
    } else {
        db::reminders::mark_fired(r.id);
    }
}
```

### 6.3 Persistent Alert Behavior

**Normal priority popup:**

- Spawn a small Tauri window: 400×200px, top-right corner, `always_on_top`, `decorations: false`, `skip_taskbar: true`, `focus: false`
- Start audio: play sound on a `rodio` Sink
- Internal timer: every `repeat_interval_secs_normal`, replay the sound
- Stop after `repeat_count_normal` cycles OR when user dismisses
- Window content: title, description, **Dismiss** + **Snooze** buttons

**High priority fullscreen:**

- Spawn a fullscreen, `always_on_top`, `focus: true` window
- Steal focus aggressively (Windows: `SetForegroundWindow` workarounds may be needed)
- Audio: louder default volume, escalating pattern
- Same dismiss/snooze controls but visually larger
- After repeat limit reached: leave the window open (don't auto-close on a missed alarm — that's the whole point)

**Snooze:**

- Set `state = 'snoozed'`, `snooze_until = now + snooze_duration`
- Close alert window, stop audio
- Poke scheduler

### 6.4 Recurrence

`recurrence::next_after(rule, last_due_at, now)` returns the next `due_at` that is `> now`. Single function, fully unit-testable, no I/O. Live in `recurrence.rs` with exhaustive tests.

---

## 7. v0.1 MVP Scope

**Ship a useful single-device reminder app. No sync, no integrations.**

### Must-have

- [ ] Reminder CRUD (create, edit, delete, mark complete)
- [ ] Three priority tiers with distinct alert behaviors (toast / popup / fullscreen)
- [ ] One-shot reminders
- [ ] Recurring reminders: daily, weekly (with weekday picker), custom interval
- [ ] Snooze (5 / 15 / 60 min presets + custom)
- [ ] Dismiss
- [ ] Persistent alerts: configurable repeat count + interval per priority tier
- [ ] System tray: open main window, quick-add, quit
- [ ] Autostart on login (toggle in settings)
- [ ] Settings panel: repeat count, repeat interval, sound picker per priority, theme
- [ ] SQLite persistence with UUID primary keys (sync-ready)
- [ ] Migration system (so future schema changes are safe)

### Out of scope for v0.1

- Sync of any kind
- Calendar integrations (Google, Microsoft Graph, CalDAV)
- Mobile app
- Natural-language input ("remind me tomorrow at 3pm") - add at later date 
- Tags, categories, search
- Multiple users / accounts
- Backup/restore (the SQLite file *is* the backup)

### Non-functional targets

- Cold start to tray: under 1 second
- Memory footprint at idle: under 80 MB
- Reminder accuracy: fired within 1 second of `due_at`
- All Rust code has unit tests; `recurrence.rs` and `scheduler.rs` have exhaustive tests
- Cross-platform code paths kept clean (Windows is primary; Linux/macOS should compile)

---

## 8. Roadmap Beyond MVP

### v0.2 — LAN Sync

- mDNS device discovery (announce as `_klaxon._tcp.local`)
- Pairing flow: device A shows 6-digit code, device B enters it; exchange long-lived tokens
- Sync protocol: HTTP over LAN, JSON delta payloads
  - `POST /sync/push { since, changes[] }`
  - `GET  /sync/pull?since=<lamport_clock>`
- Conflict resolution: last-write-wins per record, using Lamport clocks
- Use `dirty` flag and `last_synced_at` from existing schema

### v0.3 — Remote Sync via iroh

- Same sync protocol, swap transport from HTTP-over-LAN to iroh streams
- Pairing: QR code containing iroh `NodeId`
- Falls back to public relay servers when direct P2P fails
- Self-hosted relay supported for users who want full sovereignty

### v0.4 — Calendar Integrations

- Microsoft Graph (Outlook + Teams)
- Google Calendar
- CalDAV
- Each integration is a `source` value; reminders carry `external_id` for two-way mapping
- Start with one-way (calendar → reminder) before attempting bidirectional sync

### v1.0 — Mobile

- Tauri 2 mobile (iOS + Android)
- Reuse Rust scheduler core and most Svelte components
- Mobile-specific tweaks: native push for high-priority alerts (since mobile OSes restrict background audio loops)

---

## 9. Open Questions

These are deferred but worth flagging now:

- **Focus stealing on Windows:** how aggressive can we be with high-priority fullscreen alerts? Windows actively resists focus theft. May need `AllowSetForegroundWindow` or AttachThreadInput tricks.
- **Audio when system is muted:** do high-priority alerts override system mute? Probably no (OS limitation), but a visual flash/strobe could compensate.
- **Multi-monitor:** which monitor does the fullscreen alert appear on? Default to the monitor with the cursor, but make it configurable.
- **Sleeping laptops:** if the laptop is asleep when a reminder is due, do we wake it? Windows `WaitableTimer` with `WT_EXECUTEINTIMERTHREAD` can wake from sleep, but requires elevated permissions and may surprise users. Default off.
- **Time zones / DST:** store everything as UTC unix epoch, render in local time. Recurring "every Tuesday 9 AM" is computed against the user's current local time zone, not the original creation time zone — the right behavior for travelers, but worth documenting.
- **Sound licensing:** ship default sounds under a permissive license (CC0 or similar). Source from freesound.org.

---

## 10. License & Distribution

- Open source: **MIT** or **Apache-2.0** (already have a LICENSE file — confirm which)
- Distribution: GitHub Releases with prebuilt binaries for Windows (later: macOS, Linux, mobile stores)
- No telemetry, no analytics, no phone-home

---

## Next Steps

1. Initialize the Tauri 2 + Svelte project skeleton
2. Set up the workspace `Cargo.toml`, `tauri.conf.json`, `package.json`
3. First milestone: SQLite + migrations + reminder CRUD + main window
4. Second milestone: scheduler + low-priority toast end-to-end
5. Third milestone: popup + fullscreen alerts with audio
6. Fourth milestone: tray + autostart + settings → v0.1 release

A detailed task-by-task implementation plan (TDD format) can be produced once the repo skeleton is in place.
