# Update Checking (v0.7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Klaxon notices a newer GitHub release, downloads the right artifact on request, and hands it to the OS installer — desktop and Android.

**Architecture:** All logic in a new Rust module `updates.rs` (pure core + network/IO + two tauri commands); a small Kotlin `UpdateInstaller` fires the Android install intent via the existing FileProvider; the webview only renders state. Ships with the already-committed iroh 1.0.3 bump (`0e19c14`), which gets a hardware sync verify before feature work.

**Tech Stack:** Rust (ureq for HTTP, serde_json), Tauri v2 commands/events, Kotlin (FileProvider + ACTION_VIEW), Svelte 5 runes.

## Global Constraints

- Release API: `GET https://api.github.com/repos/willherr72/Klaxon/releases/latest`, header `User-Agent: Klaxon/<version>`, 10 s timeout, unauthenticated.
- Asset names: Windows `Klaxon_{ver}_x64-setup.exe` (fallback: suffix `x64-setup.exe`); Android `klaxon-{ver}-arm64.apk` (fallback: suffix `-arm64.apk`).
- Notify only when latest is **strictly greater** semver; unparsable → never notify.
- Auto-check: ~5 s after launch + every 24 h; auto-check errors are logged, never shown. Manual check/download errors show inline in the Settings row only.
- Downloads go to `<app_cache_dir>/updates/`; partial files deleted on failure; no resume.
- UI copy must include: "Update your other devices too — Klaxon versions must match to sync."
- New dependency: `ureq` only. No tauri-plugin-http / plugin-shell / plugin-updater.
- Serde stays default snake_case (TS types match: `update_available`, `notes_snippet`, …).
- Branch: `feat/v0.7-updates`. `cargo test` zero warnings; svelte-check 0 errors.

---

### Task 1: iroh 1.0.3 hardware sync verify (no code)

**Files:** none (bump already committed as `0e19c14`).

**Interfaces:** Produces: confirmed-good iroh 1.0.3 baseline; later tasks build on this branch.

- [ ] **Step 1: Build + install the phone APK from this branch**

```bash
cd /c/Users/WilliamHerr/Desktop/Code/Klaxon
export JAVA_HOME="C:/Program Files/Android/Android Studio/jbr"
export ANDROID_HOME="C:/Users/WilliamHerr/AppData/Local/Android/Sdk"
export NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
npm run tauri android build -- --apk --target aarch64 --verbose > /tmp/iroh-verify-build.log 2>&1
grep -c "BUILD SUCCESSFUL" /tmp/iroh-verify-build.log   # expect 1
# string-verify ritual, then:
"$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe" install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

- [ ] **Step 2: Desktop dev build on 1.0.3** — ask the user to close installed Klaxon, then `npm run tauri dev`. Both peers now run iroh 1.0.3 (production relay fleet).

- [ ] **Step 3: Warm round-trip** — create a reminder on desktop, confirm it appears on the phone within seconds; edit on phone, confirm back on desktop.

- [ ] **Step 4: Cold pass** — force-stop Klaxon on phone, share a link to Klaxon, confirm `headless sync: attempted 1 peers, 0 failed` in logcat (`adb logcat -s KlaxonRust:V Klaxon:V`) and the thought lands on desktop.

- [ ] **Step 5: Relay path** — phone Wi-Fi off (mobile data), repeat a sync; logcat should show relay usage against `*.relay.iroh.link` (not `iroh-canary`). Record the relay hostname in the task notes.

- [ ] **Step 6:** No commit (nothing changed). Report evidence to the user before proceeding.

---

### Task 2: `updates.rs` pure core

**Files:**
- Create: `src-tauri/src/updates.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod updates;` next to the other module decls)
- Test: inline `#[cfg(test)] mod tests` in `updates.rs`

