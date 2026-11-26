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

For a Development build, set `KLAXON_PUBLIC_DEV_ORIGIN` to the Development deployment’s public HTTPS origin and run `npm --prefix apps/web run build:development`. Serve `apps/web/dist/` from an HTTPS static host. Sign in with an enrolled account to open Today, capture a task, review a day plan or manage reminders. Workspace reads and writes require a connection. The PWA can reopen its cached sign-in screen offline, and a clean tab can explicitly reload to apply an update.

On Windows with the pinned local Convex backend and both app packages installed, run `npm --prefix apps/web run test:planner:local` for the two-browser workflow. It exercises capture, promotion, a revision-safe undo, and weekly reminder dismissal and completion. [Backend setup](backend/README.md) · [Delivery settings](../docs/v2-operations.md#web-push-delivery)
