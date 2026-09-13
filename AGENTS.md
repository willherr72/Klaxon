# Release requirements

- Ship user-facing app updates as new versioned GitHub releases. Do not
  deliver same-version patched binaries as the completed update: both the
  desktop and Android updater require a strictly newer release.
- Keep `package.json`, the root package entries in `package-lock.json`,
  `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and
  `src-tauri/tauri.conf.json` versions aligned. Add a dated changelog entry.
- Verify the change, build the Windows NSIS installer and locally signed
  Android arm64 APK, and attach both before publishing the release.
- Asset names must match the updater: `Klaxon_<version>_x64-setup.exe` and
  `klaxon-<version>-arm64.apk`. CI's unsigned Android APK is not shippable.
- Preserve app data and pairings during upgrades. Never commit signing
  credentials, keystores, or user databases.
