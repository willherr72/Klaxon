"""Read and validate the portable domain fields from one Klaxon v1 snapshot."""

import hashlib
import json
import math
import re
import sqlite3
import sys
import time
import uuid
from collections import Counter
from contextlib import closing
from dataclasses import dataclass
from datetime import date

SCHEMA_VERSION = 17
DEFAULT_LANE_ID = "00000000-0000-4000-8000-000000000001"
PUBLIC_ID_NAMESPACE = uuid.UUID("524cd2e5-2d3e-45a0-ada3-acd15f5c24b8")
KINDS = ("lanes", "tasks", "steps", "reminders", "captures", "dayNotes")
STATES = {"pending", "fired", "snoozed", "dismissed", "completed"}
PRIORITIES = ("low", "normal", "high")
MAX_SAFE_INTEGER = 2**53 - 1
MAX_INSTANT = 8_640_000_000_000_000
MISSING_TASK_RANK = sys.float_info.max
SETTINGS = {"list_sort_order": {"date_asc", "date_desc"}}
SURROGATE = re.compile(r"[\ud800-\udfff]")


class MigrationError(Exception):
    """A bounded diagnostic safe to display on the command line."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def public_id(kind, legacy_id):
    return str(uuid.uuid5(PUBLIC_ID_NAMESPACE, f"{kind}:{legacy_id}"))


def issue(issues, code, *, severity="review", **details):
    issues.append({"code": code, "severity": severity, **details})


def valid_id(value):
    return isinstance(value, str) and 0 < len(value) <= 256 and all(ord(c) >= 32 for c in value)


def valid_integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def safe_sqlite_value(value):
    # Preserve distinctions in fingerprints without exporting arbitrary BLOBs.
    if isinstance(value, bytes):
        return {"blobSha256": sha256(value)}
    if isinstance(value, float) and not math.isfinite(value):
        return {"nonfinite": str(value)}
    return value


def decode_text(value):
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return value


def strict_json(value):
    def object_pairs(pairs):
        obj = dict(pairs)
        if len(obj) != len(pairs):
            raise ValueError("duplicate JSON key")
        return obj

    def invalid_constant(_):
        raise ValueError("invalid JSON constant")

    if isinstance(value, str):
        try:
            return json.loads(value, object_pairs_hook=object_pairs, parse_constant=invalid_constant)
        except (ValueError, RecursionError):
            return None
    return None


def recurrence(value):
    rule = strict_json(value)
    if not isinstance(rule, dict):
        return None
    kind = rule.get("kind")
    if kind == "daily" and rule.keys() == {"kind"}:
        return rule
    if kind == "weekly" and rule.keys() == {"kind", "weekdays"}:
        weekdays = rule["weekdays"]
        if isinstance(weekdays, list) and weekdays and all(valid_integer(d, 0, 6) for d in weekdays):
            return rule
    if kind == "monthly" and rule.keys() == {"kind", "day"} and valid_integer(rule["day"], 1, 31):
        return rule
    # The v1 scheduler accepts any positive interval, including older values below 60.
    if (kind == "interval" and rule.keys() == {"kind", "every_seconds"}
            and valid_integer(rule["every_seconds"], 1, MAX_SAFE_INTEGER)):
        return {"kind": "interval", "everySeconds": rule["every_seconds"]}
    return None


def task_order_key(record):
    return (record.get("rank", MISSING_TASK_RANK), -record["updatedAt"],
            record.get("dueAt", 0), record["legacyId"])


@dataclass(frozen=True)
class Candidate:
    origin: str
    kind: str
    legacy_id: str
    updated_at: int | None
    row_sha256: str
    record: dict | None


@dataclass(frozen=True)
class Snapshot:
    origin: str
    sha256: str
    counts: dict
    states: dict
    candidates: list
    tombstones: dict
    preferences: dict
    order: dict
    issues: list


class Row:
    def __init__(self, raw, kind, legacy_id, origin, issues):
        self.raw = raw
        self.details = {"kind": kind, "legacyId": legacy_id, "origin": origin}
        self.issues = issues
        self.valid = True

    def reject(self, code, column, *, include_raw=False):
        self.valid = False
        details = {**self.details, "field": column}
        value = self.raw[column]
        if include_raw and isinstance(value, str):
            details["raw"] = value[:256]
            if len(value) > 256:
                details["rawTruncated"] = True
                details["rawSha256"] = sha256(value.encode("utf-8"))
        elif include_raw:
            details["raw"] = safe_sqlite_value(value)
        issue(self.issues, code, severity="quarantine", **details)

    def review(self, code, **details):
        issue(self.issues, code, **self.details, **details)

    def integer(self, column, minimum=-MAX_SAFE_INTEGER, maximum=MAX_SAFE_INTEGER):
        value = self.raw[column]
        if valid_integer(value, minimum, maximum):
            return value
        self.reject("invalid_integer", column)
        return None

    def instant(self, column):
        return self.integer(column, -MAX_INSTANT, MAX_INSTANT)

    def flag(self, column):
        return self.integer(column, 0, 1) == 1

    def text(self, column):
        value = self.raw[column]
        if isinstance(value, str):
            return value
        self.reject("invalid_text", column)
        return None

    def tags(self):
        tags = strict_json(self.raw["tags"])
        if isinstance(tags, list) and all(isinstance(tag, str) and not SURROGATE.search(tag) for tag in tags):
            return tags
        self.reject("invalid_tags", "tags", include_raw=True)
        return None


def project_reminder(row, record, kind, lane_ids):
    raw = row.raw
    record.update(title=row.text("title"), tags=row.tags())
    if raw["description"] is not None:
        record["description"] = row.text("description")
    priority = raw["priority"]
    if valid_integer(priority, 0, 2):
        record["priority"] = PRIORITIES[priority]
    else:
        row.reject("invalid_priority", "priority", include_raw=True)
    if raw["state"] in STATES:
        record["state"] = raw["state"]
    else:
        row.reject("invalid_state", "state", include_raw=True)
    due_at = row.instant("due_at")
    record["attribution"] = {"source": row.text("source")}
    if raw["external_id"] is not None:
        record["attribution"]["externalId"] = row.text("external_id")
    if raw["repeat_rule"] is not None:
        rule = recurrence(raw["repeat_rule"])
        if rule is None:
            row.reject("invalid_recurrence", "repeat_rule", include_raw=True)
        else:
            record.update(recurrence=rule, recurrenceBasis="legacy_utc")
    snooze_until = raw["snooze_until"]
    if valid_integer(snooze_until, -MAX_INSTANT, MAX_INSTANT):
        record["snoozeUntil"] = snooze_until
        if raw["state"] != "snoozed":
            row.review("snooze_state_mismatch")
    elif snooze_until is not None or raw["state"] == "snoozed":
        row.reject("invalid_snooze", "snooze_until", include_raw=True)
    if raw["has_sound"]:
        row.review("device_local_sound")

    if kind == "reminders":
        record["dueAt"] = due_at
        return

    if due_at is not None and due_at != 0:
        record["dueAt"] = due_at
        row.review("task_date_intent_unknown", dueAt=due_at)
    if raw["repeat_rule"] is not None or raw["snooze_until"] is not None or raw["state"] in {"fired", "snoozed", "dismissed"}:
        row.review("silent_task_schedule_metadata")
    lane_id = raw["task_lane_id"]
    if lane_id in lane_ids:
        record["lanePublicId"] = public_id("lanes", lane_id)
    else:
        row.reject("missing_lane", "task_lane_id", include_raw=True)
    rank = raw["task_sort_key"]
    if rank is None:
        row.review("missing_task_rank")
    elif type(rank) in (int, float) and math.isfinite(rank):
        record["rank"] = rank
    else:
        row.reject("invalid_rank", "task_sort_key", include_raw=True)


TABLE_QUERIES = (
    ("lanes", "SELECT id,name,order_index,is_default,created_at,updated_at FROM task_lanes "
              "ORDER BY order_index,created_at"),
    ("reminders", "SELECT id,title,description,due_at,priority,sound_path IS NOT NULL AS has_sound,"
                  "repeat_rule,state,snooze_until,created_at,updated_at,source,external_id,silent,"
                  "tags,task_lane_id,task_sort_key FROM reminders ORDER BY due_at,id"),
    ("steps", "SELECT id,task_id,title,completed,sort_key,created_at,updated_at FROM task_steps "
              "ORDER BY task_id,sort_key,id"),
    ("captures", "SELECT id,body,tags,created_at,updated_at FROM thoughts ORDER BY id"),
    ("dayNotes", "SELECT day AS id,body,created_at,updated_at FROM day_notes ORDER BY day"),
    ("tombstones", "SELECT id,deleted_at FROM tombstones ORDER BY id"),
)


def extract(db, origin):
    versions = [row[0] for row in db.execute("SELECT version FROM schema_version ORDER BY version")]
    if not versions or versions[-1] != SCHEMA_VERSION:
        raise MigrationError(f"{origin}: unsupported schema version (expected {SCHEMA_VERSION})")
    if db.execute("PRAGMA integrity_check(1)").fetchone()[0] != "ok":
        raise MigrationError(f"{origin}: snapshot failed SQLite integrity check")

    tables = {kind: [dict(row) for row in db.execute(sql)] for kind, sql in TABLE_QUERIES}
    lane_ids = {row["id"] for row in tables["lanes"] if valid_id(row["id"])}
    task_ids = {row["id"] for row in tables["reminders"] if row["silent"] == 1 and valid_id(row["id"])}
    candidates, issues, tombstones, preferences = [], [], {}, {}
    counts = dict.fromkeys((*KINDS, "tombstones", "unknownReminder"), 0)
    states = {kind: Counter() for kind in ("tasks", "reminders")}
    fingerprint = hashlib.sha256()

    for table_kind, rows in tables.items():
        for raw in rows:
            row_bytes = canonical({key: safe_sqlite_value(value) for key, value in raw.items()})
            fingerprint.update(table_kind.encode("ascii") + b"\0" + row_bytes + b"\n")
            kind = table_kind
            if table_kind == "reminders":
                kind = {0: "reminders", 1: "tasks"}.get(raw["silent"], "unknownReminder")
                if kind in states:
                    state = raw["state"] if raw["state"] in STATES else "invalid"
                    states[kind][state] += 1
            counts[kind] += 1
            legacy_id = raw["id"]
            if not valid_id(legacy_id):
                issue(issues, "invalid_id", severity="quarantine", kind=kind, origin=origin,
                      rowSha256=sha256(row_bytes))
                continue
            row = Row(raw, kind, legacy_id, origin, issues)
            if kind == "tombstones":
                deleted_at = row.instant("deleted_at")
                tombstones[legacy_id] = deleted_at
                continue

            updated_at = row.instant("updated_at")
            record = {"legacyId": legacy_id, "publicId": public_id(kind, legacy_id),
                      "createdAt": row.instant("created_at"), "updatedAt": updated_at}
            if kind == "unknownReminder":
                row.reject("invalid_silent", "silent", include_raw=True)
            elif kind in ("reminders", "tasks"):
                project_reminder(row, record, kind, lane_ids)
            elif kind == "lanes":
                record.update(name=row.text("name"), orderIndex=row.integer("order_index"),
                              isDefault=row.flag("is_default"))
            elif kind == "steps":
                record.update(title=row.text("title"), completed=row.flag("completed"),
                              rank=row.integer("sort_key"))
                task_id = raw["task_id"]
                if task_id in task_ids:
                    record["taskPublicId"] = public_id("tasks", task_id)
                else:
                    row.reject("missing_task_parent", "task_id", include_raw=True)
            elif kind == "captures":
                record.update(body=row.text("body"), tags=row.tags())
            elif kind == "dayNotes":
                try:
                    if date.fromisoformat(legacy_id).isoformat() != legacy_id:
                        raise ValueError
                except ValueError:
                    row.reject("invalid_local_date", "id")
                record.update(localDate=legacy_id, body=row.text("body"))
            candidates.append(Candidate(origin, kind, legacy_id, updated_at, sha256(row_bytes),
                                        record if row.valid else None))

    for key, accepted in SETTINGS.items():
        setting = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        if setting is None:
            continue
        if setting[0] in accepted:
            preferences[key] = setting[0]
        else:
            issue(issues, "invalid_setting", severity="quarantine", origin=origin, field=key)
    placeholders = ",".join("?" for _ in SETTINGS)
    unknown_count = db.execute(f"SELECT count(*) FROM settings WHERE key IS NULL OR key NOT IN ({placeholders})",
                               tuple(SETTINGS)).fetchone()[0]
    if unknown_count:
        issue(issues, "unknown_settings", origin=origin, count=unknown_count)
    settings_issues = [
        {key: value for key, value in item.items() if key != "origin"}
        for item in issues if item["code"] in {"invalid_setting", "unknown_settings"}
    ]
    fingerprint.update(canonical({"schemaVersion": SCHEMA_VERSION, "preferences": preferences,
                                 "settingsIssues": settings_issues}))
    order = observed_order(candidates)
    return Snapshot(origin, fingerprint.hexdigest(), counts, states, candidates, tombstones,
                    preferences, order, issues)


def observed_order(candidates):
    lanes, tasks, steps = [], {}, {}
    for candidate in candidates:
        record = candidate.record
        if record is None:
            continue
        if candidate.kind == "lanes":
            lanes.append(record["publicId"])
        elif candidate.kind == "tasks":
            tasks.setdefault(record["lanePublicId"], []).append(record)
        elif candidate.kind == "steps":
            steps.setdefault(record["taskPublicId"], []).append(record["publicId"])
    return {"lanes": lanes, "tasksByLane": {
        lane: [r["publicId"] for r in sorted(records, key=task_order_key)]
        for lane, records in tasks.items()
    }, "stepsByTask": steps}


def read_snapshot(path, origin):
    """Use SQLite's online backup so committed WAL frames are included."""
    deadline = time.monotonic() + 30

    def backup_progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            raise MigrationError(f"{origin}: SQLite backup timed out")

    try:
        with closing(sqlite3.connect(":memory:")) as snapshot:
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=2)) as source:
                source.backup(snapshot, pages=256, progress=backup_progress, sleep=0.05)
            snapshot.row_factory = sqlite3.Row
            snapshot.text_factory = decode_text
            snapshot.execute("PRAGMA query_only=ON")
            snapshot.execute("PRAGMA trusted_schema=OFF")
            return extract(snapshot, origin)
    except sqlite3.Error as error:
        name = getattr(error, "sqlite_errorname", "SQLITE_ERROR")
        raise MigrationError(f"{origin}: unreadable or incompatible SQLite source ({name})") from None
