# Klaxon

> A self-hosted reminder app that actually gets your attention — and never touches anyone's cloud.

Klaxon is reminders, tasks, and a private thought inbox in one app, synced device-to-device with no server, no account, and no subscription. Reminders ring even when the app is closed. Your data is a SQLite file on your own machines, encrypted iroh traffic between them, and nothing anywhere else.

**Platforms:** Windows desktop + Android. Grab both from the [latest release](https://github.com/willherr72/Klaxon/releases/latest).

---

## Features

- **Reminders that escalate.** Three priority tiers — quiet toast, always-on-top popup with a repeating tone, fullscreen alarm. Configurable repeat count, interval, and tone per tier. Snooze presets or custom. Recurring: daily, weekdays, interval, monthly.
- **Rings cold.** A reminder created on your desktop rings on your phone even if Klaxon isn't running there — background sync arms real OS alarms. Late arrivals ring once within a 30-minute grace window; a reminder you dismiss anywhere goes quiet everywhere.
- **Tasks board.** Silent reminders organized in drag-and-drop swim lanes.
- **Thoughts inbox.** A permanent, searchable feed for ideas: global capture hotkey on desktop, share-to-Klaxon on Android, `#tags` inline, promote any thought into a task or reminder.
- **True peer-to-peer sync.** Devices pair with a 6-digit confirmation code and sync directly over [iroh](https://iroh.computer) — LAN when possible, encrypted relays when not. No store-and-forward server exists; only your devices ever hold your data.
- **Backups.** Automatic daily local snapshots, plus passphrase-encrypted full export/restore (Argon2id + AES-256-GCM) that resurrects a device completely — pairings included.
- **Self-updating.** Klaxon checks GitHub releases daily and installs updates on request, on both platforms.

## Screenshots

![Desktop](docs/screenshots/desktop-main.png)
![Tasks board](docs/screenshots/tasks-board.png)
<!-- Android capture coming: docs/screenshots/phone-main.png -->

---

## Install

### Windows

1. Download `Klaxon_<version>_x64-setup.exe` from the [latest release](https://github.com/willherr72/Klaxon/releases/latest).
2. Run it. **Windows will show "Windows protected your PC"** — that's SmartScreen reacting to a self-signed installer, which is normal for a self-hosted app that doesn't buy a yearly code-signing certificate. Click **More info → Run anyway**.
3. That's the last installer you run by hand: from then on Klaxon updates itself (Settings → System shows new releases).

### Android

1. Download `klaxon-<version>-arm64.apk` from the [latest release](https://github.com/willherr72/Klaxon/releases/latest) on the phone and open it.
2. Android asks you to allow installs from your browser/file manager — one-time.
3. On the first in-app update, Android asks once more to allow installs **from Klaxon** — that's what lets it update itself from then on.

### Staying updated

Klaxon checks for new releases quietly (on launch and daily) and shows a hint in the status bar plus an update panel in Settings → System. One tap downloads the right artifact and hands it to the OS installer — nothing installs silently. **Keep both devices current:** the sync wire format can change between releases, and Klaxon warns you when a paired device looks outdated.

## Pairing two devices

1. Open **Settings → Sync** on both devices (same Wi-Fi makes discovery automatic; a remote device can be added by its `iroh://` node id).
2. Pick the discovered device and start pairing.
3. Both screens show the same 6-digit code — confirm on each.
4. Done. Reminders, tasks, and thoughts flow both ways from then on, including while one side is asleep — the next wake catches up, over LAN or relay, wherever you are.

## Backups

- **Snapshots:** once a day Klaxon copies its database into `backups/` (newest 7 kept) — plain SQLite files, restorable with a file manager.
- **Export:** Settings → System → Export backup writes a single passphrase-encrypted `.klaxonbak` containing the database *and* the device's sync identity. Restoring it makes a machine *be* the old device, pairings intact. There is no passphrase recovery — keep it safe. Never restore one identity onto two live devices.

## Privacy model

What leaves a device, exhaustively:

- **Sync traffic to your own paired peers**, end-to-end encrypted by iroh. When no direct path exists, it flows through n0's public relays, which see only encrypted bytes.
- **A release check to `api.github.com`** (unauthenticated, roughly daily) and the release download when you ask for an update.

There is no telemetry, no account, no analytics, and no server of ours anywhere.

---

## Build from source

### Prerequisites

- [Rust](https://rustup.rs/) — the tested toolchain is pinned in `rust-toolchain.toml`
- [Node.js](https://nodejs.org/) — the tested version is pinned in `.node-version`
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

**Android** (only needed for mobile builds):

- Android SDK 36, build tools 36.0.0, and NDK **27.1.12297006**, with `ANDROID_HOME` and `NDK_HOME` set
- **JDK 21**, matching GitHub Actions. The Android Gradle Plugin pinned in
  `src-tauri/gen/android/buildSrc` fails to configure under JDK 25 with a bare
  `A problem occurred configuring project ':buildSrc'. > 25.0.2`, which doesn't
  name Java as the cause. If Android Studio is installed, its bundled runtime is
  a suitable JDK 21 and needs no separate download.

```bash
# Point Gradle at a supported JDK for the build only, leaving your
# system-wide JAVA_HOME alone.
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npm run tauri android build -- --debug
```

Note the Rust side compiles before Gradle runs, so a `Finished dev profile`
line followed by a Gradle failure means the Rust cross-compile succeeded and
only packaging failed.

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
npm ci
npm run verify
```

The shared verifier checks version consistency, release-tooling tests, Svelte,
frontend tests/build, locked Rust tests, and real Iroh loopback transport. It
stops on the first failure. `node scripts/verify.mjs --frontend` runs only the
frontend/tooling portion. `npm run test:recovery` adds three-device forwarding,
in-flight edits, persistent restart, and backup-restore transport regressions;
build the frontend first when running that command on a fresh checkout.

### GitHub Actions

The workflows use standard hosted runners. For this public repository, scheduled
nightly runs have the same free compute treatment as push and pull-request runs.
Temporary artifacts expire after **three days**; emulator images and complete
build directories are never uploaded. See [GitHub's billing rules](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

| Workflow | Trigger | Checks |
| --- | --- | --- |
| CI | PR, main push, manual | Shared Windows verification and a real Android emulator sync/lifecycle test |
| Build | Main push, manual | Windows NSIS and unsigned Android arm64 APK, with source-bound metadata and SHA-256 reports |
| Nightly recovery | Daily at 08:23 UTC, manual, relevant test-infrastructure PRs | Real transport recovery plus emulator network outage and v0.10.2-to-current upgrade/data preservation |
| Release | Version tag, manual dry run | Passing verification/extended emulator tests, exact-commit build reuse, production signing and verified release publication |

The smoke suite uses Android API 35; the extended suite uses API 36. The emulator
runs the actual Android app against a production Iroh handler with
disposable databases and identities. It checks actual data in both directions,
eventual background/resume recovery, process restart, and retained pairing. The
extended suite verifies an observed outage and installs a newer APK over an older
one. These checks do not model Samsung-specific battery policies or real cellular
handoffs. Test setup seeds a pairing; the confirmation-code UI is not covered.
See the [emulator harness instructions](src-tauri/gen/android/app/src/androidTest/README.md).

### Release automation

Push a version bump with matching package/Cargo/Tauri versions and a dated
changelog to `main`. Once its Build workflow succeeds, tag that commit `vX.Y.Z`.
The Release workflow reuses that commit's artifacts instead of rebuilding both
installers on the tag. If the three-day artifacts have expired, run Build on
that main commit again before retrying Release. Existing releases and versions
that are not strictly newer are rejected.

Cloud signing requires a `release` GitHub environment with deployment policies
allowing only the `main` branch (dry runs) and `v*` tags. Configure these environment
secrets from the existing release identity: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
Never put these in the repository or expose them to test/PR jobs. The production
certificate fingerprint is checked before publishing, and both uploaded asset
digests must match the validated manifest before the draft becomes public.

To verify the full signing pipeline without publishing, manually run Release on
`main` with `publish` left false. A failed upload validation leaves a draft for
inspection; publication never silently overwrites or repairs an existing release.
The unsigned Build APK is only a build-check artifact and cannot update a normal
installation. The old manual build/sign/release process remains available.

## Configuration

Klaxon stores its database, settings, sync identity, and backups in your platform's app-data directory under `com.klaxon.app/`:

- **Windows** — `%APPDATA%\com.klaxon.app\`
- **macOS** — `~/Library/Application Support/com.klaxon.app/`
- **Linux** — `~/.config/com.klaxon.app/`

---

## Contributing

Early-stage personal project — pull requests and issues are welcome but there's no formal process yet. Open an issue to discuss anything substantial before sending a PR. Bug reports and design feedback are especially appreciated.

---

## License

MIT — see [LICENSE](LICENSE).
