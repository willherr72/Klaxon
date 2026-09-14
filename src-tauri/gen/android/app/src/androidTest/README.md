# Disposable emulator sync regression

These tests launch the real MainActivity and use the production Rust sync loop,
Iroh client, and host SyncHandler. No application test hooks, release signing
credentials, physical phones, or existing app databases are involved.

Build the frontend first, then the Linux host fixture:

```sh
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --locked --example android_sync_peer --example android_pair_peer
npx tauri android build --debug --target x86_64 --apk
cd src-tauri/gen/android
./gradlew :app:assembleUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug
cd ../../..
```

The Android build requires Java 21, Android SDK 36, NDK 27.1.12297006, and Rust
target `x86_64-linux-android`. The Tauri CLI generates Gradle bindings before
the instrumentation-only Gradle invocation. Both APKs use the debug key.

Start a fresh accelerated x86_64 emulator (CI uses API 35/36), then run:

```sh
python scripts/android-emulator-test.py \
  --serial emulator-5554 \
  --apk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk \
  --test-apk src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --peer src-tauri/target/debug/examples/android_sync_peer \
  --pair-peer src-tauri/target/debug/examples/android_pair_peer \
  --output artifacts/android-basic
```

The output directory must be new. The harness refuses a non-emulator serial,
requires `ro.kernel.qemu=1`, and refuses an existing Klaxon installation. Every
ADB call specifies the serial. Only the installation created by this harness
can be replaced or removed.

Fixture database access uses the emulator's `sqlite3` command through `run-as`
in a separate process. Do not use framework SQLite inside the app process:
Rust bundles its own SQLite, and independent SQLite libraries cannot safely
share a database within one process. The harness requires the system SQLite
CLI and Android API 31 or newer for shell input/output handling.

Basic coverage verifies completed push and pull, a fresh successful sync after
Home/background/resume, and another fresh sync after force-stop/process restart.
Each phase checks literal incoming content and the preserved pairing/secret and
sentinel reminder. The independent host also checks the actual outgoing content.
Separate instrumentation invocations provide real process restarts.

The harness passes `-e waitForActivitiesToComplete false`, supported by the
pinned [AndroidJUnitRunner 1.5.2 sources](https://dl.google.com/dl/android/maven2/androidx/test/runner/1.5.2/runner-1.5.2-sources.jar)
and [MonitoringInstrumentation 1.6.1 sources](https://dl.google.com/dl/android/maven2/androidx/test/monitor/1.6.1/monitor-1.6.1-sources.jar).
This disables the runner's extra `Activity.finish()` calls after test assertions.
The explicit Home/resume transitions and host `am force-stop` between phases
remain; instrumentation still terminates its process when reporting results.
The parser still requires one completed passing test and rejects process crashes.

Run 34799673475 exposed a native destroyed-mutex diagnostic immediately after the
runner forced MainActivity through `DESTROYED`, after the initial sync assertions
passed. Logcat also records a clean process exit with code zero; there was no
completed native tombstone. Tauri's last-window destruction requests process
exit, so this evidence does not establish which native component owns the mutex.
Disabling injected teardown does not fix that native shutdown behavior.

`NativeLifecycleTest` separately taps the actual launcher icon, presses Back, then
reopens and verifies actual Rust command responses, the stored device identity,
and the preserved reminder. Android also checks that the launch came from Home;
an app-originated MAIN/LAUNCHER intent does not reproduce icon-launched Back.
This normal Back path is required in every run.
Explicit `recreate` and `finish` are available through the manual Android
Activity diagnostic workflow or `--lifecycle-probe recreate|finish`. Their
durable markers show how far the Activity got if its process exits before JUnit
reports. Missing completion remains a failure. Crash-buffer logs and Android
process-exit information are retained without app-UID filtering.

The upstream [Activity relaunch issue](https://github.com/tauri-apps/tauri/issues/15671)
explains why simply preventing process exit can leave a blank webview. No such
workaround is applied by this suite.

`PairingFlowTest` exercises the actual incoming pairing dialog and production
Iroh PairHandler. A second host fixture sends a real offer through emulator UDP
redirects, using only the app's public endpoint identity and socket ports.
Approval must produce a matching secret digest and authenticated bidirectional
sync; decline must create no peer. Extended runs also wait for the real
120-second expiration and verify the dialog closes and stale approval fails.
Only synthetic fixture files and digests enter diagnostics; endpoint keys and
pairing secrets are not exported. Emulator redirects are removed after each case.

An identity phase after each seed launches the app with sync enabled, waits for
its 32-byte Iroh key, and saves only its SHA-256 hash and device ID in a test-only
sentinel. Each sync phase verifies those identities before launch and after sync.
The older APK creates its own identity baseline before upgrade; it need not sync
successfully with the newer host. Raw key bytes are never written to test output.

For the nightly suite, append `--extended --previous-apk /path/to/older.apk`.
Build the older source tag (currently v0.10.2) for x86_64 with the same debug
keystore. The extended suite requires that baseline: it disables Wi-Fi and mobile
data, waits for a persisted sync failure, re-enables connectivity and verifies
recovery in the same app process. It then seeds a fresh older installation,
performs `adb install -r` of the current APK, checks strictly increasing version
codes, and verifies pairing/data retention plus a fresh bidirectional sync.

The host example accepts one new fixture directory, creates a memory-only
database and fresh identity, and binds a direct UDP endpoint with relays disabled.
`fixture.json` contains the synthetic pairing and the emulator host address
`10.0.2.2`; `stage.txt` selects a new incoming fixture; `report.json` exposes
committed outgoing rows; creating `stop` shuts it down. Its lifetime is capped
at 30 minutes. Instrumentation calls have a five-minute outer deadline and
individual assertions a 100-second deadline. Missing execution, crashes and
Android's exit-zero instrumentation failures all fail the harness.

Diagnostics include individual instrumentation output, the host report/log,
bounded app startup/final logs, logcat, activity/package state and a structured
`results.json`. Database failures include schema and redacted settings. Retain
these briefly in CI; there is no reason to upload an emulator image or build
tree. Parser regressions run without Android:

```sh
python -m unittest discover -s scripts/tests -p test_android_emulator_test.py -v
```

This covers emulator lifecycle and simulated connectivity loss. It does not
claim Samsung battery-management behavior, real cellular/Wi-Fi roaming,
relay availability, or the physical APK installation confirmation UI.
