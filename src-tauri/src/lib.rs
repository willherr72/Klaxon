mod alerts;
mod audio;
mod commands;
mod mobile_bg;
pub mod db;
pub mod error;
pub mod models;
mod nl;
mod recurrence;
mod scheduler;
pub mod sync;
#[cfg(desktop)]
mod tray;

use std::collections::HashMap;
#[cfg(desktop)]
use std::str::FromStr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use parking_lot::Mutex;
#[cfg(desktop)]
use tauri::AppHandle;
use tauri::{Emitter, Manager};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::db::settings as cfg;
#[cfg(desktop)]
use crate::error::AppResult;

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub scheduler_tx: tokio::sync::mpsc::UnboundedSender<scheduler::SchedulerMsg>,
    /// Desktop only — `rodio`/`cpal` panic on Android when initialized
    /// without a JNI context. Mobile alert sound goes through the
    /// notification plugin's native channel instead of our synth.
    #[cfg(desktop)]
    pub audio_tx: std::sync::mpsc::Sender<audio::AudioCmd>,
    pub active_alerts: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    #[cfg(desktop)]
    pub current_hotkey: Arc<Mutex<Option<Shortcut>>>,
    pub discovery: Arc<Mutex<Option<sync::discovery::DiscoveryHandle>>>,
    pub pending_pairs: sync::PendingPairs,
    /// v0.3 iroh transport. `None` until setup completes or if sync is
    /// disabled. Holds a cloneable `Endpoint` plus the device's stable
    /// EndpointId string.
    pub iroh_node: Arc<Mutex<Option<sync::iroh_node::IrohNode>>>,
    /// The iroh `Router` dispatching `klaxon/sync/0` (RPC) and
    /// `klaxon/pair/0` (pair handshake) to their handlers. Held here so
    /// it doesn't drop — Router aborts its accept loop when the last
    /// handle is gone.
    pub iroh_router: Arc<Mutex<Option<sync::iroh_node::Router>>>,
}

