//! Tauri commands gluing snapshots, the container, and restore staging
//! to the Settings UI. Delivery differs by platform: desktop saves via
//! file dialog; Android writes to the cache dir and hands the file to
//! the system share sheet (reusing the app's existing FileProvider).

use tauri::{AppHandle, Manager, State};

use crate::backup::container::{self, BackupManifest, BackupPayload};
use crate::error::{AppError, AppResult};
use crate::AppState;

fn build_payload(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<BackupPayload> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Invalid(format!("app dir: {e}")))?;

    // Online-backup copy of the live DB straight to a temp file:
    // consistent under WAL, where reading the live file is not. SQLite
    // has no portable to-bytes, so the bytes take one trip through disk.
    let db_bytes = {
        let conn = state.db.lock();
        let tmp = app_dir.join("export-tmp.db");
        let _ = std::fs::remove_file(&tmp);
        {
            let mut dest = rusqlite::Connection::open(&tmp)?;
            let bk = rusqlite::backup::Backup::new(&conn, &mut dest)?;
            bk.run_to_completion(64, std::time::Duration::from_millis(5), None)?;
        }
        let bytes = std::fs::read(&tmp)
            .map_err(|e| AppError::Invalid(format!("read export tmp: {e}")))?;
        let _ = std::fs::remove_file(&tmp);
        bytes
    };

    let iroh_secret = std::fs::read(app_dir.join("klaxon-iroh-secret.bin"))
        .map_err(|e| AppError::Invalid(format!("read iroh secret: {e}")))?;

    let schema_version: i64 = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_version",
            [],
            |r| r.get(0),
        )?
    };
    let device_name = crate::sync::read_identity(&state.db).device_name;

    Ok(BackupPayload {
        manifest: BackupManifest {
            schema_version,
            app_version: env!("CARGO_PKG_VERSION").into(),
            device_name,
            created_ms: crate::models::now_ms(),
        },
        db: db_bytes,
        iroh_secret,
    })
}

/// Seal and deliver. Desktop: save dialog. Android: cache + share sheet.
#[tauri::command]
pub async fn export_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    passphrase: String,
) -> AppResult<String> {
    if passphrase.len() < 8 {
        return Err(AppError::Invalid(
            "passphrase must be at least 8 characters".into(),
        ));
    }
    let payload = build_payload(&app, &state)?;
    let sealed = container::seal(&payload, &passphrase)?;
    let date = chrono::Utc::now().format("%Y-%m-%d");
    let filename = format!("Klaxon-backup-{date}.klaxonbak");
    deliver(&app, &filename, &sealed)
}

#[cfg(desktop)]
fn deliver(app: &AppHandle, filename: &str, sealed: &[u8]) -> AppResult<String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(filename)
        .add_filter("Klaxon backup", &["klaxonbak"])
        .blocking_save_file()
    else {
        return Err(AppError::Invalid("export cancelled".into()));
    };
    let path = path
        .into_path()
        .map_err(|e| AppError::Invalid(format!("save path: {e}")))?;
    std::fs::write(&path, sealed)
        .map_err(|e| AppError::Invalid(format!("write backup: {e}")))?;
    Ok(path.display().to_string())
}

#[cfg(mobile)]
fn deliver(app: &AppHandle, filename: &str, sealed: &[u8]) -> AppResult<String> {
    // Write into the cache dir (covered by the existing FileProvider
    // cache-path entry) and fire the system share sheet via ShareHelper.
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Invalid(format!("cache dir: {e}")))?;
    std::fs::create_dir_all(&cache)
        .map_err(|e| AppError::Invalid(format!("create cache: {e}")))?;
    let path = cache.join(filename);
    std::fs::write(&path, sealed)
        .map_err(|e| AppError::Invalid(format!("write backup: {e}")))?;
    share_via_sheet(&path)?;
    Ok("shared".into())
}

/// Rust→Kotlin: fire ACTION_SEND for the file. `FindClass` on a native
/// thread cannot see app classes (system classloader), so the class is
/// loaded through the application context's classloader — do not
/// "simplify" this to env.find_class.
#[cfg(target_os = "android")]
fn share_via_sheet(path: &std::path::Path) -> AppResult<()> {
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
        .new_string("com.klaxon.app.ShareHelper")
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
        .new_string(path.to_string_lossy())
        .map_err(|e| AppError::Invalid(format!("jstring: {e}")))?;
    env.call_static_method(
        jni::objects::JClass::from(class),
        "shareFile",
        "(Landroid/content/Context;Ljava/lang/String;)V",
        &[(&context).into(), (&jpath).into()],
    )
    .map_err(|e| AppError::Invalid(format!("shareFile: {e}")))?;
    Ok(())
}

#[cfg(all(mobile, not(target_os = "android")))]
fn share_via_sheet(_path: &std::path::Path) -> AppResult<()> {
    Err(AppError::Invalid("share not supported on this platform".into()))
}

/// Read, unseal, validate, stage. Returns "device_name · date" for the UI.
#[tauri::command]
pub async fn stage_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> AppResult<String> {
    use tauri_plugin_fs::FsExt;
    // The fs plugin resolves both plain paths and Android content:// URIs.
    let file_path: tauri_plugin_fs::FilePath = path
        .parse()
        .map_err(|e| AppError::Invalid(format!("path: {e}")))?;
    let bytes = app
        .fs()
        .read(file_path)
        .map_err(|e| AppError::Invalid(format!("read backup: {e}")))?;

    let payload = container::unseal(&bytes, &passphrase)?;

    let current_schema: i64 = {
        let conn = state.db.lock();
        conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_version",
            [],
            |r| r.get(0),
        )?
    };
    if payload.manifest.schema_version > current_schema {
        return Err(AppError::Invalid(
            "this backup came from a newer Klaxon — update the app first".into(),
        ));
    }

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Invalid(format!("app dir: {e}")))?;
    crate::backup::restore::stage(&app_dir, &payload)?;

    let when = chrono::DateTime::from_timestamp_millis(payload.manifest.created_ms)
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    Ok(format!("{} · {}", payload.manifest.device_name, when))
}

#[tauri::command]
pub fn snapshot_status(app: AppHandle) -> AppResult<Option<i64>> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Invalid(format!("app dir: {e}")))?;
    Ok(crate::backup::snapshot::latest_snapshot_ms(&app_dir.join("backups")))
}
