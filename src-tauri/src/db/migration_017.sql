CREATE TABLE task_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    sort_key INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX task_steps_parent ON task_steps(task_id, sort_key, id);
CREATE TRIGGER task_steps_parent_delete AFTER DELETE ON reminders
BEGIN
    DELETE FROM task_steps WHERE task_id=OLD.id;
END;
CREATE TRIGGER sync_step_insert AFTER INSERT ON task_steps
BEGIN
    DELETE FROM sync_journal WHERE kind='step' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('step',NEW.id);
END;
CREATE TRIGGER sync_step_update AFTER UPDATE ON task_steps
WHEN NEW.title IS NOT OLD.title OR NEW.completed IS NOT OLD.completed OR NEW.sort_key IS NOT OLD.sort_key OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
    DELETE FROM sync_journal WHERE kind='step' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('step',NEW.id);
END;

-- Local agent receipts provide retry safety and a visible activity history.
CREATE TABLE agent_receipts (
    client_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(client_id, operation_id)
);
