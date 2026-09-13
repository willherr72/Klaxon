# Disposable emulator sync regression

These tests launch the real MainActivity and use the production Rust sync loop,
Iroh client, and host SyncHandler. No application test hooks, release signing
credentials, physical phones, or existing app databases are involved.

Build the frontend first, then the Linux host fixture:

```sh
npm ci
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --locked --example android_sync_peer
npx tauri android build --debug --target x86_64 --apk
cd src-tauri/gen/android
./gradlew :app:assembleUniversalDebugAndroidTest -x :app:rustBuildUniversalDebug
cd ../../..
```

The Android build requires Java 21, Android SDK 36, NDK 27.1.12297006, and Rust
target `x86_64-linux-android`. The Tauri CLI generates Gradle bindings before
the instrumentation-only Gradle invocation. Both APKs use the debug key.

Start a fresh accelerated x86_64 emulator, then run:

```sh
python scripts/android-emulator-test.py \
  --serial emulator-5554 \
  --apk src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk \
  --test-apk src-tauri/gen/android/app/build/outputs/apk/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --peer src-tauri/target/debug/examples/android_sync_peer \
  --output artifacts/android-basic
```

The output directory must be new. The harness refuses a non-emulator serial,
requires `ro.kernel.qemu=1`, and refuses an existing Klaxon installation. Every
ADB call specifies the serial. Only the installation created by this harness
can be replaced or removed.

Basic coverage verifies completed push and pull, a fresh successful sync after
Home/background/resume, and another fresh sync after force-stop/process restart.
Each phase checks literal incoming content and the preserved pairing/secret and
sentinel reminder. The independent host also checks the actual outgoing content.
Separate instrumentation invocations provide real process restarts.

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
bounded logcat, activity/package state and a structured `results.json`. Retain
these briefly in CI; there is no reason to upload an emulator image or build
tree. Parser regressions run without Android:

```sh
python -m unittest discover -s scripts/tests -p test_android_emulator_test.py -v
```

This covers emulator lifecycle and simulated connectivity loss. It does not
claim Samsung battery-management behavior, real cellular/Wi-Fi roaming,
relay availability, or the physical APK installation confirmation UI.
