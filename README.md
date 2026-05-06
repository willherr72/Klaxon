# Klaxon

> A self-hosted, open-source reminder app that actually gets your attention.

Klaxon fires persistent, hard-to-ignore notifications when you set a reminder. Three priority tiers — quiet toast, popup window with repeating tone, fullscreen alarm — let you decide how loud each thing should be. No cloud, no account, no subscription. Your data lives in a SQLite file on your machine.

**Status:** v0.1 — single-device, Windows-tested. LAN sync between paired devices is the next milestone.

---

## Features

- **Three priority tiers**, each with distinct alert behavior
  - **Low** — native OS toast, fire-and-forget
  - **Normal** — always-on-top corner popup with a repeating two-tone klaxon
  - **High** — fullscreen alarm, escalating tone, demands dismissal
- **Persistent alerts** — configurable repeat count + interval per tier
- **Snooze** with 5 / 15 / 60 min presets *or* any custom duration
- **Recurring reminders** — daily, weekdays, custom interval, monthly
- **Customisable global hotkey** to summon "new reminder" from anywhere
- **System tray residency** — runs in background, autostarts on login (optional)
- **Single-instance** — launching twice focuses the existing window
- **Local-first SQLite** with sync metadata baked in for v0.2
- **MIT licensed** — no telemetry, no phone-home

---

## Tech stack

- **[Tauri 2](https://tauri.app/)** — desktop shell (Rust + WebView)
- **[Svelte 5](https://svelte.dev/)** + TypeScript — frontend
- **[rusqlite](https://github.com/rusqlite/rusqlite)** — bundled SQLite
- **[rodio](https://github.com/RustAudio/rodio)** — audio engine
- **[tokio](https://tokio.rs/)** — async runtime / scheduler

See [DESIGN.md](DESIGN.md) for the full architecture document.

---

## Install (Windows)

Pre-built installers are produced by `npm run tauri build` (see below). They land in `src-tauri/target/release/bundle/`:

- `nsis/Klaxon_0.1.0_x64-setup.exe` — NSIS installer (recommended)
- `msi/Klaxon_0.1.0_x64_en-US.msi` — MSI installer

The installer is **unsigned**, so Windows SmartScreen will warn the first time you run it. Click "More info" → "Run anyway." Code-signing is on the long-term roadmap.

macOS and Linux compile but are not yet packaged or tested.

---

## Build from source

### Prerequisites

- [Rust](https://rustup.rs/) 1.77+
- [Node.js](https://nodejs.org/) 20+
- Tauri 2 platform prerequisites — see [Tauri docs](https://tauri.app/start/prerequisites/)
  - Windows needs the WebView2 runtime (already on Windows 11)

### Run in development

```bash
git clone <this-repo>
cd Klaxon
npm install
npm run tauri dev
```

### Build a release installer

```bash
npm run tauri build
```

The first run takes several minutes; subsequent builds are incremental.

### Run the Rust unit tests

```bash
cd src-tauri
cargo test
```

---

## Configuration

Klaxon stores its database and settings in your platform's app-data directory under `com.klaxon.app/`:

- **Windows** — `%APPDATA%\com.klaxon.app\klaxon.db`
- **macOS** — `~/Library/Application Support/com.klaxon.app/klaxon.db`
- **Linux** — `~/.config/com.klaxon.app/klaxon.db`

Open **System Config** (gear icon at the bottom of the sidebar) to tune:

- Repeat count + interval per priority tier
- Launch on system startup
- Global hotkey for "new reminder"
- Reveal the data folder in your file manager

---

## Keyboard shortcuts

| Where     | Shortcut       | Action                            |
| --------- | -------------- | --------------------------------- |
| Anywhere  | `Ctrl+Alt+N`*  | New reminder (global, configurable) |
| Main app  | `Ctrl+N`       | New reminder                      |
| Editor    | `Esc`          | Close editor                      |
| Editor    | `Ctrl+Enter`   | Save reminder                     |
| Alert     | `Esc` / `Enter`| Dismiss                           |
| Alert     | `Space`        | Snooze 5 minutes                  |

*Default global hotkey — change it in System Config.

---

## Roadmap

- **v0.1** ✅ — single device, all priorities, settings, custom hotkey, autostart, tray
- **v0.2** — LAN sync between paired devices (mDNS discovery, pairing, last-write-wins delta sync)
- **v0.3** — Remote sync via [iroh](https://www.iroh.computer/) — peer-to-peer with NAT traversal, no central server
- **v0.4** — Microsoft Graph (Outlook/Teams), Google Calendar, CalDAV integrations
- **v0.5** — Shared groups (opt-in). Reminders can belong to a group; devices that have explicitly joined the group sync those records. Each group gets its own encryption key so paired peers outside the group can't read its contents. *Default behavior unchanged — reminders are private until you actively share them.*
- **v1.0** — iOS + Android via Tauri 2 mobile, sharing the Rust scheduler core

---

## Contributing

Early-stage personal project — pull requests and issues are welcome but there's no formal process yet. Open an issue to discuss anything substantial before sending a PR. Bug reports and design feedback are especially appreciated.

---

## License

MIT — see [LICENSE](LICENSE).
