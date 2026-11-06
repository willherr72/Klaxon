//! Shared mutations used by the UI and authenticated agent sessions.
use crate::{
    db::{self, reminders, task_steps, thoughts},
    error::{AppError, AppResult},
    models::*,
    AppState,
};
use rusqlite::Connection;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    CreateReminder {
        input: ReminderCreate,
    },
    UpdateReminder {
        id: String,
        patch: ReminderUpdate,
    },
    CompleteReminder {
        id: String,
    },
    SnoozeReminder {
        id: String,
        snooze_until_ms: i64,
    },
    PlaceTask {
        id: String,
        lane_id: String,
        before_id: Option<String>,
        after_id: Option<String>,
    },
    CreateThought {
        input: ThoughtCreate,
    },
    UpdateThought {
        id: String,
        patch: ThoughtUpdate,
    },
    SetDayNote {
        day: String,
        body: String,
    },
    AddStep {
        task_id: String,
        title: String,
    },
    UpdateStep {
        id: String,
        title: Option<String>,
        completed: Option<bool>,
    },
    MoveStep {
        id: String,
        before_id: Option<String>,
    },
    DeleteStep {
        id: String,
    },
}
fn lane(conn: &Connection, id: Option<&str>) -> AppResult<()> {
    if let Some(id) = id {
        if db::task_lanes::get_by_id(conn, id)?.is_none() {
            return Err(AppError::NotFound(format!("lane {id}")));
        }
    }
    Ok(())
}
fn recurrence(rule: Option<&RepeatRule>) -> AppResult<()> {
    let valid = match rule {
        Some(RepeatRule::Interval { every_seconds }) => *every_seconds >= 60,
        Some(RepeatRule::Weekly { weekdays }) => {
            !weekdays.is_empty() && weekdays.iter().all(|d| *d <= 6)
        }
        Some(RepeatRule::Monthly { day }) => (1..=31).contains(day),
        _ => true,
    };
    if !valid {
        return Err(AppError::Invalid(
            "Invalid recurrence: interval >=60 seconds, weekdays 0–6, monthly day 1–31".into(),
        ));
    }
    Ok(())
}
pub fn apply(conn: &Connection, action: Mutation) -> AppResult<(Value, Option<String>)> {
    let mut cancel = None;
    let value = match action {
        Mutation::CreateReminder { input } => {
            lane(conn, input.task_lane_id.as_deref())?;
            recurrence(input.repeat_rule.as_ref())?;
            serde_json::to_value(reminders::create(conn, input)?)?
        }
        Mutation::UpdateReminder { id, patch } => {
            lane(conn, patch.task_lane_id.as_ref().and_then(|x| x.as_deref()))?;
            recurrence(patch.repeat_rule.as_ref().and_then(|r| r.as_ref()))?;
            if patch.title.as_ref().is_some_and(|t| t.trim().is_empty()) {
                return Err(AppError::Invalid("Title cannot be empty".into()));
            }
            serde_json::to_value(reminders::update(conn, &id, patch)?)?
        }
        Mutation::CompleteReminder { id } => {
            let r = reminders::set_state(conn, &id, ReminderState::Completed, None)?;
            cancel = Some(id);
            serde_json::to_value(r)?
        }
        Mutation::SnoozeReminder {
            id,
            snooze_until_ms,
        } => {
            if snooze_until_ms <= now_ms() {
                return Err(AppError::Invalid(
                    "Snooze time must be in the future".into(),
                ));
            }
            let r = reminders::set_state(conn, &id, ReminderState::Snoozed, Some(snooze_until_ms))?;
            cancel = Some(id);
            serde_json::to_value(r)?
        }
        Mutation::PlaceTask {
            id,
            lane_id,
            before_id,
            after_id,
        } => {
            lane(conn, Some(&lane_id))?;
            serde_json::to_value(reminders::place(
                conn,
                &id,
                &lane_id,
                before_id.as_deref(),
                after_id.as_deref(),
            )?)?
        }
        Mutation::CreateThought { input } => serde_json::to_value(thoughts::create(conn, input)?)?,
        Mutation::UpdateThought { id, patch } => {
            serde_json::to_value(thoughts::update(conn, &id, patch)?)?
        }
        Mutation::SetDayNote { day, body } => {
            let parsed = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")
                .map_err(|_| AppError::Invalid("Use a YYYY-MM-DD date".into()))?;
            if parsed.format("%Y-%m-%d").to_string() != day {
                return Err(AppError::Invalid("Use a YYYY-MM-DD date".into()));
            }
            serde_json::to_value(db::day_notes::set(conn, &day, &body)?)?
        }
        Mutation::AddStep { task_id, title } => {
            serde_json::to_value(task_steps::add(conn, &task_id, &title)?)?
        }
        Mutation::UpdateStep {
            id,
            title,
            completed,
        } => serde_json::to_value(task_steps::update(conn, &id, title.as_deref(), completed)?)?,
        Mutation::MoveStep { id, before_id } => {
            serde_json::to_value(task_steps::place(conn, &id, before_id.as_deref())?)?
        }
        Mutation::DeleteStep { id } => {
            task_steps::delete(conn, &id)?;
            Value::Null
        }
    };
    Ok((value, cancel))
}
pub fn effects(app: &AppHandle, state: &AppState, cancel: Option<&str>) {
    if let Some(id) = cancel {
        crate::alerts::cancel_alert(app, id);
    }
    let _ = state
        .scheduler_tx
        .send(crate::scheduler::SchedulerMsg::Reload);
    for event in [
        "klaxon://reminders-changed",
        "klaxon://thoughts-changed",
        "klaxon://day-notes-changed",
    ] {
        let _ = app.emit(event, ());
    }
    let _ = state.sync_nudge.send(crate::sync::trigger::Nudge::Write);
}
pub fn from_ui<T: DeserializeOwned>(
    state: &AppState,
    app: &AppHandle,
    action: Mutation,
) -> AppResult<T> {
    let (value, cancel) = {
        let conn = state.db.lock();
        let tx = conn.unchecked_transaction()?;
        let result = apply(&tx, action)?;
        tx.commit()?;
        result
    };
    effects(app, state, cancel.as_deref());
    Ok(serde_json::from_value(value)?)
}
