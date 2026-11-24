"""Exercise the v1 schema and read-only domain projection using disposable data."""
import hashlib
import re
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path

DB_SOURCE = Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "db"


def schema_scripts():
    # Extract the three string forms in the append-only Rust migration list.
    source = (DB_SOURCE / "migrations.rs").read_text(encoding="utf-8")
    migration_list = source.split("const MIGRATIONS: &[&str] = &[", 1)[1].split("\n];", 1)[0]
    migration_list = re.sub(r"(?m)^\s*//[^\n]*", "", migration_list)
    expression = r'\s*(?:r#"(.*?)"#|include_str!\("([^"]+)"\)|"([^"]+)")\s*,'
    scripts = []
    offset = 0
    while migration_list[offset:].strip():
        item = re.compile(expression, re.DOTALL).match(migration_list, offset)
        if not item:
            raise ValueError("Unrecognized migration expression")
        raw_sql, filename, sql = item.groups()
        scripts.append((DB_SOURCE / filename).read_text(encoding="utf-8") if filename else raw_sql or sql)
        offset = item.end()
    assert len(scripts) == 17, "Review exported fields when the schema changes"
    return scripts


def seed_fixture(path):
    with closing(sqlite3.connect(path)) as db:
        db.execute("CREATE TABLE schema_version(version INTEGER PRIMARY KEY)")
        for version, sql in enumerate(schema_scripts(), start=1):
            db.executescript(f"BEGIN;{sql}; INSERT INTO schema_version VALUES({version}); COMMIT;")
        db.executescript("""
            INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent,task_lane_id)
            SELECT 't','task',0,2,'completed',1,2,1,id FROM task_lanes WHERE is_default=1;
            INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,repeat_rule)
            VALUES ('r','alarm',100,1,'pending',1,2,'{"kind":"daily"}');
            INSERT INTO task_steps VALUES ('s','t','step',1,10,1,2);
            INSERT INTO thoughts(id,body,tags,created_at,updated_at) VALUES ('c','capture','[]',1,2);
            INSERT INTO day_notes VALUES ('2026-11-23','note',1,2);
        """)


def verify_projection(path):
    before = hashlib.sha256(path.read_bytes()).digest()
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert db.execute("SELECT max(version) FROM schema_version").fetchone() == (17,)
        assert db.execute("""
            SELECT r.id, r.state, s.id, s.completed, l.is_default
            FROM reminders r JOIN task_steps s ON s.task_id=r.id
            JOIN task_lanes l ON l.id=r.task_lane_id WHERE r.silent=1
        """).fetchall() == [("t", "completed", "s", 1, 1)]
        assert db.execute("SELECT repeat_rule FROM reminders WHERE silent=0").fetchall() == [('{"kind":"daily"}',)]
        assert db.execute("SELECT body FROM thoughts").fetchall() == [("capture",)]
        assert db.execute("SELECT day FROM day_notes").fetchall() == [("2026-11-23",)]
    assert hashlib.sha256(path.read_bytes()).digest() == before


def check_snapshot_recovery(directory):
    """Exercise snapshot reads while a synthetic device has live WAL pages."""
    source = directory / "active.db"
    snapshot = directory / "snapshot.db"
    seed_fixture(source)
    with closing(sqlite3.connect(source)) as writer:
        assert writer.execute("PRAGMA journal_mode=WAL").fetchone() == ("wal",)
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("UPDATE task_steps SET title='committed title' WHERE id='s'")
        writer.commit()
        writer.execute("UPDATE task_steps SET title='interrupted edit' WHERE id='s'")
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as reader:
            with closing(sqlite3.connect(snapshot)) as target:
                reader.backup(target)
        # Closing the writer without committing simulates an interrupted edit.
    verify_projection(snapshot)
    for path in (source, snapshot):
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as reader:
            assert reader.execute("SELECT title FROM task_steps WHERE id='s'").fetchone() == ("committed title",)

    # A partial copy must fail validation, and retry from the intact snapshot
    # must still succeed. Only truncate a new disposable copy.
    partial = directory / "partial.db"
    partial.write_bytes(snapshot.read_bytes()[:512])
    try:
        verify_projection(partial)
    except sqlite3.DatabaseError:
        pass
    else:
        raise AssertionError("Truncated snapshot unexpectedly passed validation")
    verify_projection(snapshot)


if __name__ == "__main__":
    if not __debug__:
        raise SystemExit("Run this probe with Python assertions enabled")
    with tempfile.TemporaryDirectory() as tmp:
        fixture = Path(tmp) / "synthetic.db"
        seed_fixture(fixture)
        verify_projection(fixture)
        check_snapshot_recovery(Path(tmp))
    print("Schema 17 projection, live WAL snapshot, interrupted edit, truncated copy and retry passed")
