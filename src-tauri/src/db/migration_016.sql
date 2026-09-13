-- Revisions represent when a change became available HERE, never wall time.
CREATE TABLE sync_epoch (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch TEXT NOT NULL);
INSERT INTO sync_epoch VALUES (1, lower(hex(randomblob(16))));
CREATE TABLE sync_journal (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    UNIQUE(kind, entity_id)
);
CREATE TABLE sync_peer_cursors (
    peer_id TEXT PRIMARY KEY REFERENCES peers(id) ON DELETE CASCADE,
    pull_epoch TEXT,
    pull_revision INTEGER,
    push_epoch TEXT,
    push_revision INTEGER
);

INSERT INTO sync_journal(kind,entity_id) SELECT 'reminder',id FROM reminders;
CREATE TRIGGER sync_reminders_insert AFTER INSERT ON reminders
BEGIN
    DELETE FROM sync_journal WHERE kind='reminder' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('reminder',NEW.id);
END;
CREATE TRIGGER sync_reminders_update AFTER UPDATE ON reminders
WHEN NEW.id IS NOT OLD.id OR NEW.title IS NOT OLD.title OR NEW.description IS NOT OLD.description OR NEW.due_at IS NOT OLD.due_at OR NEW.priority IS NOT OLD.priority OR NEW.sound_path IS NOT OLD.sound_path OR NEW.repeat_rule IS NOT OLD.repeat_rule OR NEW.state IS NOT OLD.state OR NEW.snooze_until IS NOT OLD.snooze_until OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.silent IS NOT OLD.silent OR NEW.tags IS NOT OLD.tags OR NEW.task_lane_id IS NOT OLD.task_lane_id OR NEW.task_sort_key IS NOT OLD.task_sort_key
BEGIN
    DELETE FROM sync_journal WHERE kind='reminder' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('reminder',NEW.id);
END;

INSERT INTO sync_journal(kind,entity_id) SELECT 'thought',id FROM thoughts;
CREATE TRIGGER sync_thoughts_insert AFTER INSERT ON thoughts
BEGIN
    DELETE FROM sync_journal WHERE kind='thought' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('thought',NEW.id);
END;
CREATE TRIGGER sync_thoughts_update AFTER UPDATE ON thoughts
WHEN NEW.id IS NOT OLD.id OR NEW.body IS NOT OLD.body OR NEW.tags IS NOT OLD.tags OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
    DELETE FROM sync_journal WHERE kind='thought' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('thought',NEW.id);
END;

INSERT INTO sync_journal(kind,entity_id) SELECT 'lane',id FROM task_lanes;
CREATE TRIGGER sync_task_lanes_insert AFTER INSERT ON task_lanes
BEGIN
    DELETE FROM sync_journal WHERE kind='lane' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('lane',NEW.id);
END;
CREATE TRIGGER sync_task_lanes_update AFTER UPDATE ON task_lanes
WHEN NEW.id IS NOT OLD.id OR NEW.name IS NOT OLD.name OR NEW.order_index IS NOT OLD.order_index OR NEW.is_default IS NOT OLD.is_default OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
    DELETE FROM sync_journal WHERE kind='lane' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('lane',NEW.id);
END;

INSERT INTO sync_journal(kind,entity_id) SELECT 'day_note',day FROM day_notes;
CREATE TRIGGER sync_day_notes_insert AFTER INSERT ON day_notes
BEGIN
    DELETE FROM sync_journal WHERE kind='day_note' AND entity_id=NEW.day;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('day_note',NEW.day);
END;
CREATE TRIGGER sync_day_notes_update AFTER UPDATE ON day_notes
WHEN NEW.day IS NOT OLD.day OR NEW.body IS NOT OLD.body OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at
BEGIN
    DELETE FROM sync_journal WHERE kind='day_note' AND entity_id=NEW.day;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('day_note',NEW.day);
END;

INSERT INTO sync_journal(kind,entity_id) SELECT 'tombstone',id FROM tombstones;
CREATE TRIGGER sync_tombstones_insert AFTER INSERT ON tombstones
BEGIN
    DELETE FROM sync_journal WHERE kind='tombstone' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('tombstone',NEW.id);
END;
CREATE TRIGGER sync_tombstones_update AFTER UPDATE ON tombstones
WHEN NEW.id IS NOT OLD.id OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
    DELETE FROM sync_journal WHERE kind='tombstone' AND entity_id=NEW.id;
    INSERT INTO sync_journal(kind,entity_id) VALUES ('tombstone',NEW.id);
END;
