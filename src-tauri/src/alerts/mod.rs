//! Alert dispatch and lifecycle.
//!
//! Three priority tiers:
//!   Low    → native toast (fire-and-forget)
//!   Normal → corner popup window with repeating audio
//!   High   → fullscreen window with escalating audio
//!
//! Alerts repeat their audio burst up to `repeat_count_*` times every
//! `repeat_interval_secs_*` seconds. Cancellation comes from
//! dismiss / snooze / complete commands via `cancel_alert`.

#[cfg(desktop)]
mod fullscreen;
#[cfg(desktop)]
mod popup;
mod toast;

use std::sync::atomic::Ordering;
#[cfg(desktop)]
use std::sync::atomic::AtomicBool;
#[cfg(desktop)]
use std::sync::Arc;
#[cfg(desktop)]
use std::time::Duration;

#[cfg(desktop)]
use parking_lot::Mutex;
#[cfg(desktop)]
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use crate::audio::{AudioCmd, TonePattern};
#[cfg(desktop)]
use crate::db::settings as cfg;
#[cfg(desktop)]
use crate::models::Priority;
use crate::models::Reminder;
use crate::AppState;

pub fn dispatch(app: &AppHandle, r: &Reminder) {
    log::info!("FIRE [{:?}] {} — {}", r.priority, r.title, r.id);
    #[cfg(desktop)]
    {
        match r.priority {
            Priority::Low => toast::show(app, r),
            Priority::Normal => popup::spawn(app, r),
            Priority::High => fullscreen::spawn(app, r),
        }
    }
    // Mobile path: the OS-level scheduler (AlarmManager via
    // tauri-plugin-notification's `Schedule.at`) handles the actual
    // notification post — see src/lib/mobile-scheduler.ts. Dispatch
    // here is a no-op so we don't double-notify when the app happens
    // to be in the foreground at fire time. The scheduler still ticks
    // for state transitions (Fired) and recurrence rescheduling.
    #[cfg(not(desktop))]
    {
        let _ = (app, r);
    }
}

/// Build an alert window label from a reminder id.
pub fn label_for(id: &str) -> String {
    format!("alert-{id}")
}

/// Start a tokio task that plays the user-chosen tone for this priority,
/// waits the configured interval, replays — until `repeat_count` is hit or
/// the cancel flag flips. Desktop-only because the audio engine is.
#[cfg(desktop)]
pub fn start_repeating_audio(app: &AppHandle, r: &Reminder) {
    let state = app.state::<AppState>();
    let cancel = Arc::new(AtomicBool::new(false));
    state.active_alerts.lock().insert(r.id.clone(), cancel.clone());

    let id = r.id.clone();
    let priority = r.priority;
    let audio_tx = state.audio_tx.clone();
    let db = state.db.clone();

    tauri::async_runtime::spawn(async move {
        let (count, interval_ms) = read_repeat_settings(&db, priority);
        let tone = read_tone(&db, priority);

        for i in 0..count {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let _ = audio_tx.send(AudioCmd::Play {
                id: id.clone(),
                tone,
            });

            if i + 1 >= count || interval_ms == 0 {
                continue;
            }
            let mut waited = 0u64;
            while waited < interval_ms {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
                waited += 250;
            }
        }
    });
}

/// Look up the user's chosen tone for a given priority, falling back to a
/// sensible per-priority default. Desktop-only — tone selection only
/// applies to the in-process audio engine.
#[cfg(desktop)]
pub fn read_tone(db: &Arc<Mutex<Connection>>, priority: Priority) -> TonePattern {
    let (key, default) = match priority {
        Priority::Low => ("tone_low", TonePattern::Chime),
        Priority::Normal => ("tone_normal", TonePattern::Klaxon),
        Priority::High => ("tone_high", TonePattern::Siren),
    };
    let conn = db.lock();
    cfg::get(&conn, key)
        .ok()
        .flatten()
        .map(|s| TonePattern::from_str_or_default(&s))
        .unwrap_or(default)
}

/// Stop audio + close the alert window for a given reminder. Safe to call
/// even if no alert is currently active.
pub fn cancel_alert(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    if let Some(cancel) = state.active_alerts.lock().remove(id) {
        cancel.store(true, Ordering::Relaxed);
    }
    #[cfg(desktop)]
    let _ = state.audio_tx.send(AudioCmd::Stop { id: id.to_string() });
    if let Some(w) = app.get_webview_window(&label_for(id)) {
        let _ = w.close();
    }
}

#[cfg(desktop)]
fn read_repeat_settings(
    db: &Arc<Mutex<Connection>>,
    priority: Priority,
) -> (u32, u64) {
    let conn = db.lock();
    let (k_count, k_int, default_count, default_int) = match priority {
        Priority::Low => ("repeat_count_low", "repeat_interval_secs_low", 1u32, 0u64),
        Priority::Normal => (
            "repeat_count_normal",
            "repeat_interval_secs_normal",
            5,
            8,
        ),
        Priority::High => (
            "repeat_count_high",
            "repeat_interval_secs_high",
            30,
            4,
        ),
    };
    let count = cfg::get(&conn, k_count)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(default_count);
    let interval = cfg::get(&conn, k_int)
        .ok()
        .flatten()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(default_int);
    (count, interval * 1000)
}
