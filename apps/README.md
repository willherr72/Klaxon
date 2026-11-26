# Klaxon v2 foundation

Run the following from the repository root with the Node version in `.node-version`. The default frontend build works offline. Its package, lockfile, and generated output live under `apps/web/`.

```sh
npm ci --prefix apps/web
npm --prefix apps/web run verify
cd apps/web
npx --no-install playwright-core install --only-shell chromium
cd ../..
npm --prefix apps/web run test:browser
node apps/native/asset-manifest.mjs record
```

The browser check opens and reloads the built frontend from a nested static mount. The manifest records the path and SHA-256 of each file in that same build. Transfer `apps/web/dist/` and `apps/web/asset-manifest.json` together between jobs. If they expire, rerun the web job and its consumers together.

### Native builds

With the repository Rust toolchain and the platform SDK installed, choose the build for the target. The Android build requires the x86_64 Rust target and the SDK/NDK from the [Android build setup](../.github/actions/android-build-setup/action.yml).

```sh
npm ci --prefix apps/native
npm --prefix apps/native run build:windows
# For the Android emulator
npm --prefix apps/native run build:android
```

Both commands verify the recorded web assets before invoking Tauri. The shell uses application identifier `dev.klaxon.v2`. The [v2 workflow](../.github/workflows/v2-validation.yml) runs the Windows WebView2 and Android WebView smoke checks against their respective debug artifacts.

### Development configuration

For a Development build, provide the public HTTPS origin in `KLAXON_PUBLIC_DEV_ORIGIN` and run `npm --prefix apps/web run build:development`. The domain contract and authenticated task UI are later P1 work. The [foundation acceptance plan](../docs/superpowers/plans/2026-11-26-p1-foundation.md) describes the checks for this stage.