#[cfg(desktop)]
const DEFAULT_GLOBAL_HOTKEY: &str = "Ctrl+Alt+KeyN";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // iroh's per-packet `poll_send` and tracing-span events flood the
    // log at INFO — hundreds of lines per minute under steady state.
    // Knock them down to warn-or-higher while keeping our own crate
    // and other deps at the default info level.
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or(
            "info,iroh=warn,iroh_quinn=warn,iroh_relay=warn,iroh_dns=warn,\
             iroh_base=warn,iroh_metrics=warn,n0_future=warn,n0_watcher=warn,\
             tracing::span=error,\
             iroh::net_report=error,iroh::net_report::reportgen=error",
        ),
    )
    .init();

    // iroh's QUIC stack uses rustls under the hood and rustls 0.23
    // requires an explicit crypto provider before any TLS context spins
    // up. `let _ = ...` because the second call returns Err — fine.
    let _ = rustls::crypto::ring::default_provider().install_default();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    // Desktop-only plugins. Autostart/single-instance/global-shortcut all
    // assume a windowed desktop OS; on Android they wouldn't even compile.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }))
            .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    builder
        .on_window_event(|window, event| {
            // Desktop close-to-tray. On mobile the close path is owned
            // by the platform (back button / system-shelf swipe).
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(desktop))]
            {
                let _ = (window, event);
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
            #[cfg(desktop)]
            let audio_tx = audio::spawn_engine();
            #[cfg(desktop)]
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
            let pending_pairs: sync::PendingPairs =
                Arc::new(Mutex::new(HashMap::new()));
            let iroh_node_state: Arc<Mutex<Option<sync::iroh_node::IrohNode>>> =
                Arc::new(Mutex::new(None));
            let iroh_router_state: Arc<Mutex<Option<sync::iroh_node::Router>>> =
                Arc::new(Mutex::new(None));
            if sync::read_enabled(&db) {
                let identity = sync::read_identity(&db);

                // Spin up the iroh endpoint. `block_on` is OK here — bind
                // is a fast local socket op plus reading a 32-byte key
                // file. Failure here is fatal in v0.3 (no fallback);
                // we log and bail out of the sync subsystem but the rest
                // of the app keeps running.
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

                // Spawn the iroh Router that dispatches both
                // `klaxon/sync/0` (authed RPC: Ping/Pull/Push) and
                // `klaxon/pair/0` (pre-auth pair handshake) to the right
                // handler. `Router::spawn()` calls `tokio::spawn`
                // internally so it must run inside a runtime context;
                // hence the `block_on` wrap.
                if let Some(node) = &iroh_node_opt {
                    let sync_handler = sync::iroh_handler::SyncHandler {
                        db: db.clone(),
                        identity: identity.clone(),
                        app: Some(app.handle().clone()),
                    };
                    let pair_handler = sync::pair_handler::PairHandler {
                        db: db.clone(),
                        identity: identity.clone(),
                        pending_pairs: pending_pairs.clone(),
                        app: app.handle().clone(),
                        local_node_id: node.node_id.clone(),
                    };
                    let endpoint = node.endpoint.clone();
                    let router = tauri::async_runtime::block_on(async move {
                        sync::iroh_node::spawn_sync_router(endpoint, sync_handler, pair_handler)
                    });
                    *iroh_router_state.lock() = Some(router);
                    log::info!(
                        "iroh router attached: ALPNs {} + {}",
                        String::from_utf8_lossy(sync::proto::ALPN_SYNC),
                        String::from_utf8_lossy(sync::proto::ALPN_PAIR),
                    );
                }

                let node_id_for_mdns = iroh_node_opt.as_ref().map(|n| n.node_id.clone());
                match sync::discovery::start(identity, node_id_for_mdns) {
                    Ok(h) => *discovery_handle.lock() = Some(h),
                    Err(e) => log::warn!("mDNS discovery failed to start: {e}"),
                }
            }

            // Desktop-only: global hotkey + system tray. On mobile the OS
            // owns the equivalents (lockscreen widgets, quick settings
            // tiles) and we don't try to recreate them inside the app.
            #[cfg(desktop)]
            {
                let stored = {
                    let conn = db.lock();
                    cfg::get(&conn, "global_hotkey_new")
                        .ok()
                        .flatten()
                        .unwrap_or_else(|| DEFAULT_GLOBAL_HOTKEY.to_string())
                };
                if let Err(e) =
                    install_global_hotkey(&app.handle().clone(), &current_hotkey, &stored)
                {
                    log::warn!("could not register global hotkey {stored:?}: {e}");
                }
            }

            app.manage(AppState {
                db,
                scheduler_tx: tx,
                #[cfg(desktop)]
                audio_tx,
                active_alerts: Arc::new(Mutex::new(HashMap::new())),
                #[cfg(desktop)]
                current_hotkey,
                discovery: discovery_handle,
                pending_pairs,
                iroh_node: iroh_node_state,
                iroh_router: iroh_router_state,
            });

            #[cfg(desktop)]
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
            #[cfg(desktop)]
            commands::set_global_hotkey,
            #[cfg(desktop)]
            commands::preview_tone,
            commands::nl_parse,
            commands::list_peers,
            commands::add_peer,
            commands::remove_peer,
            commands::ping_peer,
            commands::device_identity,
            commands::generate_secret,
            commands::set_sync_enabled,
            commands::sync_now,
            commands::list_discovered_peers,
            commands::start_pair_with,
            commands::approve_pair_request,
            commands::decline_pair_request,
            commands::list_lanes,
            commands::create_lane,
            commands::rename_lane,
            commands::delete_lane,
            commands::reorder_lanes,
            commands::set_task_lane,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Replace the currently-registered global hotkey with one parsed from `combo`.
#[cfg(desktop)]
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
