# Klaxon

> A self-hosted, open-source reminder app that actually gets your attention.

Klaxon fires persistent, hard-to-ignore notifications when you set a reminder. Three priority tiers — quiet toast, popup window with repeating tone, fullscreen alarm — let you decide how loud each thing should be. No cloud, no account, no subscription. Your data lives in a SQLite file on your machine, and v0.2 lets paired devices sync over the LAN with TLS-encrypted traffic.

**Status:** v0.2 in `0.2.0-dev` on `main`. v0.1.0 is tagged with a binary release. v0.2.0 will be tagged once cross-device sync has been validated on real hardware.

---

## Features

### Reminders and tasks

- **Three priority tiers**, each with distinct alert behavior
  - **Low** — native OS toast, fire-and-forget
  - **Normal** — always-on-top corner popup with a repeating klaxon-style tone
  - **High** — fullscreen alarm with an urgent escalating tone
- **Persistent alerts** — configurable repeat count + interval per tier
- **Snooze** with 5 / 15 / 60 min presets *or* any custom duration
- **Recurring reminders** — daily, weekdays, custom interval, monthly
- **Task reminders** — same as a reminder but silent. Appears in the list, doesn't ring. Use it for to-do items where the alarm would be wrong.
- **Per-priority tone picker** — Klaxon / Chime / Siren / Pulse, with a Preview button in System Config

### Navigation

- **Sidebar modes** — Reminders, Tasks, Calendar, Completed (collapses what was previously a busy single list)
- **Top-bar time filters** — All / Today / Upcoming / Recurring, shown for the Reminders and Tasks modes
- **Calendar view** — month grid with prev/next/today nav, click a reminder pill to edit, **right-click a day** to add a Reminder or Task for that date
- **Text search** via `Ctrl+F`, filters title + description in real time
- **Configurable sort order** (oldest → newest or newest → oldest)

### Sync (v0.2)

- **mDNS auto-discovery** — paired devices on the same WiFi find each other
- **Tap-to-pair** — both devices show the same 6-digit confirmation code; tap Approve on each, no copy-paste of secrets
- **TLS-encrypted sync** — each device generates a self-signed cert at first run; pinned per peer during pairing so eavesdroppers on the LAN can't read traffic
- **Per-pair shared secret** as bearer auth on top of TLS
- **Last-write-wins** delta sync over an embedded HTTP server (axum), every 20 s by default
- **Tombstones** for deletes so removals propagate
- **Dismiss / snooze propagation** — silencing an alarm on one device silences it on every paired device

### Window and tray

- **System tray residency** — closes to tray, doesn't quit
- **Single-instance** — launching twice focuses the existing window
- **Autostart on login** — optional, toggle in System Config
- **Multi-monitor aware** — alert popup appears on the monitor that contains the main window, not always the primary
- **CPU-aware ticker** — 1 s while the soonest countdown is sub-day; 30 s otherwise; fully paused when the window is hidden to the tray

### Other

- **Customisable global hotkey** for "new reminder" from anywhere (default `Ctrl+Alt+N`)
- **Open source, MIT licensed** — no telemetry, no phone-home
- **Local-first SQLite** with sync metadata baked into the schema from v0.1

---

## Keyboard shortcuts

| Where     | Shortcut          | Action                              |
| --------- | ----------------- | ----------------------------------- |
| Anywhere  | `Ctrl+Alt+N` *    | New reminder (global, configurable) |
| Main app  | `Ctrl+N`          | New reminder                        |
| Main app  | `Ctrl+F`          | Open / focus search                 |
| Main app  | `Esc` (in search) | Close search                        |
| List      | `Tab`             | Focus next reminder                 |
| List      | `Enter` / `Space` | Open focused reminder               |
| List      | `Del` / `Backspace` | Delete focused reminder           |
| Calendar  | Right-click cell  | Context menu → Make Reminder / Task |
| Editor    | `Esc`             | Close                               |
| Editor    | `Ctrl+Enter`      | Save                                |
| Alert     | `Esc` / `Enter`   | Dismiss                             |
| Alert     | `Space`           | Snooze 5 minutes                    |

*Default global hotkey — change it in System Config → Hotkeys.

---

## Tech stack

