# Klaxon v2 native debug builds

Install the Node version in the repository's [`.node-version`](../../.node-version) and put Rustup on your path. Run these commands from the repository root to build the default web app and record the assets approved for packaging. CI can stage an already verified `apps/web/dist/` and `apps/web/asset-manifest.json` instead.

```sh
npm ci --prefix apps/web
npm --prefix apps/web exec -- playwright-core install --only-shell chromium
npm --prefix apps/web run verify
npm --prefix apps/web run test:browser
node apps/native/asset-manifest.mjs record
npm ci --prefix apps/native
```

Both packaging commands verify the manifest before compiling and embed the same `apps/web/dist/` files. The [Rust toolchain](../../rust-toolchain.toml) and the native npm and Cargo lockfiles pin the build dependencies.

## Windows x64

Use the MSVC Rust host toolchain, Visual Studio Build Tools with the Desktop development with C++ workload, and the Evergreen WebView2 runtime.

```powershell
npm --prefix apps/native run build:windows
```

Open `apps/native/src-tauri/target/debug/klaxon-v2.exe`. The window title is **Klaxon v2**. Tauri resolves v2 app data under `%APPDATA%\dev.klaxon.v2`.

## Android x86_64

Use JDK 21, Android SDK platform 36, build-tools 36.0.0, and NDK 27.1.12297006. Set `JAVA_HOME` to the JDK 21 installation, `ANDROID_HOME` to the SDK, and `NDK_HOME` to the pinned NDK directory under the SDK. Put the JDK and npm on your path.

```sh
rustup target add x86_64-linux-android
npm --prefix apps/native run build:android
```

The command generates the Gradle project under `apps/native/src-tauri/gen/android/` on the first build. The emulator APK is `apps/native/src-tauri/gen/android/app/build/outputs/apk/x86_64/debug/app-x86_64-debug.apk`. Android installs it as `dev.klaxon.v2` with app-private storage. Gradle uses a local debug signing key.
