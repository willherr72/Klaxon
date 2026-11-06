//! Ordered task children. Parent deletion wins over delayed child edits.
use crate::{
    error::{AppError, AppResult},
    models::now_ms,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskStep {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub completed: bool,
    pub sort_key: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
pub(crate) fn row(r: &Row<'_>) -> rusqlite::Result<TaskStep> {
    Ok(TaskStep {
        id: r.get("id")?,
        task_id: r.get("task_id")?,
        title: r.get("title")?,
        completed: r.get("completed")?,
        sort_key: r.get("sort_key")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}
pub fn list(conn: &Connection, task_id: &str) -> AppResult<Vec<TaskStep>> {
    let mut stmt =
        conn.prepare("SELECT * FROM task_steps WHERE task_id=?1 ORDER BY sort_key,id")?;
    let rows = stmt
        .query_map([task_id], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn get(conn: &Connection, id: &str) -> AppResult<TaskStep> {
    conn.query_row("SELECT * FROM task_steps WHERE id=?1", [id], row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("step {id}")))
}
fn title(value: &str) -> AppResult<&str> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 500 {
        return Err(AppError::Invalid(
            "Step title must contain 1–500 characters".into(),
        ));
    }
    Ok(value)
}
fn parent(conn: &Connection, id: &str) -> AppResult<()> {
    let task = super::reminders::get_by_id(conn, id)?;
    if !task.silent {
        return Err(AppError::Invalid("Steps belong to tasks".into()));
    }
    Ok(())
}
pub fn add(conn: &Connection, task_id: &str, value: &str) -> AppResult<TaskStep> {
    parent(conn, task_id)?;
    let steps = list(conn, task_id)?;
    if steps.len() >= 200 {
        return Err(AppError::Invalid(
            "A task can have at most 200 steps".into(),
        ));
    }
    let now = now_ms();
    let step = TaskStep {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: task_id.into(),
        title: title(value)?.into(),
        completed: false,
        sort_key: steps.last().map_or(0, |s| s.sort_key.saturating_add(1)),
        created_at: now,
        updated_at: now,
    };
    store(conn, &step)?;
    Ok(step)
}
fn store(conn: &Connection, s: &TaskStep) -> AppResult<()> {
    conn.execute("INSERT INTO task_steps(id,task_id,title,completed,sort_key,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,completed=excluded.completed,sort_key=excluded.sort_key,updated_at=excluded.updated_at",
        params![s.id,s.task_id,s.title,s.completed,s.sort_key,s.created_at,s.updated_at])?;
    Ok(())
}
pub fn update(
    conn: &Connection,
    id: &str,
    value: Option<&str>,
    completed: Option<bool>,
) -> AppResult<TaskStep> {
    let mut step = get(conn, id)?;
    parent(conn, &step.task_id)?;
    if let Some(value) = value {
        step.title = title(value)?.into();
    }
    if let Some(completed) = completed {
        step.completed = completed;
    }
    step.updated_at = now_ms().max(step.updated_at.saturating_add(1));
    store(conn, &step)?;
    Ok(step)
}
pub fn place(conn: &Connection, id: &str, before_id: Option<&str>) -> AppResult<Vec<TaskStep>> {
    let step = get(conn, id)?;
    parent(conn, &step.task_id)?;
    let mut steps = list(conn, &step.task_id)?;
    if before_id == Some(id) {
        return Ok(steps);
    }
    steps.retain(|s| s.id != id);
    let index = match before_id {
        Some(before) => steps
            .iter()
            .position(|s| s.id == before)
            .ok_or_else(|| AppError::Invalid("Neighbor must belong to the same task".into()))?,
        None => steps.len(),
    };
    steps.insert(index, step);
    // SAVEPOINT also permits composition inside an agent's receipt transaction.
    conn.execute_batch("SAVEPOINT place_steps")?;
    let result = (|| {
        for (index, step) in steps.iter_mut().enumerate() {
            if step.sort_key != index as i64 {
                step.sort_key = index as i64;
                step.updated_at = now_ms().max(step.updated_at.saturating_add(1));
                store(conn, step)?;
            }
        }
        Ok(steps)
    })();
    if result.is_err() {
        conn.execute_batch("ROLLBACK TO place_steps")?;
    }
    conn.execute_batch("RELEASE place_steps")?;
    result
}
pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    let step = get(conn, id)?;
    super::tombstones::apply_remote(conn, id, now_ms().max(step.updated_at.saturating_add(1)))?;
    Ok(())
}
pub fn apply_remote(conn: &Connection, incoming: &TaskStep) -> AppResult<bool> {
    title(&incoming.title)?;
    let deleted: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM tombstones WHERE id=?1 OR (id=?2 AND NOT EXISTS(SELECT 1 FROM reminders WHERE id=?2)))", params![incoming.id,incoming.task_id], |r|r.get(0))?;
    if deleted {
        return Ok(false);
    }
    // Missing parents without tombstones are a malformed batch, not an accepted
    // change that can be lost permanently behind an acknowledged sync cursor.
    let _ = super::reminders::get_by_id(conn, &incoming.task_id)?;
    let old = conn
        .query_row("SELECT * FROM task_steps WHERE id=?1", [&incoming.id], row)
        .optional()?;
    if let Some(old) = old {
        if incoming.task_id != old.task_id {
            return Err(AppError::Invalid("Step parent is immutable".into()));
        }
        // Equal clocks resolve identically on every device, including reorder ties.
        if (
            incoming.updated_at,
            &incoming.title,
            incoming.completed,
            incoming.sort_key,
        ) <= (old.updated_at, &old.title, old.completed, old.sort_key)
        {
            return Ok(false);
        }
    }
    store(conn, incoming)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&c).unwrap();
        c.execute("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent) VALUES ('t','task',0,1,'pending',1,1,1)", []).unwrap();
        c
    }
    #[test]
    fn reorder_and_completion_preserve_stable_ids_and_parent() {
        let c = db();
        let a = add(&c, "t", "first").unwrap();
        let b = add(&c, "t", "second").unwrap();
        assert_eq!(place(&c, &b.id, Some(&a.id)).unwrap()[0].id, b.id);
        update(&c, &a.id, None, Some(true)).unwrap();
        assert_eq!(list(&c, "t").unwrap()[1].id, a.id);
        assert!(get(&c, &a.id).unwrap().completed);
        assert!(place(&c, &a.id, Some("missing")).is_err());
        assert_eq!(
            super::super::reminders::get_by_id(&c, "t").unwrap().state,
            crate::models::ReminderState::Pending
        );
    }
    #[test]
    fn deletion_suppresses_later_child_edits_and_replays() {
        let c = db();
        let mut a = add(&c, "t", "first").unwrap();
        super::super::tombstones::apply_remote(&c, "t", now_ms() + 1).unwrap();
        assert!(list(&c, "t").unwrap().is_empty());
        a.updated_at += 1000;
        assert!(!apply_remote(&c, &a).unwrap());
    }
    #[test]
    fn equal_clock_conflicts_converge() {
        let a = db();
        let b = db();
        let original = add(&a, "t", "first").unwrap();
        apply_remote(&b, &original).unwrap();
        let mut left = original.clone();
        left.title = "left".into();
        left.updated_at += 1;
        let mut right = left.clone();
        right.title = "right".into();
        apply_remote(&a, &left).unwrap();
        apply_remote(&b, &right).unwrap();
        apply_remote(&a, &right).unwrap();
        apply_remote(&b, &left).unwrap();
        assert_eq!(get(&a, &left.id).unwrap(), get(&b, &left.id).unwrap());
    }
}

#[cfg(test)]
mod sync_regressions {
    use super::*;
    #[test]
    fn child_delete_wins_over_a_concurrent_later_edit_on_both_peers() {
        let make = || {
            let c = Connection::open_in_memory().unwrap();
            crate::db::migrations::run(&c).unwrap();
            c.execute("INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent) VALUES ('t','task',0,1,'pending',1,1,1)",[]).unwrap();
            c
        };
        let a = make();
        let b = make();
        let mut s = add(&a, "t", "step").unwrap();
        apply_remote(&b, &s).unwrap();
        let deleted_at = s.updated_at + 1;
        s.updated_at += 100;
        apply_remote(&b, &s).unwrap();
        crate::db::tombstones::apply_remote(&a, &s.id, deleted_at).unwrap();
        assert!(!apply_remote(&a, &s).unwrap());
        crate::db::tombstones::apply_remote(&b, &s.id, deleted_at).unwrap();
        assert!(list(&a, "t").unwrap().is_empty());
        assert!(list(&b, "t").unwrap().is_empty());
    }
}