- **[Tauri 2](https://tauri.app/)** — desktop shell (Rust + WebView)
- **[Svelte 5](https://svelte.dev/)** + TypeScript — frontend, runes API
- **[rusqlite](https://github.com/rusqlite/rusqlite)** — bundled SQLite
- **[rodio](https://github.com/RustAudio/rodio)** + sine wave synthesis — audio
- **[tokio](https://tokio.rs/)** — async runtime, scheduler, sync task
- **[axum](https://github.com/tokio-rs/axum)** + **[axum-server](https://github.com/programatik29/axum-server)** + **[rustls](https://github.com/rustls/rustls)** — embedded HTTPS sync server
- **[reqwest](https://github.com/seanmonstar/reqwest)** + custom cert pinning — sync client
- **[mdns-sd](https://github.com/keepsimple1/mdns-sd)** — LAN discovery
- **[rcgen](https://github.com/rustls/rcgen)** — self-signed cert generation

See [DESIGN.md](DESIGN.md) for architecture detail.

---

## Install

### Windows

The v0.1.0 installer is attached to the [v0.1.0 release](https://github.com/willherr72/Klaxon/releases/tag/v0.1.0). Newer code on `main` and tagged release candidates (`v0.3.0-rc.1`+) build via `npm run tauri build` — see below.

The installer is **unsigned**, so Windows SmartScreen will warn on first run. Click *More info → Run anyway*. Code-signing is on the long-term roadmap.

### Linux

No prebuilt binary yet — build from source (instructions below). Tested on Ubuntu/Debian for v0.3.

### macOS

Compiles but not yet tested.

---

## Build from source

### Prerequisites

- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 20+
- Tauri 2 platform prerequisites — see [Tauri docs](https://tauri.app/start/prerequisites/)

**Windows:** WebView2 runtime (already on Windows 11).

**Linux** (Debian/Ubuntu):
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  libgtk-3-dev \
  librsvg2-dev \
  libxdo-dev \
  build-essential \
  curl wget file
```

(For Fedora / Arch see the [Tauri prerequisites page](https://tauri.app/start/prerequisites/#linux).)

### Run in development

```bash
git clone https://github.com/willherr72/Klaxon
cd Klaxon
npm install
npm run tauri dev
```

### Build a release installer

```bash
npm run tauri build
```

Outputs land in `src-tauri/target/release/bundle/`:
- **Windows:** `nsis/Klaxon_<version>_x64-setup.exe`
- **Linux:** `deb/klaxon_<version>_amd64.deb` + `appimage/Klaxon_<version>_amd64.AppImage`

First run takes several minutes for the full release compile; subsequent builds are incremental.

### Tests

```bash
cd src-tauri
cargo test --lib
```

The recurrence module has 9 unit tests covering daily, weekly (with weekday picker), interval, and monthly recurrence including DST/leap-day edge cases.

---

## Configuration

Klaxon stores its database, settings, and TLS cert/key in your platform's app-data directory under `com.klaxon.app/`:

- **Windows** — `%APPDATA%\com.klaxon.app\`
- **macOS** — `~/Library/Application Support/com.klaxon.app/`
- **Linux** — `~/.config/com.klaxon.app/`

Contents:

- `klaxon.db` — reminders, peers, settings, tombstones
- `klaxon-cert.pem` + `klaxon-key.pem` — self-signed sync TLS cert (generated on first run when sync is enabled)

System Config (gear icon at the bottom of the sidebar) lets you tune:

- **Alert behavior** — repeat count + interval and tone per priority
- **Display** — sort order (oldest → newest or newest → oldest)
- **LAN Sync** — enable/disable, view device identity, see discovered devices, pair / manage peers
- **Hotkeys** — system-wide hotkey combination
- **Startup** — launch on system login
- **System** — database path and version

All sections collapse by default; click a header to expand just the one you're editing.

---

## Roadmap

| Milestone | Status | Highlights |
| --- | --- | --- |
| **v0.1** | ✅ Released | Single device. CRUD, three priority tiers, recurrence, snooze, system tray, autostart, configurable hotkey. |
| **v0.2** | 🟡 In `0.2.0-dev` | LAN sync (mDNS + tap-to-pair + TLS), Task reminders, calendar view, search, sort, collapsible Settings, dismiss/snooze propagation. Pending: validate sync on a second machine before tagging. |
| **v0.3** | ⏳ Planned | Remote sync via [iroh](https://www.iroh.computer/) — peer-to-peer with NAT traversal so devices on different networks can sync. |
| **v0.4** | ⏳ Planned | Microsoft Graph (Outlook/Teams), Google Calendar, CalDAV integrations. |
| **v0.5** | ⏳ Planned | **Opt-in shared groups.** Reminders can belong to a group; devices that explicitly joined sync those records. Per-group encryption key so paired peers outside the group can't read the contents even if they intercept traffic. Default behavior unchanged — reminders are private until you actively share them. Needs careful threat-model work; likely a separate design doc when it lands. |
| **v1.0** | ⏳ Planned | iOS + Android via Tauri 2 mobile, sharing the Rust scheduler core. |

---

## Contributing

Early-stage personal project — pull requests and issues are welcome but there's no formal process yet. Open an issue to discuss anything substantial before sending a PR. Bug reports and design feedback are especially appreciated.

---

## License

MIT — see [LICENSE](LICENSE).
