//! Update checking against GitHub releases. Pure core up top —
//! host-testable, no network; the network fetch, streaming download, and
//! platform hand-off live below behind the two tauri commands.

use serde::Serialize;

use crate::error::{AppError, AppResult};

const RELEASES_URL: &str = "https://api.github.com/repos/willherr72/Klaxon/releases/latest";

#[derive(Debug, Clone, PartialEq)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct ReleaseInfo {
    pub tag: String,
    pub name: String,
    pub body: String,
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Copy)]
// Each platform's build constructs only its own variant; the other is
// exercised by tests. Silence the per-target never-constructed lint.
#[allow(dead_code)]
pub enum Platform {
    WindowsX64,
    AndroidArm64,
}

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

/// Exact-name match is best-effort (uses the *running* version, which
/// rarely equals the latest release's); the suffix fallback is the path
/// that fires in practice. Exact stays as a guard against a release
/// accidentally attaching two installers.
pub fn pick_asset<'a>(assets: &'a [ReleaseAsset], platform: Platform) -> Option<&'a ReleaseAsset> {
    let ver = env!("CARGO_PKG_VERSION");
    let (exact, suffix) = match platform {
        Platform::WindowsX64 => (format!("Klaxon_{ver}_x64-setup.exe"), "x64-setup.exe"),
        Platform::AndroidArm64 => (format!("klaxon-{ver}-arm64.apk"), "-arm64.apk"),
    };
    assets
        .iter()
        .find(|a| a.name == exact)
        .or_else(|| assets.iter().find(|a| a.name.ends_with(suffix)))
}

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
    {
        Platform::AndroidArm64
    }
    #[cfg(not(target_os = "android"))]
    {
        Platform::WindowsX64
    }
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
        std::fs::create_dir_all(&dir).map_err(|e| AppError::Invalid(format!("mkdir: {e}")))?;
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
            // No partial files, no resume — a retry starts clean.
            let _ = std::fs::remove_file(&dest);
            return result;
        }

        hand_off(&dest)
    })
    .await
    .map_err(|e| AppError::Invalid(format!("download task: {e}")))?
}

/// NSIS handles close-and-replace; the app keeps running until then.
#[cfg(not(target_os = "android"))]
fn hand_off(installer: &std::path::Path) -> AppResult<()> {
    std::process::Command::new(installer)
        .spawn()
        .map_err(|e| AppError::Invalid(format!("launch installer: {e}")))?;
    Ok(())
}

#[cfg(target_os = "android")]
fn hand_off(apk: &std::path::Path) -> AppResult<()> {
    install_apk(apk)
}

/// Classloader-JNI into UpdateInstaller — same pattern as
/// `os_alarms::call_kotlin_reconcile` (FindClass on native threads can't
/// see app classes).
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
        assert_eq!(r.name, "v0.7.0 — Updates");
        assert_eq!(r.assets.len(), 2);
        assert_eq!(r.assets[0].size, 42569345);
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
        let odd = vec![ReleaseAsset {
            name: "Klaxon-nightly_x64-setup.exe".into(),
            url: "u3".into(),
            size: 3,
        }];
        assert_eq!(
            pick_asset(&odd, Platform::WindowsX64).unwrap().url,
            "u3",
            "suffix fallback"
        );
        assert!(pick_asset(&odd, Platform::AndroidArm64).is_none());
    }

    #[test]
    fn notes_truncate_at_400_chars() {
        let long = "x".repeat(500);
        let t = truncate_notes(&long);
        assert_eq!(t.chars().count(), 401, "400 + ellipsis");
        assert!(t.ends_with('…'));
        assert_eq!(truncate_notes("short"), "short");
    }
}
