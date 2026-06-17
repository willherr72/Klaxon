use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::models::{
    normalize_tags, now_ms, Priority, Reminder, ReminderCreate, ReminderState, ReminderUpdate,
    RepeatRule,
};
use crate::sync::types::RemoteReminder;

fn row_to_reminder(row: &Row<'_>) -> rusqlite::Result<Reminder> {
    let repeat_rule_json: Option<String> = row.get("repeat_rule")?;
    let repeat_rule = repeat_rule_json
        .as_deref()
        .and_then(|s| serde_json::from_str::<RepeatRule>(s).ok());
    let state_str: String = row.get("state")?;
    let state = ReminderState::from_str(&state_str).unwrap_or(ReminderState::Pending);
    let priority_int: i32 = row.get("priority")?;
    let dirty_int: i32 = row.get("dirty")?;
    let silent_int: i32 = row.get("silent")?;
    let tags_json: String = row.get("tags").unwrap_or_else(|_| "[]".to_string());
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

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
        silent: silent_int != 0,
        tags,
        task_lane_id: row.get("task_lane_id")?,
    })
}


pub fn list_all(conn: &Connection) -> AppResult<Vec<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id
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
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id
         FROM reminders
         WHERE state IN ('pending', 'snoozed') AND silent = 0
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

    let tags = normalize_tags(input.tags);
    let tags_json = serde_json::to_string(&tags)?;

    // Silent reminders (tasks) must land in a lane. Use the explicit
    // input lane if given, otherwise the default. Non-silent reminders
    // never get a lane.
    let lane_id = if input.silent {
        match input.task_lane_id.as_deref() {
            Some(s) if !s.trim().is_empty() => Some(s.to_string()),
            _ => Some(
                super::task_lanes::default_lane(conn)
                    .map(|l| l.id)
                    .unwrap_or_else(|_| super::task_lanes::DEFAULT_LANE_ID.to_string()),
            ),
        }
    } else {
        None
    };

    conn.execute(
        "INSERT INTO reminders
         (id, title, description, due_at, priority, sound_path, repeat_rule, state,
          snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', NULL, ?8, ?8, 'local', NULL, NULL, 1, ?9, ?10, ?11)",
        params![
            id,
            input.title.trim(),
            input.description.as_ref().map(|s| s.trim().to_string()),
            input.due_at,
            input.priority.as_int(),
            input.sound_path,
            repeat_json,
            now,
            input.silent as i32,
            tags_json,
            lane_id,
        ],
    )?;

    get_by_id(conn, &id)
}

pub fn get_by_id(conn: &Connection, id: &str) -> AppResult<Reminder> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id
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
    let silent = patch.silent.unwrap_or(existing.silent);
    let tags = match patch.tags {
        Some(t) => normalize_tags(t),
        None => existing.tags.clone(),
    };
    let tags_json = serde_json::to_string(&tags)?;
    // Lane is patchable via DnD on the TasksBoard. Non-silent reminders
    // are forced back to `None` even if a lane was set.
    //
    // Invariant: a `silent` reminder must always live in a lane, or it
    // disappears — the Tasks board buckets strictly by lane id, and the
    // Reminders list hides silent rows. Converting a reminder to a task
    // sends `task_lane_id: null`, which serde collapses from
    // `Option<Option<_>>` into the outer `None` (indistinguishable from an
    // omitted field), so we resolve chosen-or-existing and then fall back
    // to the default lane whenever that leaves us laneless.
    let task_lane_id = if silent {
        let chosen = match patch.task_lane_id {
            Some(v) => v,
            None => existing.task_lane_id.clone(),
        };
        Some(chosen.unwrap_or_else(|| crate::db::task_lanes::DEFAULT_LANE_ID.to_string()))
    } else {
        None
    };
    let now = now_ms();

    // If the user moved the due time, treat the edit as a manual reschedule:
    // reset state to Pending and clear any stale snooze so the scheduler will
    // ring it again at the new time. Without this, a reminder that's already
    // Fired / Dismissed / Snoozed stays in that state and the scheduler's
    // `next_pending` query (state IN pending|snoozed) ignores the new due_at.
    // Title-only or priority-only edits leave state untouched.
    let due_changed = patch.due_at.is_some() && due_at != existing.due_at;
    let (new_state, new_snooze) = if due_changed {
        (ReminderState::Pending, None::<i64>)
    } else {
        (existing.state, existing.snooze_until)
    };

    conn.execute(
        "UPDATE reminders
         SET title = ?2, description = ?3, due_at = ?4, priority = ?5,
             sound_path = ?6, repeat_rule = ?7, updated_at = ?8, dirty = 1,
             silent = ?9, state = ?10, snooze_until = ?11, tags = ?12,
             task_lane_id = ?13
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
            silent as i32,
            new_state.as_str(),
            new_snooze,
            tags_json,
            task_lane_id,
        ],
    )?;

    get_by_id(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let n = conn.execute("DELETE FROM reminders WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(AppError::NotFound(format!("reminder {id}")));
    }
    super::tombstones::create(conn, id, now_ms())?;
    Ok(())
}

