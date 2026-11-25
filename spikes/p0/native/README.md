# P0 native packaging and offline fixture

The Windows executable and Android APK embed the portable Svelte client in Tauri 2.11.0 using the separate identifier `dev.klaxon.p0native`. The default Rust host registers no application commands. Both optional offline session builds expose a status-only session command and a separate SDK access command in the local WebView. The Windows session build also exposes an owner-filtered synthetic task read and push channel. The default build stores synthetic rows in this app’s WebView profile. Both the offline HTML and the native response policy set `connect-src 'none'`. The asset URL works without a frontend server, backend, ADB reverse or account. The [portable client](../portable.md) describes the separate Convex account mode.

## Windows fixture

### Synthetic secure-session probe

From the repository root on Windows with Node 24 and Windows PowerShell 5.1, run `node --test spikes/p0/native/session.test.mjs`. The test starts a new PowerShell process for every operation. It uses current-user DPAPI with the application and fixture owner as context. Only the encrypted synthetic refresh markers cross the process boundary in a temporary directory. The runner checks worker output and stored files for plaintext markers and removes the directory afterward.

The simulated provider decides whether a marker can restore a session. A temporary transport failure or unreadable record denies access and preserves the ciphertext. Provider expiry requires a new sign-in. Local logout clears the selected slot across relaunch. Both fixture owners share one Windows profile. DPAPI does not prevent other code running as that Windows user from unprotecting data with the same context. Hosted revocation and the Tauri-to-provider flow remain open. Android has a separate [emulator probe](#android-keystore-lifecycle). See the [candidate and assumptions](../../../docs/adr/p0-architecture.md#p0-03-native-session-candidate).

### Packaged offline client

For the Windows session probe, use the Windows prerequisites below and run both commands from `spikes/p0`.

```powershell
node native/package.mjs --target windows --session
node native/smoke.mjs windows-session
```

The build stages a separate offline HTML bundle and emits `native/src-tauri/target/debug/windows_session.exe`. Native code uses current-user DPAPI and a fixed application context. An intercepted provider recognizes two inert markers and selects the owner from the protected record. The harness creates a temporary run directory containing a single native slot and a separate WebView2 profile. Each restart reuses that directory and requires a new host PID, a new loopback DevTools endpoint and a fresh page.

After seeding the slot, the harness damages its ciphertext. Cold resume must return `unavailable` and preserve the damaged record both before and during a simulated provider outage. The harness controls the outage with a file in its temporary run directory. Restoring the original bytes lets DPAPI unprotect the marker, but the simulated provider still returns `retry-required`. The harness verifies the protected record remains byte-identical, clears the outage and resumes successfully in another fresh process without reseeding. Sign-out must delete the record and survive another restart. The harness checks raw bridge callbacks, DOM, WebView console/errors, host stdout/stderr, Web Storage writes, cookies, IndexedDB and Cache Storage. It removes its temporary directory and checks that it is gone. This exercises completed operations in one Windows user profile. Hosted refresh and revocation require separate evidence.

In the same smoke, the recovered owner reads one synthetic task and sees a native channel update without issuing another list read. The harness holds one actual read reply and one channel message in the WebView. It signs out, checks the original channel ended and releases the read. It then seeds and resumes the peer, reads the peer’s task and releases the previous owner’s update. The displayed rows must match the current session after each callback. Native list, subscribe and publish must all reject calls before confirmed resume and after sign-out. Provider data lives only in that process. The [P0 register](../../../docs/klaxon-v2-progress.md#packaged-windows-authenticated-task-read-and-subscription) records the limits and the next transport check.

Use Node from the repository’s `.node-version`, MSVC C++ build tools, the repository’s pinned Rust toolchain and the Microsoft WebView2 runtime. In PowerShell from `spikes/p0`:

```powershell
npm ci
$env:Path = "$env:USERPROFILE/.cargo/bin;$env:Path"
node native/package.mjs --target windows
node native/smoke.mjs windows
```

The executable is `native/src-tauri/target/debug/klaxon-p0-native.exe`. Use the default Cargo target directory when running this smoke. It starts only this executable, uses a new temporary WebView2 user-data folder, and attaches over loopback. It creates and renames a row through the UI, reads it after a reload, terminates the native process and verifies the same ID and title after relaunch. It removes the temporary profile on exit.

### Packaged Windows SDK handoff

From `spikes/p0`, build the isolated Windows session target and run the SDK smoke. The smoke selects the SDK panel in the packaged WebView, seeds its own DPAPI slot, and opens a fresh process for each cold resume. The simulated provider verifies each native access value by its digest. Both the HTTP and realtime transports stay in process.

```powershell
node native/package.mjs --target windows --session
node native/smoke.mjs windows-sdk
```

The sign-out case uses a simulated issuer and the current rotated DPAPI record. It drops two replies, checks access denial and byte-identical ciphertext after a cold launch, then lets the issuer acknowledge a retry. A third process must stay signed out. The test owns the issuer observation files and a separate unrelated file used to check cleanup. [Sign-out evidence](../../../docs/klaxon-v2-progress.md#windows-sign-out-after-a-lost-acknowledgment)

The test verifies owner-filtered reads and updates, failed forced refresh during an outage, recovery, peer switching and sign-out. It checks that native refresh markers stay behind the bridge and that access values stay out of inspected DOM, storage and logs. The runner removes the slot and WebView profile. [Results and limits](../../../docs/klaxon-v2-progress.md#packaged-windows-dpapi-to-sdk-handoff)

The Windows and Android SDK smokes also exercise successful access-token replacement. The harness sets a flag in the native fixture directory and tells the in-process provider to expire A’s first access value. The SDK must request a new value through native IPC, authenticate its subscription again and use the replacement for an HTTP read. The companion `node --test sdk-task-session.test.mjs` check presents the old value directly to each intercepted transport after cutover. The provider’s immediate rejection rule is specific to this test. The encrypted refresh record is reused throughout the exchange.

The Windows SDK smoke has a second case for replacement of the refresh record itself. It saves the original DPAPI ciphertext, enables the simulated native exchange and reads the replacement ciphertext as soon as the SDK has an authenticated subscription. Subsequent hosts must deny the original record and accept the replacement when the simulated provider requires the successor. Only the runner handles the encrypted files. The native fixture receives the synthetic provider response in memory.

Run the Windows Rust checks from `spikes/p0` to exercise interruption during the record update. The packaged WebView test above covers the successful handoff and cold resume.

```powershell
cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib
```

### Packaged Windows HTTP sign-out fixture

From `spikes/p0` with the offline dependencies already cached, build the fixture with native loopback sign-out.

```powershell
node native/package.mjs --target windows --session --sign-out-http
node native/smoke.mjs windows-sdk-signout-loopback native/src-tauri/target/sign-out-http/debug/windows_session.exe
```

The build selects Cargo features `custom-protocol,p0-windows-sign-out-http`. The smoke starts an IPv4 loopback HTTP server on an ephemeral port, supplies its decimal port to each native child through `KLAXON_P0_SIGN_OUT_PORT`, and owns the disposable DPAPI slot and WebView2 profile. The WebView uses the existing `fixture_session` command with `{ operation: "sign-out" }`.

The native command posts the inert marker to `/api/mutation` with the `auth:signOut` JSON envelope. It allows five seconds for the HTTP exchange and up to 16 KiB of response body. Redirects, proxies and automatic retries are disabled. For a seeded slot, missing or invalid port configuration leaves sign-out pending and returns `retry-required`. The 200 success envelope with an explicit `value: null` completes DPAPI cleanup. The browser CSP still sets `connect-src 'none'`.

The smoke seeds and rotates an inert grant before clicking Sign out. The server validates the request and pending journal, then drops the reply. A second host must preserve the ciphertext and deny resume before it can retry. After the server acknowledges that retry, a third host must remain signed out. The runner scans the retired profile for known canaries and cleans up the listener and fixture files.

### Packaged Windows cold refresh over HTTP

From `spikes/p0`, run `node native/smoke.mjs windows-sdk-refresh-loopback native/src-tauri/target/sign-out-http/debug/windows_session.exe` with the HTTP fixture built above. The runner supplies a disposable loopback port through `KLAXON_P0_REFRESH_PORT`. A fresh process must deny access and preserve the encrypted record after HTTP 503, even when the body contains `noSession`. The next process must publish a rotated record before reporting authentication. A final process must send the successor and clear its slot on HTTP 200 with `noSession`. The issuer responses use inert markers.

The first host receives a separate `KLAXON_P0_SIGN_IN_PORT`. Clicking Start synthetic session sends the pinned username/password mutation with two fixed public fixture strings. A denied response leaves the slot empty. A successful response seeds the protected record for the cold-refresh sequence. Another start against the occupied slot must leave that record intact and issue no third mutation. All issuer listeners bind to ephemeral IPv4 loopback ports.

## Android emulator fixture

### Packaged Android session

Use the Android SDK, JDK, NDK, pinned Tauri CLI and environment variables in the packaged offline client instructions below. With the disposable `KlaxonSessionP0_` emulator in airplane mode and Wi-Fi disabled, run these commands from `spikes/p0`. Substitute its serial.

```powershell
node native/package.mjs --target x86_64 --session
node native/smoke.mjs android-session emulator-5576
```

The packager stages the native plugin and shared Keystore helper only while compiling this offline variant. The separate output is `native/.run/klaxon-p0-x86_64-session.apk`. The Svelte controls call a Tauri command in the main local WebView. The Android plugin owns a single fixture alias and encrypted record under the test app UID. Native code accepts a fixed synthetic marker during explicit resume. The status-only panel receives allowlisted status strings, including on error. A separate SDK panel in the same offline build exercises the native access grant.

The harness requires a clean fixture install. After seeding one record, it places an empty `cache/p0-provider-offline` file under the debug app UID. Two fresh app processes attempt the same WebView resume. Each must return only `retry-required` and leave the encrypted record byte-for-byte intact. The harness removes the flag and retries in another fresh process without reseeding. Resume must return `authenticated`.

The harness then sets `cache/p0-provider-expired` to simulate definitive expiry. Cold resume must clear the scoped Keystore alias and encrypted record before returning `signed-out`. The harness checks the private record directory, removes the expiry flag, and starts another process. Resume must still require sign-in. An explicit fresh seed must succeed and restore access on cold resume. Sign-out must survive the final relaunch. The harness checks raw callbacks, WebView stores and app logs, then uninstalls. The [P0 register](../../../docs/klaxon-v2-progress.md#packaged-android-session-evidence) records the artifacts and observations.

### Packaged Android SDK handoff

Use the same offline x86_64 session APK on a booted, disposable API 36 emulator named `KlaxonSessionP0_` followed by letters or digits. Before installation the runner requires airplane mode, Wi-Fi off, no default network, no existing spike install and no ADB mappings on that emulator. From `spikes/p0`, substitute its verified serial.

```powershell
node native/package.mjs --target x86_64 --session
node native/smoke.mjs android-sdk emulator-5576
```

The installer reserves `/data/local/tmp/klaxon-p0-install-active` on the selected disposable emulator until uninstall finishes. If it reports an uncertain outcome, preserve that directory and inspect its `status` and `result` files before another run. A second caller cannot claim the same reservation. The offline installer regression tests run under `npm run test:portable`.

The initial sign-in check force-stops the app twice before first publication. Cold resume must retire the orphan key, and a separate cold sign-in must recover without a preceding resume. The test also restores an encrypted backup and resumes its original owner to verify the backup and its key survived.

The first case rotates a synthetic grant and drops the simulated issuer’s sign-out reply. Pending sign-out must survive relaunch and retain the encrypted record. The runner later force-stops the acknowledged writer before cleanup and retries offline in a fresh process. Restoring the old ciphertext checks whether the original key can still open it. [Sign-out evidence](../../../docs/klaxon-v2-progress.md#android-sign-out-after-a-lost-acknowledgment)

The SDK panel selects its owner only after the plugin reopens the Keystore-protected record. The runner checks real SDK reads and subscriptions with an intercepted provider. It exercises corruption, refresh denial during an outage, cold recovery, owner switching, definitive expiry, and sign-out. It observes the Android IPC command and matching callback, checks the visible rows and browser stores, and scans logcat for the fixture process IDs. It verifies scoped alias and file cleanup, uninstalls the APK and removes its own ADB mappings. Shut down the test emulator after the run. [Test evidence and limits](../../../docs/klaxon-v2-progress.md#packaged-android-keystore-to-sdk-handoff)

The same command exercises a simulated refresh-token exchange. It verifies that an invalid response, an owner mismatch, a blocked stage or a failed publication denies access and preserves the recoverable predecessor. After a successful exchange a fresh app process must present the saved successor. Replaying the retired ciphertext must clear only the session slot and its Keystore alias.

After force-stop the runner scans the regular files in the test package’s `app_webview` and `cache` directories. It decodes each file from base64 so host ADB newline conversion cannot alter its bytes. A four-byte control checks the transport before the session run. The scanner checks known raw, base64 and hexadecimal forms in single-byte and UTF-16LE text. The results cover the final accessible bytes. Other encodings and earlier writes that disappeared before inspection are outside that evidence.

The SDK smoke also pauses a pending refresh after syncing its stage and, in a second process, after publishing the replacement. In each case the harness checks the live writer PID and pending callback, force-stops only the installed fixture, then waits for the PID and WebView connection to disappear. The next process must recover A1 before publication and A2 after publication. The checkpoint fails closed if its controller disappears. [Android refresh recovery results](../../../docs/klaxon-v2-progress.md#android-refresh-record-recovery)

### Android Keystore lifecycle

The standalone test-only APK `dev.klaxon.p0session` requests no permissions. Two synthetic app users each have a distinct AES-GCM key in the app's Android Keystore namespace and an encrypted marker in its private no-backup directory. A successful restore requires the simulated provider to accept the expected marker generation. The probe uses the platform key generator with randomized encryption and checks that the key object's encoded bytes are unavailable. [Android key generation parameters](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec)

Use the project's JDK 21, Android SDK platform 36 and cached Android Gradle plugin 8.11.0. From the repository root in PowerShell, use the native spike's isolated Android debug-signing directory. Start a fresh disposable API 36 x86_64 AVD named `KlaxonSessionP0_` followed by letters or digits. Set the serial below to that AVD, confirm its name with `adb -s SERIAL emu avd name`, and enable airplane mode with Wi-Fi off on that emulator.

```powershell
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME = "$env:LOCALAPPDATA/Android/Sdk"
$env:ANDROID_USER_HOME = Join-Path (Get-Location) 'spikes/p0/native/.run/android-user'
$env:ADB = "$env:ANDROID_HOME/platform-tools/adb.exe"
./src-tauri/gen/android/gradlew.bat --offline --console=plain -p spikes/p0/native/android-session assembleDebug
node spikes/p0/native/android-session/check.mjs emulator-5576
```

The runner checks the AVD name, QEMU status, completed boot, disconnected network and absence of the test package before installing. It force-stops the app between operations and requires distinct process IDs. After sign-out it checks both test aliases and record files from a fresh app process, then uninstalls the APK. Shut down the disposable AVD after the check. The [P0 register](../../../docs/klaxon-v2-progress.md#android-keystore-emulator-evidence) records the observed results and remaining integration work.

### Packaged offline client

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
