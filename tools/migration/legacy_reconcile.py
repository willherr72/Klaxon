"""Reconcile explicitly named schema 17 projections and keep review evidence."""

from collections import Counter, defaultdict
from itertools import groupby

from legacy_source import (
    DEFAULT_LANE_ID, KINDS, MISSING_TASK_RANK, SCHEMA_VERSION, canonical, issue, sha256, task_order_key,
)

FORMAT_VERSION = 1


def envelope(name, **fields):
    return {"format": f"klaxon-legacy-{name}", "version": FORMAT_VERSION,
            "sourceSchemaVersion": SCHEMA_VERSION, **fields}


def describe_candidates(candidates):
    versions = {}
    for candidate in candidates:
        record = candidate.record
        if record is None:
            key = candidate.row_sha256
            variant = {"rowSha256": key, "updatedAt": candidate.updated_at}
        else:
            key = sha256(canonical(record))
            variant = {"sha256": key, "record": record}
        version = versions.setdefault(key, {**variant, "origins": []})
        version["origins"].append(candidate.origin)
    return [versions[key] for key in sorted(versions)]


def select_candidate(kind, legacy_id, candidates, tombstone, blocked, issues):
    if blocked or kind == "unknownReminder":
        return None, "ambiguous_identity"
    if tombstone is not None:
        if kind == "steps" and tombstone["deletedAt"] is not None:
            # v1 step IDs are never reused. A deletion beats even a newer edit.
            return None, "deleted"
        if tombstone["invalidOrigins"]:
            issue(issues, "invalid_competing_tombstone", severity="quarantine",
                  kind=kind, legacyId=legacy_id)
            return None, "unresolved_tombstone"
        deleted_at = tombstone["deletedAt"]
        candidates = [c for c in candidates if c.updated_at is None or c.updated_at > deleted_at]
        if not candidates:
            return None, "deleted"

    if any(c.updated_at is None for c in candidates):
        issue(issues, "invalid_competing_version", severity="quarantine", kind=kind, legacyId=legacy_id)
        return None, "unresolved_version"
    latest = max(c.updated_at for c in candidates)
    contenders = [c for c in candidates if c.updated_at == latest]
    if any(c.record is None for c in contenders):
        issue(issues, "invalid_competing_version", severity="quarantine", kind=kind, legacyId=legacy_id)
        return None, "unresolved_version"
    if len({canonical(c.record) for c in contenders}) > 1:
        issue(issues, "equal_timestamp_conflict", severity="quarantine", kind=kind,
              legacyId=legacy_id, updatedAt=latest, origins=[c.origin for c in contenders])
        return None, "unresolved_version"
    return contenders[0].record, "surviving_version"


def reconcile_entities(snapshots, issues):
    groups, deletion_origins = defaultdict(list), defaultdict(dict)
    kinds_by_id = defaultdict(set)
    for snapshot in snapshots:
        for candidate in snapshot.candidates:
            groups[candidate.kind, candidate.legacy_id].append(candidate)
            if candidate.kind != "dayNotes":
                kinds_by_id[candidate.legacy_id].add(candidate.kind)
        for legacy_id, deleted_at in snapshot.tombstones.items():
            deletion_origins[legacy_id][snapshot.origin] = deleted_at

    blocked, tombstones = set(), {}
    reminder_kinds = {"tasks", "reminders", "unknownReminder"}
    for legacy_id, kinds in sorted(kinds_by_id.items()):
        different_reminder_kinds = kinds & reminder_kinds
        if len(different_reminder_kinds) > 1:
            issue(issues, "silent_kind_conflict", severity="quarantine", legacyId=legacy_id,
                  kinds=sorted(different_reminder_kinds))
            blocked.update((kind, legacy_id) for kind in different_reminder_kinds)
    for legacy_id, origins in sorted(deletion_origins.items()):
        timestamps = [value for value in origins.values() if value is not None]
        kinds = kinds_by_id[legacy_id]
        outcome = "no_observed_entity"
        if len(kinds) > 1:
            issue(issues, "ambiguous_tombstone_kind", severity="quarantine", legacyId=legacy_id,
                  kinds=sorted(kinds))
            blocked.update((kind, legacy_id) for kind in kinds)
            outcome = "ambiguous_identity"
        tombstones[legacy_id] = {
            "legacyId": legacy_id, "deletedAt": max(timestamps, default=None),
            "observations": origins, "invalidOrigins": [o for o, v in origins.items() if v is None],
            "observedKinds": sorted(kinds), "outcome": outcome,
        }

    records = {kind: [] for kind in KINDS}
    divergences = []
    for (kind, legacy_id), candidates in sorted(groups.items()):
        tombstone = tombstones.get(legacy_id) if kind != "dayNotes" else None
        identity_blocked = (kind, legacy_id) in blocked
        winner, outcome = select_candidate(kind, legacy_id, candidates, tombstone, identity_blocked, issues)
        if tombstone is not None and not identity_blocked:
            tombstone["outcome"] = outcome
        if winner is not None:
            # Normalization after resolution can adjust a default flag without
            # altering the original version kept in the review evidence.
            records[kind].append(dict(winner))
        keep_evidence = tombstone is not None or winner is None
        variants = describe_candidates(candidates) if len(candidates) > 1 or keep_evidence else []
        if len(variants) > 1 or keep_evidence:
            divergences.append({"kind": kind, "legacyId": legacy_id, "candidates": variants,
                                "outcome": outcome,
                                "winnerSha256": sha256(canonical(winner)) if winner is not None else None})
    return records, list(tombstones.values()), divergences