/// Reminders updated after `since_ms`. Used by sync push to find changes to send.
pub fn updated_since(conn: &Connection, since_ms: i64) -> AppResult<Vec<Reminder>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, description, due_at, priority, sound_path, repeat_rule, state,
                snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id
         FROM reminders WHERE updated_at > ?1 ORDER BY updated_at ASC",
    )?;
    let rows = stmt.query_map(params![since_ms], row_to_reminder)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Apply a reminder received from a peer using last-write-wins on `updated_at`.
/// Skips when a local row or tombstone is at least as recent.
pub fn apply_remote(conn: &Connection, r: &RemoteReminder) -> AppResult<bool> {
    let local_updated: Option<i64> = conn
        .query_row(
            "SELECT updated_at FROM reminders WHERE id = ?1",
            params![r.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(local) = local_updated {
        if local >= r.updated_at {
            return Ok(false);
        }
    }

    let tomb_at: Option<i64> = conn
        .query_row(
            "SELECT deleted_at FROM tombstones WHERE id = ?1",
            params![r.id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(tomb_at) = tomb_at {
        if tomb_at >= r.updated_at {
            return Ok(false);
        }
    }

    let repeat_json = match &r.repeat_rule {
        Some(rule) => Some(serde_json::to_string(rule)?),
        None => None,
    };
    let tags = normalize_tags(r.tags.clone());
    let tags_json = serde_json::to_string(&tags)?;

    conn.execute(
        "INSERT INTO reminders
         (id, title, description, due_at, priority, sound_path, repeat_rule, state,
          snooze_until, created_at, updated_at, source, external_id, last_synced_at, dirty, silent, tags, task_lane_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'remote', NULL, ?12, 0, ?13, ?14, ?15)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           due_at = excluded.due_at,
           priority = excluded.priority,
           sound_path = excluded.sound_path,
           repeat_rule = excluded.repeat_rule,
           state = excluded.state,
           snooze_until = excluded.snooze_until,
           updated_at = excluded.updated_at,
           last_synced_at = excluded.last_synced_at,
           dirty = 0,
           silent = excluded.silent,
           tags = excluded.tags,
           task_lane_id = excluded.task_lane_id",
        params![
            r.id,
            r.title,
            r.description,
            r.due_at,
            r.priority.as_int(),
            r.sound_path,
            repeat_json,
            r.state.as_str(),
            r.snooze_until,
            r.created_at,
            r.updated_at,
            now_ms(),
            r.silent as i32,
            tags_json,
            r.task_lane_id,
        ],
    )?;
    Ok(true)
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

#[cfg(test)]
mod tests {
    use super::{create, update};
    use crate::models::{Priority, ReminderCreate, ReminderUpdate};

    fn test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn blank_update() -> ReminderUpdate {
        ReminderUpdate {
            title: None,
            description: None,
            due_at: None,
            priority: None,
            sound_path: None,
            repeat_rule: None,
            silent: None,
            tags: None,
            task_lane_id: None,
        }
    }

    /// Regression for the "reminder → task vanishes" bug. Converting a
    /// reminder to a task without choosing a lane must not orphan it: the
    /// frontend sends `task_lane_id: null`, which serde collapses from
    /// `Option<Option<_>>` into the outer `None` (indistinguishable from an
    /// omitted field). `update` must still guarantee a lane for a now-silent
    /// reminder — a laneless silent reminder is invisible in both the
    /// Reminders list and the Tasks board.
    #[test]
    fn converting_reminder_to_task_without_a_lane_assigns_default() {
        let conn = test_conn();
        let created = create(
            &conn,
            ReminderCreate {
                title: "Buy milk".into(),
                description: None,
                due_at: 1_000,
                priority: Priority::Normal,
                sound_path: None,
                repeat_rule: None,
                silent: false,
                tags: vec![],
                task_lane_id: None,
            },
        )
        .unwrap();
        assert!(!created.silent);
        assert_eq!(created.task_lane_id, None);

        let updated = update(
            &conn,
            &created.id,
            ReminderUpdate {
                silent: Some(true),
                ..blank_update()
            },
        )
        .unwrap();

        assert!(updated.silent);
        assert_eq!(
            updated.task_lane_id.as_deref(),
            Some(crate::db::task_lanes::DEFAULT_LANE_ID),
            "a silent task must always have a lane"
        );
    }
}