**Interfaces:**
- Produces: `compare_versions(current: &str, latest_tag: &str) -> bool`; `struct ReleaseInfo { tag: String, name: String, body: String, assets: Vec<ReleaseAsset> }`; `struct ReleaseAsset { name: String, url: String, size: u64 }`; `parse_release(json: &str) -> Option<ReleaseInfo>`; `pick_asset<'a>(assets: &'a [ReleaseAsset], platform: Platform) -> Option<&'a ReleaseAsset>`; `enum Platform { WindowsX64, AndroidArm64 }`.

- [ ] **Step 1: Write the failing tests** (in the new file, with `todo!()`-free stubs absent so it fails to compile — then implement):

```rust
//! Update checking against GitHub releases. Pure core here; network,
//! download, and hand-off live below behind the tauri commands.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strictly_newer_versions_notify() {
        assert!(compare_versions("0.6.0", "v0.7.0"));
        assert!(compare_versions("0.6.9", "0.7.0"));
        assert!(compare_versions("0.7.0", "1.0.0"));
        assert!(!compare_versions("0.7.0", "v0.7.0"), "equal is not newer");
        assert!(!compare_versions("0.8.0", "v0.7.0"), "older never notifies");
        assert!(!compare_versions("0.7.0", "garbage"), "unparsable never notifies");
        assert!(!compare_versions("dev", "v9.9.9"), "unparsable current never notifies");
    }

    #[test]
    fn parses_real_release_json() {
        let json = r#"{
          "tag_name": "v0.7.0",
          "name": "v0.7.0 — Updates",
          "body": "notes here",
          "assets": [
            {"name": "klaxon-0.7.0-arm64.apk", "browser_download_url": "https://example.com/a.apk", "size": 42569345},
            {"name": "Klaxon_0.7.0_x64-setup.exe", "browser_download_url": "https://example.com/s.exe", "size": 7549360}
          ]
        }"#;
        let r = parse_release(json).unwrap();
        assert_eq!(r.tag, "v0.7.0");
        assert_eq!(r.assets.len(), 2);
        assert!(parse_release("{}").is_none(), "missing tag_name is not a release");
        assert!(parse_release("not json").is_none());
    }

    #[test]
    fn picks_platform_asset_exact_then_suffix() {
        let assets = vec![
            ReleaseAsset { name: "klaxon-0.7.0-arm64.apk".into(), url: "u1".into(), size: 1 },
            ReleaseAsset { name: "Klaxon_0.7.0_x64-setup.exe".into(), url: "u2".into(), size: 2 },
        ];
        assert_eq!(pick_asset(&assets, Platform::AndroidArm64).unwrap().url, "u1");
        assert_eq!(pick_asset(&assets, Platform::WindowsX64).unwrap().url, "u2");
        let odd = vec![ReleaseAsset { name: "Klaxon-nightly_x64-setup.exe".into(), url: "u3".into(), size: 3 }];
        assert_eq!(pick_asset(&odd, Platform::WindowsX64).unwrap().url, "u3", "suffix fallback");
        assert!(pick_asset(&odd, Platform::AndroidArm64).is_none());
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cd src-tauri && cargo test updates` → compile error (functions undefined).

- [ ] **Step 3: Implement the core**

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAsset { pub name: String, pub url: String, pub size: u64 }

#[derive(Debug, Clone)]
pub struct ReleaseInfo { pub tag: String, pub name: String, pub body: String, pub assets: Vec<ReleaseAsset> }

#[derive(Debug, Clone, Copy)]
pub enum Platform { WindowsX64, AndroidArm64 }

fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next()?.parse().ok()?;
    // Tolerate a trailing qualifier on patch ("1-rc.0") by taking leading digits.
    let patch_raw = it.next()?;
    let digits: String = patch_raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    let patch = digits.parse().ok()?;
    Some((maj, min, patch))
}