def live_children(children, kind, parent_field, parents, issues):
    parent_ids = {record["publicId"] for record in parents}
    live = []
    for child in children:
        parent_id = child[parent_field]
        if parent_id in parent_ids:
            live.append(child)
        else:
            issue(issues, "unresolved_parent", severity="quarantine", kind=kind,
                  legacyId=child["legacyId"], parentPublicId=parent_id)
    return live


def order_lanes(lanes, snapshots, issues):
    positions = {s.origin: {public_id: index for index, public_id in enumerate(s.order["lanes"])}
                 for s in snapshots}

    def rank(lane):
        return lane["orderIndex"], lane["createdAt"]

    ordered = []
    for _, group in groupby(sorted(lanes, key=rank), key=rank):
        tied = list(group)
        if len(tied) == 1:
            ordered.extend(tied)
            continue
        by_id = {lane["publicId"]: lane for lane in tied}
        sequences = {
            origin: sorted((key for key in by_id if key in index), key=index.__getitem__)
            for origin, index in positions.items()
        }
        origin = min(sequences, key=lambda name: (-len(sequences[name]), name))
        chosen = sequences[origin]
        # Report contradictory relative order even when an origin saw only
        # part of the tie group.
        chosen_set = set(chosen)
        unresolved = len(chosen) != len(tied)
        for sequence in sequences.values():
            seen = set(sequence)
            if [key for key in sequence if key in chosen_set] != [key for key in chosen if key in seen]:
                unresolved = True
                break
        issue(issues, "lane_order_tie", kind="lanes", publicIds=list(by_id),
              preferredOrigin=origin, unresolved=unresolved)
        remainder = sorted((lane for lane in tied if lane["publicId"] not in chosen_set),
                           key=lambda lane: lane["legacyId"])
        ordered.extend(by_id[key] for key in chosen)
        ordered.extend(remainder)
    return ordered


def resolve_default(lanes, issues):
    if not lanes:
        issue(issues, "missing_default_lane", severity="quarantine", kind="lanes")
        return
    defaults = [lane for lane in lanes if lane["isDefault"]]
    if len(defaults) == 1:
        return
    choices = defaults or lanes
    chosen = next((lane for lane in choices if lane["legacyId"] == DEFAULT_LANE_ID), choices[0])
    issue(issues, "default_lane_repaired", kind="lanes", preferredPublicId=chosen["publicId"],
          previousDefaults=[lane["publicId"] for lane in defaults])
    for lane in lanes:
        lane["isDefault"] = lane is chosen


def ordered_records(records, snapshots, issues):
    lanes = order_lanes(records["lanes"], snapshots, issues)
    resolve_default(lanes, issues)
    tasks = live_children(records["tasks"], "tasks", "lanePublicId", lanes, issues)
    steps = live_children(records["steps"], "steps", "taskPublicId", tasks, issues)
    lane_positions = {lane["publicId"]: index for index, lane in enumerate(lanes)}
    tasks.sort(key=lambda r: (lane_positions[r["lanePublicId"]], *task_order_key(r)))
    task_positions = {task["publicId"]: index for index, task in enumerate(tasks)}
    steps.sort(key=lambda r: (task_positions[r["taskPublicId"]], r["rank"], r["legacyId"]))

    for (lane_id, _), group in groupby(tasks, key=lambda r: (r["lanePublicId"], r.get("rank", MISSING_TASK_RANK))):
        tied = list(group)
        if len(tied) > 1:
            issue(issues, "task_order_tie", kind="tasks", lanePublicId=lane_id,
                  publicIds=[r["publicId"] for r in tied], unresolved=False)
    return {**records, "lanes": lanes, "tasks": tasks, "steps": steps}


def reconcile(snapshots):
    snapshots = sorted(snapshots, key=lambda snapshot: snapshot.origin)
    issues = [item for snapshot in snapshots for item in snapshot.issues]
    records, tombstones, divergences = reconcile_entities(snapshots, issues)
    records = ordered_records(records, snapshots, issues)

    preferences = {}
    reported = defaultdict(dict)
    for snapshot in snapshots:
        for key, value in snapshot.preferences.items():
            reported[key][snapshot.origin] = value
    for key, origins in sorted(reported.items()):
        if len(set(origins.values())) == 1:
            preferences[key] = next(iter(origins.values()))
        else:
            issue(issues, "preference_conflict", severity="quarantine", field=key, observations=origins)

    projection = envelope("projection", records=records, tombstones=tombstones, preferences=preferences,
                          observedOrder={snapshot.origin: snapshot.order for snapshot in snapshots})
    report = envelope("report", issues=issues, divergences=divergences,
                      outputCounts={kind: len(items) for kind, items in records.items()},
                      outputStates={kind: Counter(record["state"] for record in records[kind])
                                    for kind in ("tasks", "reminders")},
                      issueCounts=Counter(item["code"] for item in issues),
                      tombstoneOutcomes=Counter(item["outcome"] for item in tombstones))
    return projection, report
