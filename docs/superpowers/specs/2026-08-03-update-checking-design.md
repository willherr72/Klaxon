# Update Checking (v0.7) — Design

**Date:** 2026-08-03
**Status:** Approved (design conversation 2026-08-03)
**Release scope:** v0.7.0 ships this feature together with the iroh
`1.0.0-rc.0 → 1.0.3` bump (commit `0e19c14`, zero API drift, 103/103
tests). The iroh bump gets a hardware sync verification (desktop ↔
phone, cold pass, relay path) *before* update-checking implementation
begins, so any relay-fleet regression is isolated from new code.

## Goal

Klaxon notices when a newer GitHub release exists and — on request —
downloads the right artifact and hands it to the OS installer. Ends the
adb-from-the-desk workflow for the phone. No silent installs, no popups.

## Decisions (from design conversation)

- **Automation level:** download + hand off. Klaxon fetches the asset
  itself and launches the OS install flow (NSIS on Windows, package
  installer prompt on Android). It never installs silently.
- **Cadence:** auto-check on launch (delayed a few seconds,
  non-blocking) and every 24 h while running, plus a manual
  "Check now" button.
- **Surfacing:** quiet. A badge on the Settings gear, an update row in
  Settings → System, and a subtle one-line hint in the status bar.
  Auto-check failures are logged, never shown. Manual-check failures
  show inline in the Settings row.
- **Architecture:** Rust-owned (Approach A). All logic in the backend;
  the webview renders state and calls two commands. No
  tauri-plugin-http / plugin-shell.

## Architecture

### New backend module: `src-tauri/src/updates.rs`

Pure core (host-testable, no network):

- `compare_versions(current: &str, latest_tag: &str) -> bool` —
  strips a leading `v`, parses `MAJOR.MINOR.PATCH` triples, returns
  true only if latest is strictly greater. Unparsable input → false
  (never notify on garbage).
- `parse_release(json: &str) -> Option<ReleaseInfo>` — extracts
  `tag_name`, `name`, `body`, `assets[] {name, browser_download_url,
  size}` from the GitHub API response.
- `pick_asset(assets, platform) -> Option<&Asset>` — Windows: exact
  `Klaxon_{ver}_x64-setup.exe`, else suffix `x64-setup.exe`. Android:
  exact `klaxon-{ver}-arm64.apk`, else suffix `-arm64.apk`.

Network + IO (thin, not unit-tested):

- HTTP via `ureq` (rustls, minimal features), 10 s timeout,
  `User-Agent: Klaxon/<version>`,
  `GET https://api.github.com/repos/willherr72/Klaxon/releases/latest`.
  Unauthenticated — repo is public; one check/24 h is far under the
  60/hr anonymous rate limit.
- Download streams to `<app_cache_dir>/updates/<asset-name>`, emitting
  `update-download-progress` events (percent) to the webview. Any
  partial file from a failed attempt is deleted; retry re-downloads
  from scratch (assets are 7–42 MB — no resume).

### Tauri commands

- `check_for_update() -> UpdateCheck` — performs the network check,
  returns `{ current, latest, release_name, notes_snippet,
  update_available, asset_found }`. `notes_snippet` = release body
  truncated to ~400 chars. The frontend decides error surfacing:
  auto-check swallows, manual check displays.
- `download_and_install_update() -> ()` — re-resolves the release
  (no stale cached URL), downloads the platform asset, then hands off:
  - **Desktop:** `std::process::Command::new(installer_path).spawn()`.
    The app keeps running; NSIS prompts to close it during install.
  - **Android:** classloader-JNI (same pattern as
    `NotificationReconciler`) into a new Kotlin helper.

### New Kotlin helper: `UpdateInstaller.kt` (app module)

`@JvmStatic fun install(context: Context, apkPath: String): Boolean` —
wraps the APK path in a `FileProvider` content URI and fires
`ACTION_VIEW` with MIME `application/vnd.android.package-archive`,
`FLAG_ACTIVITY_NEW_TASK | FLAG_GRANT_READ_URI_PERMISSION`. Android
shows its install prompt; the release signing key matches, so data
survives. Manifest additions: `REQUEST_INSTALL_PACKAGES` permission +
`<provider>` (FileProvider) exposing the cache `updates/` path. First
use, Android asks once to allow installs from Klaxon — expected;
mentioned in the UI copy.

### Frontend

- `api.ts`: `checkForUpdate()`, `downloadAndInstallUpdate()` wrappers +
  types.
- App startup: delayed auto-check a few seconds after mount; 24 h
  `setInterval` re-check while running. Result held in shared state.
- Settings → System row when an update exists: version, release name,
  notes snippet, **Update** button (with download progress), and the
  standing hint: *"Update your other devices too — Klaxon versions must
  match to sync."* Also a "Check now" button that surfaces errors
  inline ("couldn't reach GitHub", "download failed — retry").
- Settings gear badge + one-line status bar hint while an update is
  known and uninstalled.

## Error handling

Every failure is non-fatal. Auto-check: log only. Manual check/download:
inline message + retry in the Settings row. No error state persists
across restarts (checks are cheap and re-run on launch). If the release
exists but has no matching asset (`asset_found: false`), the row shows
"open the release page" as a link fallback instead of the Update button.

## Testing

- Unit (host): `compare_versions` (greater/equal/older/garbage/`v`
  prefix), `pick_asset` (exact, suffix fallback, none), `parse_release`
  (real captured API JSON + malformed).
- Hardware, desktop: check against the live repo, download, NSIS
  launches.
- Hardware, Android: check, download, install prompt appears, app
  updates in place with data intact (the real v0.7.0→v0.7.x drill can
  only happen at the *next* release; the v0.7.0 drill fakes it by
  installing over a locally-built lower-version APK).
- iroh 1.0.3 (release-scope): before implementation — desktop dev build
  ↔ phone APK sync round-trip, share-triggered cold pass, and a
  Wi-Fi-off relay-path sync to confirm the production relay fleet.

## Out of scope (deliberate)

- Silent/self-applying updates (tauri-plugin-updater, signing manifests)
- Version skipping / "ignore this release"
- Update notifications from the cold background worker
- Download resume, delta updates, non-arm64 Android ABIs
