mod alerts;
mod audio;
mod commands;
mod db;
mod error;
mod models;
mod nl;
mod recurrence;
mod scheduler;
mod sync;
mod tray;

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db::settings as cfg;
use crate::error::AppResult;

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub scheduler_tx: tokio::sync::mpsc::UnboundedSender<scheduler::SchedulerMsg>,
    pub audio_tx: std::sync::mpsc::Sender<audio::AudioCmd>,
    pub active_alerts: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub current_hotkey: Arc<Mutex<Option<Shortcut>>>,
    pub discovery: Arc<Mutex<Option<sync::discovery::DiscoveryHandle>>>,
    pub pending_pairs: sync::server::PendingPairs,
    pub local_cert: Arc<Mutex<Option<sync::tls::LocalCert>>>,
    /// v0.3 iroh transport. `None` until phase 1 setup completes (or if
    /// sync is disabled). Holds a cloneable `Endpoint` handle plus the
    /// device's stable EndpointId string.
    pub iroh_node: Arc<Mutex<Option<sync::iroh_node::IrohNode>>>,
}

const DEFAULT_GLOBAL_HOTKEY: &str = "Ctrl+Alt+KeyN";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // rustls 0.23 requires an explicit crypto provider before any TLS use.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_dir)?;

            let db_path = app_dir.join("klaxon.db");
            log::info!("opening db at {}", db_path.display());

            let conn = db::open(&db_path)?;
            let db = Arc::new(Mutex::new(conn));

            let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
            let audio_tx = audio::spawn_engine();
            let current_hotkey: Arc<Mutex<Option<Shortcut>>> = Arc::new(Mutex::new(None));

            let scheduler_db = db.clone();
            let scheduler_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                scheduler::run(scheduler_db, scheduler_handle, rx).await;
            });

            // Sync server + task: started unconditionally; sync task no-ops while
            // sync_enabled is false. Server respects the same flag at startup.
            let sync_db = db.clone();
            let sync_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sync::task::run(sync_db, sync_app).await;
            });

            let discovery_handle: Arc<Mutex<Option<sync::discovery::DiscoveryHandle>>> =
                Arc::new(Mutex::new(None));
            let pending_pairs: sync::server::PendingPairs =
                Arc::new(Mutex::new(HashMap::new()));
            let local_cert_state: Arc<Mutex<Option<sync::tls::LocalCert>>> =
                Arc::new(Mutex::new(None));
            let iroh_node_state: Arc<Mutex<Option<sync::iroh_node::IrohNode>>> =
                Arc::new(Mutex::new(None));
            if sync::read_enabled(&db) {
                let identity = sync::read_identity(&db);
                let port = sync::read_port(&db);
                let cert = match sync::tls::load_or_generate(&app_dir) {
                    Ok(c) => c,
                    Err(e) => {
                        log::error!("could not provision TLS cert: {e}");
                        return Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::Other,
                            e.to_string(),
                        )) as Box<dyn std::error::Error>);
                    }
                };
                *local_cert_state.lock() = Some(cert.clone());

                // v0.3 phase 1: spin up the iroh endpoint alongside the
                // existing HTTPS sync server. `block_on` is OK here — bind
                // is a fast local socket op plus reading a 32-byte key file.
                // We tolerate failure: a missing iroh node degrades us to
                // v0.2 LAN-only sync rather than blocking startup entirely.
                let iroh_app_dir = app_dir.clone();
                let iroh_node_opt = match tauri::async_runtime::block_on(async move {
                    sync::iroh_node::start(&iroh_app_dir).await
                }) {
                    Ok(n) => {
                        *iroh_node_state.lock() = Some(n.clone());
                        Some(n)
                    }
                    Err(e) => {
                        log::error!("iroh endpoint failed to start: {e}");
                        None
                    }
                };

                let server_state = sync::server::ServerState {
                    db: db.clone(),
                    identity: identity.clone(),
                    pending_pairs: pending_pairs.clone(),
                    app: app.handle().clone(),
                    local_cert: cert.clone(),
                };
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sync::server::run(server_state, port).await {
                        log::error!("sync server exited: {e}");
                    }
                });

                let node_id_for_mdns = iroh_node_opt.as_ref().map(|n| n.node_id.clone());
                match sync::discovery::start(
                    identity,
                    port,
                    cert.fingerprint.clone(),
                    node_id_for_mdns,
                ) {
                    Ok(h) => *discovery_handle.lock() = Some(h),
                    Err(e) => log::warn!("mDNS discovery failed to start: {e}"),
                }
            }

            // Install global hotkey from persisted setting (or default if none).
            let stored = {
                let conn = db.lock();
                cfg::get(&conn, "global_hotkey_new")
                    .ok()
                    .flatten()
                    .unwrap_or_else(|| DEFAULT_GLOBAL_HOTKEY.to_string())
            };
            if let Err(e) = install_global_hotkey(&app.handle().clone(), &current_hotkey, &stored) {
                log::warn!("could not register global hotkey {stored:?}: {e}");
            }

            app.manage(AppState {
                db,
                scheduler_tx: tx,
                audio_tx,
                active_alerts: Arc::new(Mutex::new(HashMap::new())),
                current_hotkey,
                discovery: discovery_handle,
                pending_pairs,
                local_cert: local_cert_state,
                iroh_node: iroh_node_state,
            });

            tray::setup(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_reminders,
            commands::get_reminder,
            commands::create_reminder,
            commands::update_reminder,
            commands::delete_reminder,
            commands::snooze_reminder,
            commands::dismiss_reminder,
            commands::complete_reminder,
            commands::next_reminder,
            commands::get_setting,
            commands::set_setting,
            commands::list_settings,
            commands::data_dir,
            commands::set_global_hotkey,
            commands::preview_tone,
            commands::nl_parse,
            commands::list_peers,
            commands::add_peer,
            commands::remove_peer,
            commands::ping_peer,
            commands::device_identity,
            commands::generate_secret,
            commands::set_sync_enabled,
            commands::list_discovered_peers,
            commands::start_pair_with,
            commands::approve_pair_request,
            commands::decline_pair_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Replace the currently-registered global hotkey with one parsed from `combo`.
pub fn install_global_hotkey(
    app: &AppHandle,
    current: &Mutex<Option<Shortcut>>,
    combo: &str,
) -> AppResult<()> {
    let mut guard = current.lock();
    if let Some(old) = guard.take() {
        let _ = app.global_shortcut().unregister(old);
    }

    let combo = combo.trim();
    if combo.is_empty() {
        log::info!("global hotkey cleared");
        return Ok(());
    }

    let shortcut = Shortcut::from_str(combo)
        .map_err(|e| crate::error::AppError::Invalid(format!("hotkey {combo:?}: {e}")))?;

    app.global_shortcut()
        .on_shortcut(shortcut, |app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                let _ = app.emit(tray::EVT_OPEN_NEW, ());
            }
        })
        .map_err(|e| crate::error::AppError::Invalid(format!("register {combo:?}: {e}")))?;

    log::info!("global hotkey installed: {combo}");
    *guard = Some(shortcut);
    Ok(())
}
