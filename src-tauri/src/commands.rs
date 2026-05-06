use std::collections::HashMap;

use tauri::{AppHandle, State};

use crate::alerts;
use crate::db::{reminders as repo, settings as cfg};
use crate::error::AppResult;
use crate::models::{Reminder, ReminderCreate, ReminderState, ReminderUpdate};
use crate::scheduler::SchedulerMsg;
use crate::AppState;

#[tauri::command]
pub fn list_reminders(state: State<'_, AppState>) -> AppResult<Vec<Reminder>> {
    let conn = state.db.lock();
    repo::list_all(&conn)
}

#[tauri::command]
pub fn get_reminder(state: State<'_, AppState>, id: String) -> AppResult<Reminder> {
    let conn = state.db.lock();
    repo::get_by_id(&conn, &id)
}

#[tauri::command]
pub fn create_reminder(
    state: State<'_, AppState>,
    input: ReminderCreate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::create(&conn, input)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn update_reminder(
    state: State<'_, AppState>,
    id: String,
    patch: ReminderUpdate,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::update(&conn, &id, patch)?
    };
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn delete_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        repo::delete(&conn, &id)?;
    }
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(())
}

#[tauri::command]
pub fn snooze_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
    snooze_until_ms: i64,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::set_state(&conn, &id, ReminderState::Snoozed, Some(snooze_until_ms))?
    };
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn dismiss_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::set_state(&conn, &id, ReminderState::Dismissed, None)?
    };
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn complete_reminder(
    state: State<'_, AppState>,
    app: AppHandle,
    id: String,
) -> AppResult<Reminder> {
    let r = {
        let conn = state.db.lock();
        repo::set_state(&conn, &id, ReminderState::Completed, None)?
    };
    alerts::cancel_alert(&app, &id);
    let _ = state.scheduler_tx.send(SchedulerMsg::Reload);
    Ok(r)
}

#[tauri::command]
pub fn next_reminder(state: State<'_, AppState>) -> AppResult<Option<Reminder>> {
    let conn = state.db.lock();
    repo::next_pending(&conn)
}

#[tauri::command]
pub fn get_setting(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    let conn = state.db.lock();
    cfg::get(&conn, &key)
}

#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<()> {
    let conn = state.db.lock();
    cfg::set(&conn, &key, &value)
}

#[tauri::command]
pub fn list_settings(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    let conn = state.db.lock();
    cfg::list_all(&conn)
}

#[tauri::command]
pub fn data_dir(app: AppHandle) -> AppResult<String> {
    use tauri::Manager;
    let path = app.path().app_data_dir()?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn set_global_hotkey(
    state: State<'_, AppState>,
    app: AppHandle,
    combo: String,
) -> AppResult<()> {
    {
        let conn = state.db.lock();
        cfg::set(&conn, "global_hotkey_new", &combo)?;
    }
    crate::install_global_hotkey(&app, &state.current_hotkey, &combo)
}
