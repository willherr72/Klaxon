"""Exercise the CLI against temporary databases built with the real v1 migrations."""

import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "spikes" / "migration"))
from probe import seed_fixture

CLI = Path(__file__).with_name("export_legacy.py")
DEFAULT_LANE = "00000000-0000-4000-8000-000000000001"


class ExportTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.out = self.root / "export"

    def fixture(self, name):
        path = self.root / f"{name}.sqlite"
        seed_fixture(path)
        with closing(sqlite3.connect(path)) as db, db:
            db.execute(
                "UPDATE task_lanes SET created_at=1, updated_at=2 WHERE id=?", (DEFAULT_LANE,)
            )
        return path

    def cli(self, *args, ok=True):
        result = subprocess.run(
            [sys.executable, "-B", str(CLI), *map(str, args)],
            capture_output=True, text=True, encoding="utf-8", timeout=20,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def export(self, *sources, out=None, ok=True):
        return self.cli("export", "--output", out or self.out, *(
            arg for origin, path in sources for arg in ("--source", f"{origin}={path}")
        ), ok=ok)

    def read(self, name="projection", out=None):
        return json.loads(((out or self.out) / f"{name}.json").read_bytes())

    def records(self, kind):
        return {record["legacyId"]: record for record in self.read()["records"][kind]}

    def test_wal_and_field_projection(self):
        source = self.fixture("synthetic source?#") if sys.platform != "win32" else self.fixture("synthetic source #")
        with closing(sqlite3.connect(source)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA wal_autocheckpoint=0")
            db.executescript("""
                UPDATE reminders SET task_sort_key=100.0000000001, due_at=1795449600000 WHERE id='t';
                UPDATE reminders SET task_sort_key=100.0 WHERE id='u';
                UPDATE task_steps SET title='committed' WHERE id='s';
                UPDATE reminders SET state='snoozed', snooze_until=200,
                  repeat_rule='{"kind":"monthly","day":31}', sound_path='device-only-path',
                  source='provider', external_id='external-attribution' WHERE id='r';
                INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,repeat_rule)
                VALUES ('weekly','weekly',0,0,'fired',1,2,'{"kind":"weekly","weekdays":[0,6]}'),
                  ('interval','interval',100,1,'dismissed',1,2,'{"kind":"interval","every_seconds":60}'),
                  ('daily','daily',100,2,'completed',1,2,'{"kind":"daily"}');
                INSERT INTO day_notes VALUES ('2024-02-29','',1,2);
                UPDATE day_notes SET body='mañana 日本語' WHERE day='2026-11-23';
                INSERT INTO settings VALUES ('list_sort_order','date_asc'), ('secret-key','secret-value');
                INSERT INTO peers(id,name,shared_secret,created_at) VALUES ('peer-id','peer-name','pair-secret',1);
            """)
            db.execute("BEGIN")
            db.execute("UPDATE task_steps SET title='uncommitted' WHERE id='s'")
            wal = Path(f"{source}-wal")
            before = source.read_bytes(), wal.read_bytes()
            self.export(("alpha", source))
            self.assertEqual((source.read_bytes(), wal.read_bytes()), before)
        tasks = self.records("tasks")
        self.assertEqual(tasks["t"]["rank"], 100.0000000001)
        self.assertEqual(tasks["t"]["dueAt"], 1795449600000)
        self.assertNotIn("dueAt", tasks["u"])
        self.assertEqual(tasks["u"]["lanePublicId"], self.records("lanes")["work"]["publicId"])
        steps = self.records("steps")
        self.assertEqual(steps["s"]["title"], "committed")
        self.assertEqual(steps["s"]["taskPublicId"], tasks["t"]["publicId"])
        self.assertEqual(list(steps), ["s2", "s"])
        reminders = self.records("reminders")
        self.assertEqual(reminders["r"]["recurrence"], {"kind": "monthly", "day": 31})
        self.assertEqual(reminders["r"]["recurrenceBasis"], "legacy_utc")
        self.assertEqual(reminders["r"]["snoozeUntil"], 200)
        self.assertEqual(reminders["r"]["attribution"], {"source": "provider", "externalId": "external-attribution"})
        self.assertEqual(reminders["weekly"]["dueAt"], 0)
        self.assertEqual(reminders["weekly"]["recurrence"]["weekdays"], [0, 6])
        self.assertEqual(reminders["interval"]["recurrence"]["everySeconds"], 60)
        self.assertEqual(reminders["daily"]["state"], "completed")
        self.assertEqual(self.records("dayNotes")["2024-02-29"]["body"], "")
        self.assertEqual(self.records("dayNotes")["2026-11-23"]["body"], "mañana 日本語")
        self.assertEqual(self.records("captures")["c"]["body"], "capture")
        self.assertIn("list_sort_order", self.read()["preferences"])
        for name in ("manifest", "projection", "report"):
            data = (self.out / f"{name}.json").read_text(encoding="utf-8")
            for forbidden in ("peer-id", "peer-name", "pair-secret", "secret-key", "secret-value", "device-only-path", str(source)):
                self.assertNotIn(forbidden, data)
        codes = {issue["code"] for issue in self.read("report")["issues"]}
        self.assertTrue({"task_date_intent_unknown", "device_local_sound", "unknown_settings"} <= codes)

    def test_multi_source_reconciliation_and_stable_tie_order(self):
        alpha = self.fixture("alpha")
        beta = self.fixture("beta")
        for path in (alpha, beta):
            with closing(sqlite3.connect(path)) as db:
                db.executescript("""
                    INSERT INTO task_lanes VALUES ('z','Z',2,0,1,2);
                    INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent,task_lane_id,task_sort_key)
                    VALUES ('ordered','ordered',0,1,'pending',1,2,1,'work',100.0),
                           ('childless','childless',0,1,'pending',1,2,1,'work',99.9999999999);
                    UPDATE reminders SET task_sort_key=100.0 WHERE id='u';
                """)
        with closing(sqlite3.connect(alpha)) as db:
            db.executescript("""
                INSERT INTO tombstones VALUES ('r',2), ('s',1), ('untyped',10), ('c',3);
                UPDATE reminders SET title='alpha title' WHERE id='u';
            """)
        with closing(sqlite3.connect(beta)) as db:
            db.executescript("""
                UPDATE reminders SET silent=0,task_lane_id=NULL,updated_at=3 WHERE id='t';
                UPDATE reminders SET title='newest',updated_at=4 WHERE id='u';
                UPDATE reminders SET updated_at=4 WHERE id='ordered';
                UPDATE thoughts SET updated_at=4 WHERE id='c';
                UPDATE day_notes SET body='parallel edit' WHERE day='2026-11-23';
                UPDATE task_lanes SET is_default=1,updated_at=3 WHERE id='z';
            """)
        self.export(("beta", beta), ("alpha", alpha))
        first = {file.name: file.read_bytes() for file in self.out.glob("*.json")}
        reversed_out = self.root / "reversed"
        self.export(("alpha", alpha), ("beta", beta), out=reversed_out)
        self.assertEqual(first, {file.name: file.read_bytes() for file in reversed_out.glob("*.json")})
        self.assertEqual(list(self.records("tasks")), ["childless", "ordered", "u"])
        self.assertEqual(self.records("tasks")["u"]["title"], "newest")
        self.assertNotIn("t", self.records("reminders"))
        self.assertNotIn("r", self.records("reminders"))
        self.assertFalse(self.records("steps"))
        self.assertFalse(self.records("dayNotes"))
        self.assertIn("c", self.records("captures"))
        self.assertEqual(sum(lane["isDefault"] for lane in self.records("lanes").values()), 1)
        report = self.read("report")
        codes = {issue["code"] for issue in report["issues"]}
        self.assertTrue({"silent_kind_conflict", "equal_timestamp_conflict", "task_order_tie", "lane_order_tie", "default_lane_repaired"} <= codes)
        self.assertTrue(any(
            item["legacyId"] == "u" and len(item["candidates"]) == 2 and item["winnerSha256"]
            for item in report["divergences"]
        ))
        self.assertEqual(
            {item["legacyId"]: item["outcome"] for item in self.read()["tombstones"]},
            {"c": "surviving_version", "r": "deleted", "s": "deleted", "untyped": "no_observed_entity"},
        )

    def test_quarantines_invalid_rows_and_does_not_revive_stale_candidate(self):
        alpha = self.fixture("alpha")
        beta = self.fixture("beta")
        with closing(sqlite3.connect(beta)) as db:
            db.executescript("""
                UPDATE reminders SET tags='[broken', updated_at=3 WHERE id='t';
                INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,repeat_rule)
                VALUES ('invalid-state','oops',4,3,'other',1,2,'{"kind":"lunar"}'),
                       ('invalid-rule','oops',4,0,'pending',1,2,'{"kind":"lunar"}'),
                       ('invalid-snooze','oops',4,0,'snoozed',1,2,NULL);
                INSERT INTO reminders(id,title,due_at,priority,state,created_at,updated_at,silent)
                VALUES ('invalid-lane','oops',0,1,'pending',1,2,1),
                       ('dangling-lane','oops',0,1,'pending',1,2,1);
                UPDATE reminders SET task_lane_id='absent' WHERE id='dangling-lane';
                INSERT INTO task_steps VALUES ('orphan','absent','orphan',0,1,1,2),
                  ('not-task','r','orphan',0,1,1,2);
                INSERT INTO day_notes VALUES ('2023-02-29','bad day',1,2);
            """)
        self.export(("alpha", alpha), ("beta", beta))
        self.assertEqual(set(self.records("tasks")), {"u"})
        self.assertEqual(set(self.records("reminders")), {"r"})
        self.assertFalse(self.records("steps"))
        issues = self.read("report")["issues"]
        codes = {issue["code"] for issue in issues}
        self.assertTrue({"invalid_tags", "invalid_state", "invalid_priority", "invalid_recurrence", "invalid_snooze", "missing_lane", "missing_task_parent", "invalid_local_date", "invalid_competing_version"} <= codes)
        self.assertTrue(any(issue.get("raw") == '{"kind":"lunar"}' for issue in issues))

    def test_manifest_checksums_idempotence_resume_and_conflict(self):
        source = self.fixture("source")
        self.export(("alpha", source))
        manifest_path = self.out / "manifest.json"
        projection_path = self.out / "projection.json"
        report_path = self.out / "report.json"
        files = (manifest_path, projection_path, report_path)
        original = [(path.read_bytes(), path.stat().st_mtime_ns) for path in files]
        manifest = self.read("manifest")
        self.assertEqual(manifest["status"], "complete")
        self.assertRegex(manifest["sources"]["alpha"]["sha256"], "^[a-f0-9]{64}$")
        for path in (projection_path, report_path):
            self.assertEqual(manifest["artifacts"][path.name], hashlib.sha256(path.read_bytes()).hexdigest())
        self.cli("verify", "--output", self.out)
        self.export(("alpha", source))
        self.assertEqual([(path.read_bytes(), path.stat().st_mtime_ns) for path in files], original)

        manifest["status"] = "writing"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        report_path.unlink()
        self.cli("verify", "--output", self.out, ok=False)
        self.export(("alpha", source))
        self.assertEqual([path.read_bytes() for path in files], [data for data, _ in original])

        projection_path.write_bytes(b"corrupt")
        self.cli("verify", "--output", self.out, ok=False)
        self.assertIn("checksum", self.export(("alpha", source), ok=False).stderr)
        self.assertEqual(projection_path.read_bytes(), b"corrupt")
        projection_path.write_bytes(original[1][0])
        with closing(sqlite3.connect(source)) as db, db:
            db.execute("UPDATE reminders SET title='changed', updated_at=3 WHERE id='t'")
        self.assertIn("source projections differ", self.export(("alpha", source), ok=False).stderr)
        self.assertEqual([path.read_bytes() for path in files], [data for data, _ in original])

    def test_untyped_tombstone_collision_and_partial_order_evidence(self):
        alpha = self.fixture("alpha")
        beta = self.fixture("beta")
        for path, order in ((alpha, ("a", "b")), (beta, ("b", "a"))):
            with closing(sqlite3.connect(path)) as db, db:
                db.executemany("INSERT INTO task_lanes VALUES (?, ?, 3, 0, 1, 2)",
                               [(lane, lane) for lane in order])
                db.execute("INSERT INTO thoughts VALUES ('r','capture with reminder ID','[]',1,4)")
                db.execute("INSERT INTO settings VALUES ('unreviewed','excluded')")
        with closing(sqlite3.connect(alpha)) as db, db:
            db.execute("INSERT INTO tombstones VALUES ('r',2), ('t',2), ('2026-11-23',4)")
        self.export(("beta", beta), ("alpha", alpha))
        self.assertEqual(list(self.records("lanes")), [DEFAULT_LANE, "work", "a", "b"])
        self.assertNotIn("r", self.records("captures"))
        self.assertNotIn("r", self.records("reminders"))
        self.assertNotIn("t", self.records("tasks"))
        self.assertFalse(self.records("steps"))
        self.assertIn("2026-11-23", self.records("dayNotes"))
        projection = self.read()
        self.assertNotEqual(projection["observedOrder"]["alpha"]["lanes"],
                            projection["observedOrder"]["beta"]["lanes"])
        self.assertEqual(projection["tombstones"][0]["outcome"], "no_observed_entity")
        issues = self.read("report")["issues"]
        self.assertTrue(any(i["code"] == "ambiguous_tombstone_kind" and i["legacyId"] == "r" for i in issues))
        self.assertTrue(any(i["code"] == "lane_order_tie" and i["unresolved"] for i in issues))

        other = self.root / "renamed-origin"
        self.export(("new-label", alpha), out=other)
        self.assertEqual(self.read("manifest")["sources"]["alpha"]["sha256"],
                         self.read("manifest", other)["sources"]["new-label"]["sha256"])
        other_lanes = {r["legacyId"]: r["publicId"] for r in self.read(out=other)["records"]["lanes"]}
        self.assertEqual({key: value["publicId"] for key, value in self.records("lanes").items()}, other_lanes)

    def test_fails_closed_on_schema_mismatch_and_missing_inputs(self):
        source = self.fixture("source")
        with closing(sqlite3.connect(source)) as db, db:
            db.execute("INSERT INTO schema_version VALUES (18)")
        self.assertIn("schema version", self.export(("alpha", source), ok=False).stderr)
        self.assertFalse((self.out / "manifest.json").exists())
        missing = self.root / "absent.sqlite"
        self.export(("alpha", missing), ok=False)
        self.assertFalse(missing.exists())
        corrupt = self.root / "incomplete.sqlite"
        corrupt.write_bytes(source.read_bytes()[:512])
        self.export(("alpha", corrupt), ok=False)
        self.assertFalse((self.out / "manifest.json").exists())
        self.export(("alpha", source), ("alpha", corrupt), ok=False)


if __name__ == "__main__":
    unittest.main()