/// True only when `latest_tag` is strictly newer than `current`.
/// Anything unparsable is "not newer" — never nag on garbage.
pub fn compare_versions(current: &str, latest_tag: &str) -> bool {
    match (parse_semver(current), parse_semver(latest_tag)) {
        (Some(c), Some(l)) => l > c,
        _ => false,
    }
}

pub fn parse_release(json: &str) -> Option<ReleaseInfo> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let tag = v.get("tag_name")?.as_str()?.to_string();
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or(&tag).to_string();
    let body = v.get("body").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let assets = v
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|a| {
                    Some(ReleaseAsset {
                        name: a.get("name")?.as_str()?.to_string(),
                        url: a.get("browser_download_url")?.as_str()?.to_string(),
                        size: a.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(ReleaseInfo { tag, name, body, assets })
}

pub fn pick_asset<'a>(assets: &'a [ReleaseAsset], platform: Platform) -> Option<&'a ReleaseAsset> {
    let ver = env!("CARGO_PKG_VERSION"); // exact-name preference is best-effort
    let (exact, suffix) = match platform {
        Platform::WindowsX64 => (format!("Klaxon_{ver}_x64-setup.exe"), "x64-setup.exe"),
        Platform::AndroidArm64 => (format!("klaxon-{ver}-arm64.apk"), "-arm64.apk"),
    };
    assets
        .iter()
        .find(|a| a.name == exact)
        .or_else(|| assets.iter().find(|a| a.name.ends_with(suffix)))
}
```

Note: `pick_asset`'s exact-name uses the *running* version, which rarely matches the *latest* release — the suffix fallback is the path that fires in practice, and the test covers it. Keep both: exact match guards against a future release accidentally attaching two `.exe`s.

- [ ] **Step 4:** `cargo test updates` → 3 tests PASS. Add `mod updates;` to `lib.rs` module decls if not done.

- [ ] **Step 5: Commit** — `git add src-tauri/src/updates.rs src-tauri/src/lib.rs && git commit -m "feat(updates): pure core — version compare, release parse, asset pick"`

---

### Task 3: network check, download, commands, desktop hand-off

**Files:**
- Modify: `src-tauri/src/updates.rs` (append), `src-tauri/Cargo.toml` (add `ureq = "2"` to `[dependencies]`), `src-tauri/src/lib.rs` (register two commands in `generate_handler!` after `commands::start_pair_with` block area)

**Interfaces:**
- Consumes: Task 2's core functions.
- Produces: commands `check_for_update() -> UpdateCheck` and `download_and_install_update() -> ()`; `struct UpdateCheck { current: String, latest: String, release_name: String, notes_snippet: String, update_available: bool, asset_found: bool }` (Serialize); event `update-download-progress` (u8 percent). Task 4 fills in `install_apk`; Task 5 calls the commands.

- [ ] **Step 1: Add dependency** — in `src-tauri/Cargo.toml` `[dependencies]`: `ureq = "2"` (default features: rustls + bundled webpki roots — works on Android with no system-cert access).

- [ ] **Step 2: Implement network + commands** (append to `updates.rs`):

```rust
use serde::Serialize;

use crate::error::{AppError, AppResult};

const RELEASES_URL: &str = "https://api.github.com/repos/willherr72/Klaxon/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
    pub current: String,
    pub latest: String,
    pub release_name: String,
    pub notes_snippet: String,
    pub update_available: bool,
    pub asset_found: bool,
}

fn current_platform() -> Platform {
    #[cfg(target_os = "android")]
    { Platform::AndroidArm64 }
    #[cfg(not(target_os = "android"))]
    { Platform::WindowsX64 }
}

fn fetch_latest_release() -> AppResult<ReleaseInfo> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    let body = agent
        .get(RELEASES_URL)
        .set("User-Agent", concat!("Klaxon/", env!("CARGO_PKG_VERSION")))
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| AppError::Invalid(format!("release check: {e}")))?
        .into_string()
        .map_err(|e| AppError::Invalid(format!("release read: {e}")))?;
    parse_release(&body).ok_or_else(|| AppError::Invalid("release parse failed".into()))
}

