# P0 native packaging and offline fixture

The Windows executable and Android APK embed the portable Svelte client in Tauri 2.11.0 using the separate identifier `dev.klaxon.p0native`. The Rust host registers no application commands or production plugins. The default build stores synthetic rows in this app’s WebView profile. Both the portable HTML and the native response policy set `connect-src 'none'`. The asset URL works without a frontend server, backend, ADB reverse or account. The [portable client](../portable.md) describes the separate Convex account mode.

## Windows fixture

### Synthetic secure-session probe

From the repository root on Windows with Node 24 and Windows PowerShell 5.1, run `node --test spikes/p0/native/session.test.mjs`. The test starts a new PowerShell process for every operation. It uses current-user DPAPI with the application and fixture owner as context. Only the encrypted synthetic refresh markers cross the process boundary in a temporary directory. The runner checks worker output and stored files for plaintext markers and removes the directory afterward.

The simulated provider decides whether a marker can restore a session. A temporary transport failure or unreadable record denies access and preserves the ciphertext. Provider expiry requires a new sign-in. Local logout clears the selected slot across relaunch. Both fixture owners share one Windows profile. DPAPI does not prevent other code running as that Windows user from unprotecting data with the same context. Hosted revocation, Android Keystore and the Tauri-to-provider flow remain open. See the [candidate and assumptions](../../../docs/adr/p0-architecture.md#p0-03-native-session-candidate).

### Packaged offline client

Use Node from the repository’s `.node-version`, MSVC C++ build tools, the repository’s pinned Rust toolchain and the Microsoft WebView2 runtime. In PowerShell from `spikes/p0`:

```powershell
npm ci
$env:Path = "$env:USERPROFILE/.cargo/bin;$env:Path"
node native/package.mjs --target windows
node native/smoke.mjs windows
```

The executable is `native/src-tauri/target/debug/klaxon-p0-native.exe`. Use the default Cargo target directory when running this smoke. It starts only this executable, uses a new temporary WebView2 user-data folder, and attaches over loopback. It creates and renames a row through the UI, reads it after a reload, terminates the native process and verifies the same ID and title after relaunch. It removes the temporary profile on exit.

## Android emulator fixture

Use JDK 21, Android platform 36, Build Tools 36.0.0, NDK 27.1.12297006 and the pinned Tauri CLI. Windows must permit the symlinks Tauri creates for Android native libraries. Run from `spikes/p0` after `npm ci`. Set the JDK and SDK paths for this machine.

```powershell
$env:Path = "$env:USERPROFILE/.cargo/bin;$env:Path"
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME/ndk/27.1.12297006"
$env:ADB = "$env:ANDROID_HOME/platform-tools/adb.exe"
$env:Path = "$env:JAVA_HOME/bin;$env:Path"
rustup target add x86_64-linux-android
# If cargo tauri --version does not report 2.11.0:
# cargo install tauri-cli --version 2.11.0 --locked
node native/package.mjs --target x86_64
```

Create a fresh Android Studio virtual device using a Google Play API 36 x86_64 image. Boot it fully and enable airplane mode with Wi-Fi off. Replace `emulator-5588` below with its actual serial.

```powershell
& $env:ADB devices
node native/smoke.mjs android emulator-5588
```

The harness checks the serial, QEMU and boot properties, verifies airplane mode and the absence of a default network, checks that the spike package is absent, and installs `native/.run/klaxon-p0-x86_64-fixture.apk`. It drives the app’s WebView over an ADB debug socket, force-stops and relaunches the Android activity to check fixture persistence, then uninstalls the spike. Debug signing uses the spike's own Android user home at `native/.run/android-user`.

## Arm64 handoff

The same packager produces a debug APK for an arm64 device. The repository’s release signing and updater workflows are separate. To generate the offline fixture:

```powershell
rustup target add aarch64-linux-android
node native/package.mjs --target aarch64
```

The output is `native/.run/klaxon-p0-arm64-fixture.apk`. For a later authorized physical desktop-off test, run the following command with the public HTTPS origin copied from the intended disposable **Development** deployment. The deployment administrator must confirm its environment; the URL alone identifies a hostname. Keep the device’s own internet connection active for this account-mode test.

```powershell
$developmentOrigin = Read-Host 'Confirmed public Development deployment HTTPS origin'
node native/package.mjs --target aarch64 --origin $developmentOrigin
```

This writes `native/.run/klaxon-p0-arm64-development.apk`. The public origin selects the compiled client endpoint and limits both CSPs to that exact HTTPS origin and its WSS counterpart. Sign in at runtime with a previously enrolled synthetic identity. Install only when the device owner chooses to perform the physical-device check. The [physical desktop-off procedure](../portable.md#physical-desktop-off-acceptance) includes the owner-reported sync result and the optional extended checks.

## Rebuilds

Run `native/package.mjs` for each target. It rebuilds `native/.frontend/index.html` with the same builder as `dist/index.html`, then embeds it. A per-worktree exclusive `native/.run/package.lock` guards asset generation, native configuration, Rust compilation and APK copying. A second packager fails immediately. If a build is killed, inspect the PID in the lock and verify its build and Cargo/Gradle children have stopped before deleting only that lock file. Gradle scaffolding, caches, debug signing material, profiles and binaries stay outside version control.

## Local verification, November 23, 2026

Windows ran the debug x64 executable with WebView2 157.0.4341.60. The disposable Android 16/API 36 Google Play x86_64 AVD used emulator 36.3.10.0 and System WebView 133.0.6943.137. Both loaded the embedded client at `http://tauri.localhost/`, matched its script and style hashes, rendered its stylesheet, created and renamed a synthetic task, and retained the title and stable ID across page reload and process restart. Android reported airplane mode enabled and no active default network. The arm64 APK received static package/signature verification. These package checks cover offline fixture storage. The [owner-reported desktop-off smoke](../../../docs/klaxon-v2-progress.md#remaining-p0-tests) used a fresh sign-in. Packaged arm64 execution and secure native session restoration still need evidence.

The commands above used Node 24.12.0, Rust 1.97.1, Tauri CLI 2.11.0, JDK 21.0.8 and Gradle 8.14.3. Starting Cargo before generating the portable assets failed at compile time. The packager now builds the HTML first. The first Android WebView attachment stalled, and attaching before the page existed timed out. The smoke now waits for the Tauri page in the selected app process’s DevTools target list and connects without desktop browser defaults. A second simultaneous package command failed before changing the frontend. Fresh APK output eliminates unused ZIP space retained by Gradle during incremental packaging.

| Local fixture artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `.frontend/index.html` (matches `../dist/index.html`) | 165623 | `19ce40ffabe6a07e504c44144a55e24e975a8b8f74162daa4944e86a3278796f` |
| `src-tauri/target/debug/klaxon-p0-native.exe` | 12219904 | `debd90f919e252fea6bfba5153969b4f0529762ce1b3c62c08e4b89749e11cf9` |
| `.run/klaxon-p0-x86_64-fixture.apk` | 28982439 | `c875ada4874723e3b0111d31b844e0fd177900e1b6ec93a2b0dc9b41876951f2` |
| `.run/klaxon-p0-arm64-fixture.apk` | 29367666 | `e01763928c28f9b77fa70aae39c1f72c48383798aea9bc2eb60323301ad507ee` |

Android Build Tools `aapt dump badging` identified each expected single ABI, the spike package, version 0.1.0 and the debuggable flag. `apksigner verify --print-certs` validated both APKs with the local Android Debug certificate. Each archived native library’s SHA-256 matched its compiled Rust library. The smoke removed the package and its debug forwards. The emulator was shut down and the Windows WebView2 profiles were removed. The stopped AVD’s temporary directory was retained.
