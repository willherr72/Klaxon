//! Background scheduler. Wakes for the next due reminder, dispatches alerts,
//! and reloads on demand via channel pokes from command handlers.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::Connection;
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Instant;

use crate::alerts;
use crate::db::reminders as repo;
use crate::models::{now_ms, Reminder, ReminderState};
use crate::recurrence;

#[derive(Debug)]
pub enum SchedulerMsg {
    Reload,
    Shutdown,
}

pub async fn run(
    db: Arc<Mutex<Connection>>,
    app: AppHandle,
    mut rx: UnboundedReceiver<SchedulerMsg>,
) {
    log::info!("scheduler online");

    loop {
        let next = {
            let conn = db.lock();
            match repo::next_pending(&conn) {
                Ok(r) => r,
                Err(e) => {
                    log::error!("scheduler db error: {e}");
                    None
                }
            }
        };

        let sleep_target = next.as_ref().map(target_ms_for);
        let now = now_ms();

        match sleep_target {
            None => match rx.recv().await {
                Some(SchedulerMsg::Shutdown) | None => break,
                Some(SchedulerMsg::Reload) => continue,
            },
            Some(target) => {
                let delay_ms = (target - now).max(0) as u64;
                let deadline = Instant::now() + Duration::from_millis(delay_ms);

                tokio::select! {
                    _ = tokio::time::sleep_until(deadline) => {
                        if let Some(r) = next {
                            on_fire(&db, &app, r);
                        }
                    }
                    msg = rx.recv() => {
                        match msg {
                            Some(SchedulerMsg::Shutdown) | None => break,
                            Some(SchedulerMsg::Reload) => continue,
                        }
                    }
                }
            }
        }
    }

    log::info!("scheduler offline");
}

fn on_fire(db: &Arc<Mutex<Connection>>, app: &AppHandle, r: Reminder) {
    alerts::dispatch(app, &r);

    {
        let conn = db.lock();
        if let Some(rule) = &r.repeat_rule {
            match recurrence::next_after(rule, r.due_at, now_ms()) {
                Some(next_due) => {
                    if let Err(e) = repo::reschedule(&conn, &r.id, next_due) {
                        log::error!("reschedule failed for {}: {e}", r.id);
                    }
                }
                None => {
                    log::info!("recurrence exhausted for {}", r.id);
                    let _ = repo::set_state(&conn, &r.id, ReminderState::Fired, None);
                }
            }
        } else {
            let _ = repo::set_state(&conn, &r.id, ReminderState::Fired, None);
        }
    }

    // Tell the frontend to re-fetch so the list / countdown reflect the
    // state change (Fired) or the rescheduled due_at for a recurring item.
    crate::sync::task::emit_reminders_changed(app);
}

fn target_ms_for(r: &Reminder) -> i64 {
    r.snooze_until.unwrap_or(r.due_at)
}
