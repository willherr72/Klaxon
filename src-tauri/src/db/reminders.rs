use rusqlite::{params, Connection, Row};

use crate::error::{AppError, AppResult};
use crate::models::{
    now_ms, Priority, Reminder, ReminderCreate, ReminderState, ReminderUpdate, RepeatRule,
};

fn row_to_reminder(row: &Row<'_>) -> rusqlite::Result<Reminder> {
    let repeat_rule_json: Option<String> = row.get("repeat_rule")?;
    let repeat_rule = repeat_rule_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<RepeatRule>(s).ok());
    let state_str: String = row.get("state")?;
    let state = ReminderState::from_str(&state_str).unwrap_or(ReminderState::Pending);
    let priority_int: i32 = row.get("priority")?;
    let dirty_int: i32 = row.get("dirty")?;

    Ok(Reminder {
        id: row.get("id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        due_at: row.get("due_at")?,
        priority: Priority::from_int(priority_int),
        sound_path: row.get("sound_path")?,
        repeat_rule,
        state,
        snooze_until: row.get("snooze_until")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        source: row.get("source")?,
        external_id: row.get("external_id")?,
        last_synced_at: row.get("last_synced_at")?,
        dirty: dirty_int != 0,
    })
}

pub fn list_all(conn: &Connection) -> AppResult<Vec<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty
         FROM reminders
         ORDER BY due_at ASC",
    )?;
    let rows = stmt.query_map([], row_to_reminder)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

pub fn next_pending(conn: &Connection) -> AppResult<Option<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty
         FROM reminders
         WHERE state IN ('pending', 'snoozed')
         ORDER BY COALESCE(snooze_until, due_at) ASC
         LIMIT 1",
    )?;
    let mut rows = stmt.query_map([], row_to_reminder)?;
    Ok(rows.next().transpose()?)
}

pub fn create(conn: &Connection, input: ReminderCreate) -> AppResult<Reminder> {
    if input.title.trim().is_empty() {
        return Err(AppError::Invalid("title cannot be empty".into()));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    let repeat_json = match &input.repeat_rule {
        Some(r) => Some(serde_json::to_string(r)?),
        None => None,
    };

    conn.execute(
        "INSERT INTO reminders
         (id, title, description, due_at, priority, sound_path, repeat_rule, state,
          snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', NULL, ?8, ?8, 'local', NULL, NULL, 1)",
        params![
            id,
            input.title.trim(),
            input.description.as_ref().map(|s| s.trim().to_string()),
            input.due_at,
            input.priority.as_int(),
            input.sound_path,
            repeat_json,
            now,
        ],
    )?;

    get_by_id(conn, &id)
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Reminder> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty
         FROM reminders WHERE id = ?1",
    )?;
    let r = stmt
        .query_row(params![id], row_to_reminder)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                AppError::NotFound(format!("reminder {id}"))
            }
            other => other.into(),
        })?;
    Ok(r)
}

pub fn update(conn: &Connection, id: &str, patch: ReminderUpdate) -> AppResult<Reminder> {
    let existing = get_by_id(conn, id)?;
    let title = patch.title.unwrap_or(existing.title);
    let description = match patch.description {
        Some(s) => Some(s),
        None => existing.description,
    };
    let due_at = patch.due_at.unwrap_or(existing.due_at);
    let priority = patch.priority.unwrap_or(existing.priority);
    let sound_path = match patch.sound_path {
        Some(v) => v,
        None => existing.sound_path,
    };
    let repeat_rule = match patch.repeat_rule {
        Some(v) => v,
        None => existing.repeat_rule,
    };
    let repeat_json = match &repeat_rule {
        Some(r) => Some(serde_json::to_string(r)?),
        None => None,
    };
    let now = now_ms();

    conn.execute(
        "UPDATE reminders
         SET title = ?2, description = ?3, due_at = ?4, priority = ?5,
             sound_path = ?6, repeat_rule = ?7, updated_at = ?8, dirty = 1
         WHERE id = ?1",
        params![
            id,
            title.trim(),
            description.as_ref().map(|s| s.trim().to_string()),
            due_at,
            priority.as_int(),
            sound_path,
            repeat_json,
            now,
        ],
    )?;

    get_by_id(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM reminders WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("reminder {id}")));
    }
    Ok(())
}

pub fn set_state(
    conn: &Connection,
    id: &str,
    state: ReminderState,
    snooze_until: Option<i64>,
) -> AppResult<Reminder> {
    let now = now_ms();
    let n = conn.execute(
        "UPDATE reminders
         SET state = ?2, snooze_until = ?3, updated_at = ?4, dirty = 1
         WHERE id = ?1",
        params![id, state.as_str(), snooze_until, now],
    )?;
    if n == 0 {
        return Err(AppError::NotFound(format!("reminder {id}")));
    }
    get_by_id(conn, id)
}

pub fn reschedule(conn: &Connection, id: &str, new_due_at: i64) -> AppResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE reminders
         SET due_at = ?2, state = 'pending', snooze_until = NULL, updated_at = ?3, dirty = 1
         WHERE id = ?1",
        params![id, new_due_at, now],
    )?;
    Ok(())
}