fn truncate_notes(body: &str) -> String {
    let mut s: String = body.chars().take(400).collect();
    if body.chars().count() > 400 {
        s.push('…');
    }
    s
}

#[tauri::command]
pub async fn check_for_update() -> AppResult<UpdateCheck> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let rel = fetch_latest_release()?;
        let update_available = compare_versions(&current, &rel.tag);
        let asset_found = pick_asset(&rel.assets, current_platform()).is_some();
        Ok(UpdateCheck {
            current,
            latest: rel.tag.trim_start_matches('v').to_string(),
            release_name: rel.name,
            notes_snippet: truncate_notes(&rel.body),
            update_available,
            asset_found,
        })
    })
    .await
    .map_err(|e| AppError::Invalid(format!("check task: {e}")))?
}

#[tauri::command]
pub async fn download_and_install_update(app: tauri::AppHandle) -> AppResult<()> {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn_blocking(move || {
        // Re-resolve: never install from a stale cached URL.
        let rel = fetch_latest_release()?;
        if !compare_versions(env!("CARGO_PKG_VERSION"), &rel.tag) {
            return Err(AppError::Invalid("no newer release".into()));
        }
        let asset = pick_asset(&rel.assets, current_platform())
            .ok_or_else(|| AppError::Invalid("no matching asset".into()))?
            .clone();

        let dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| AppError::Invalid(format!("cache dir: {e}")))?
            .join("updates");
        std::fs::create_dir_all(&dir)
            .map_err(|e| AppError::Invalid(format!("mkdir: {e}")))?;
        let dest = dir.join(&asset.name);

        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(300))
            .build();
        let resp = agent
            .get(&asset.url)
            .set("User-Agent", concat!("Klaxon/", env!("CARGO_PKG_VERSION")))
            .call()
            .map_err(|e| AppError::Invalid(format!("download: {e}")))?;

        let result = (|| -> AppResult<()> {
            let mut reader = resp.into_reader();
            let mut file = std::fs::File::create(&dest)
                .map_err(|e| AppError::Invalid(format!("create: {e}")))?;
            let mut buf = [0u8; 64 * 1024];
            let mut done: u64 = 0;
            let mut last_pct: u8 = 0;
            loop {
                let n = std::io::Read::read(&mut reader, &mut buf)
                    .map_err(|e| AppError::Invalid(format!("read: {e}")))?;
                if n == 0 {
                    break;
                }
                std::io::Write::write_all(&mut file, &buf[..n])
                    .map_err(|e| AppError::Invalid(format!("write: {e}")))?;
                done += n as u64;
                if asset.size > 0 {
                    let pct = ((done * 100) / asset.size).min(100) as u8;
                    if pct != last_pct {
                        last_pct = pct;
                        let _ = app.emit("update-download-progress", pct);
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&dest); // no partial files, no resume
            return result;
        }

        hand_off(&dest)
    })
    .await
    .map_err(|e| AppError::Invalid(format!("download task: {e}")))?
}

#[cfg(not(target_os = "android"))]
fn hand_off(installer: &std::path::Path) -> AppResult<()> {
    // NSIS handles close-and-replace; the app keeps running until then.
    std::process::Command::new(installer)
        .spawn()
        .map_err(|e| AppError::Invalid(format!("launch installer: {e}")))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn hand_off(apk: &std::path::Path) -> AppResult<()> {
    install_apk(apk) // Task 4
}
```

`ReleaseAsset` needs `#[derive(Clone)]` — already has Clone from Task 2. Add `use` lines at top as needed.

- [ ] **Step 3: Register commands** — in `lib.rs` `generate_handler!` list add:

```rust
            updates::check_for_update,
            updates::download_and_install_update,
```

- [ ] **Step 4: Verify** — `cargo test` all pass, zero warnings (note: on the desktop host, `install_apk` is not compiled; the android arm compiles in Task 4). `cargo check` clean.

- [ ] **Step 5: Manual desktop smoke** — `cargo run` briefly (or defer to Task 6's drill): invoke `check_for_update` from devtools console: `window.__TAURI__.core.invoke('check_for_update')` → resolves with `update_available: false` on 0.7.0-dev vs v0.6.0 release... (current dev version 0.7.0 vs latest release v0.6.0 → false; correct).

- [ ] **Step 6: Commit** — `git add -A src-tauri && git commit -m "feat(updates): release check, streaming download, desktop hand-off"`

---

### Task 4: Android install hand-off

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/klaxon/app/UpdateInstaller.kt`
- Modify: `src-tauri/gen/android/app/src/main/AndroidManifest.xml` (one permission line), `src-tauri/src/updates.rs` (append `install_apk`)

**Interfaces:**
- Consumes: Task 3's `hand_off` android arm calling `install_apk(apk: &Path) -> AppResult<()>`.
- Produces: `UpdateInstaller.install(context: Context, apkPath: String): Boolean` reachable via classloader JNI.

- [ ] **Step 1: Manifest permission** — next to the existing `uses-permission` block add:

```xml
    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

The existing FileProvider (`${applicationId}.fileprovider`, `res/xml/file_paths.xml` with `<cache-path path="."/>`) already covers the cache `updates/` dir — no provider changes.

- [ ] **Step 2: Kotlin helper**

```kotlin
package com.klaxon.app

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File

/**
 * Hands a downloaded APK to Android's package installer. The release
 * signing key matches the installed app, so this is an in-place upgrade
 * with data intact. First use, Android asks the user once to allow
 * installs from Klaxon — that prompt is the OS's, not ours.
 */
object UpdateInstaller {
  private const val TAG = "Klaxon"

  @JvmStatic
  fun install(context: Context, apkPath: String): Boolean {
    return try {
      val uri = FileProvider.getUriForFile(
        context, "${context.packageName}.fileprovider", File(apkPath)
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      context.startActivity(intent)
      Log.i(TAG, "update install intent fired for ${File(apkPath).name}")
      true
    } catch (t: Throwable) {
      Log.w(TAG, "update install failed", t)
      false
    }
  }
}
```

- [ ] **Step 3: JNI bridge** (append to `updates.rs`; same classloader pattern as `os_alarms::call_kotlin_reconcile` — `FindClass` on native threads can't see app classes):

```rust
#[cfg(target_os = "android")]
fn install_apk(apk: &std::path::Path) -> AppResult<()> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| AppError::Invalid(format!("jvm: {e}")))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| AppError::Invalid(format!("attach: {e}")))?;
    let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };

    let loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("classloader: {e}")))?;
    let name = env
        .new_string("com.klaxon.app.UpdateInstaller")
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&name).into()],
        )
        .and_then(|v| v.l())
        .map_err(|e| AppError::Invalid(format!("loadClass: {e}")))?;

    let jpath = env
        .new_string(apk.to_string_lossy())
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    let ok = env
        .call_static_method(
            jni::objects::JClass::from(class),
            "install",
            "(Landroid/content/Context;Ljava/lang/String;)Z",
            &[(&context).into(), (&jpath).into()],
        )
        .and_then(|v| v.z())
        .map_err(|e| AppError::Invalid(format!("install call: {e}")))?;
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid("kotlin install reported failure".into()))
    }
}
```

- [ ] **Step 4: Verify compile for Android** — full APK build (`npm run tauri android build -- --apk --target aarch64 --verbose`), `BUILD SUCCESSFUL`, then string-verify `UpdateInstaller` in the dex.

- [ ] **Step 5: Commit** — `git add -f src-tauri/gen/android/app/src/main/AndroidManifest.xml src-tauri/gen/android/app/src/main/java/com/klaxon/app/UpdateInstaller.kt && git add src-tauri/src/updates.rs && git commit -m "feat(updates): Android install hand-off via FileProvider intent"`

---

### Task 5: frontend — auto-check, Settings row, status hint

**Files:**
- Modify: `src/lib/api.ts` (types + two wrappers), `src/App.svelte` (auto-check timer + state + props), `src/lib/components/SettingsModal.svelte` (System-section update row, manual check), `src/lib/components/StatusBar.svelte` (one-line hint)

**Interfaces:**
- Consumes: commands from Task 3 (`check_for_update`, `download_and_install_update`), event `update-download-progress`.
- Produces: `api.checkForUpdate(): Promise<UpdateCheck>`, `api.downloadAndInstallUpdate(): Promise<void>`, `UpdateCheck` TS type (snake_case fields).

- [ ] **Step 1: api.ts** — add to the types import area and `api` object:

```ts
export interface UpdateCheck {
  current: string;
  latest: string;
  release_name: string;
  notes_snippet: string;
  update_available: boolean;
  asset_found: boolean;
}
// in api object:
  checkForUpdate: () => invoke<UpdateCheck>("check_for_update"),
  downloadAndInstallUpdate: () =>
    invoke<void>("download_and_install_update"),
```

- [ ] **Step 2: App.svelte** — state + auto-check (near the other startup work in `onMount`, after the notification-permission block):

```ts
let availableUpdate = $state<UpdateCheck | null>(null);

async function runUpdateCheck(silent: boolean) {
  try {
    const r = await api.checkForUpdate();
    availableUpdate = r.update_available ? r : null;
  } catch (e) {
    if (!silent) throw e;
    console.warn("update check failed (silent)", e);
  }
}
// in onMount:
setTimeout(() => void runUpdateCheck(true), 5_000);
setInterval(() => void runUpdateCheck(true), 24 * 60 * 60 * 1000);
```

Pass `availableUpdate` down: `<StatusBar … {availableUpdate} />` and `<SettingsModal … {availableUpdate} onUpdateChecked={(r) => (availableUpdate = r?.update_available ? r : null)} />`.

- [ ] **Step 3: SettingsModal System row** — at the top of the System section (`section-title "System"`, ~line 653), matching existing row markup/classes:

```svelte
{#if availableUpdate}
  <div class="settings-row update-row">
    <div>
      <div class="mono-caps">Update available: v{availableUpdate.latest}</div>
      <div class="hint">{availableUpdate.release_name}</div>
      {#if availableUpdate.notes_snippet}<div class="hint">{availableUpdate.notes_snippet}</div>{/if}
      <div class="hint">Update your other devices too — Klaxon versions must match to sync.</div>
    </div>
    {#if availableUpdate.asset_found}
      <button onclick={startUpdate} disabled={updBusy}>
        {updBusy ? `Downloading… ${updPct}%` : "Update"}
      </button>
    {:else}
      <a href="https://github.com/willherr72/Klaxon/releases/latest" target="_blank">Open release page</a>
    {/if}
    {#if updError}<div class="error">{updError} <button onclick={startUpdate}>Retry</button></div>{/if}
  </div>
{/if}
<div class="settings-row">
  <span>Check for updates</span>
  <button onclick={manualCheck} disabled={updBusy}>Check now</button>
  {#if checkMsg}<span class="hint">{checkMsg}</span>{/if}
</div>
```

With script:

```ts
let updBusy = $state(false);
let updPct = $state(0);
let updError = $state("");
let checkMsg = $state("");

let unlistenProgress: (() => void) | null = null;
onMount(async () => {
  unlistenProgress = await listen<number>("update-download-progress", (e) => (updPct = e.payload));
});
onDestroy(() => unlistenProgress?.());

async function manualCheck() {
  checkMsg = "";
  try {
    const r = await api.checkForUpdate();
    onUpdateChecked(r);
    checkMsg = r.update_available ? "" : "You're up to date.";
  } catch {
    checkMsg = "Couldn't reach GitHub.";
  }
}

async function startUpdate() {
  updError = "";
  updBusy = true;
  updPct = 0;
  try {
    await api.downloadAndInstallUpdate();
  } catch {
    updError = "Download failed.";
  } finally {
    updBusy = false;
  }
}
```

(`listen` from `@tauri-apps/api/event` — already used elsewhere in the codebase; follow existing import style.)

- [ ] **Step 4: StatusBar hint** — accept `availableUpdate` prop; render, in the same muted style as existing status text: `{#if availableUpdate}<span class="update-hint">v{availableUpdate.latest} available — see Settings</span>{/if}`

- [ ] **Step 5: Verify** — `npm run build` clean; `npx svelte-check` 0 errors; `npm run tauri dev` shows no row (latest release 0.6.0 < dev 0.7.0), "Check now" says "You're up to date."

- [ ] **Step 6: Commit** — `git add src/lib/api.ts src/App.svelte src/lib/components/SettingsModal.svelte src/lib/components/StatusBar.svelte && git commit -m "feat(updates): auto-check, Settings update row, status hint"`

---

### Task 6: hardware drills, changelog, release v0.7.0

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (versions → 0.7.0)

**Interfaces:** Consumes everything above.

- [ ] **Step 1: Bootstrap drill build (phone)** — the installed 0.6.0 has no checker, so stage a lower-versioned build *with* the feature: set all three versions to `0.6.9`, build the APK, string-verify, `adb install -r` (0.6.0 → 0.6.9 upgrade OK). Revert versions to `0.7.0` immediately after install.

- [ ] **Step 2: Versions + changelog** — bump the three version fields to `0.7.0`; add the `## [0.7.0]` changelog entry covering update checking + iroh 1.0.3 (production relays; upgrade both devices together). Commit.

- [ ] **Step 3: Full verification + release** — `cargo test` (expect 106+, zero warnings), svelte-check 0 errors; merge `feat/v0.7-updates` → main (`--no-ff`); build desktop NSIS + APK; string-verify APK; tag `v0.7.0`; push; `gh release create v0.7.0` with `klaxon-0.7.0-arm64.apk` + `Klaxon_0.7.0_x64-setup.exe` (naming contract feeds the checker).

- [ ] **Step 4: Android drill (the real thing)** — open Klaxon 0.6.9 on the phone (network on): Settings shows "Update available: v0.7.0" → Update → download progress → Android install prompt (first time: allow installs from Klaxon) → app relaunches as 0.7.0 with data intact. Evidence: `versionName=0.7.0` in dumpsys.

- [ ] **Step 5: Desktop drill** — user's installed 0.6.0 has no checker; user installs `Klaxon_0.7.0_x64-setup.exe` by hand this one last time. Then in 0.7.0: "Check now" → "You're up to date." Desktop *download* path was smoke-tested in dev; the full NSIS hand-off drill happens organically at v0.7.1.

- [ ] **Step 6:** Update memory (milestone + roadmap), mark tasks complete.

## Self-review notes

- Spec coverage: cadence/UI (Task 5), commands + download + desktop hand-off (Task 3), Android hand-off + permission + FileProvider reuse (Task 4), pure-core tests (Task 2), iroh verify (Task 1), release + drills (Task 6). Copy string present (Task 5 Step 3). Error rules: silent auto-check (App.svelte `silent`), inline manual errors (SettingsModal), partial-file deletion (Task 3).
- Type consistency: `UpdateCheck` fields snake_case in Rust Serialize and TS; `install_apk(&Path) -> AppResult<()>` matches Task 3's android `hand_off`; `UpdateInstaller.install(Context, String): Boolean` matches the JNI signature `(Landroid/content/Context;Ljava/lang/String;)Z`.
- Known judgment call: `pick_asset` exact-name uses the running version (documented in Task 2); suffix fallback is the effective path.
