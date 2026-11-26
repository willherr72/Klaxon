# Klaxon v1 migration export

Run from the repository root with Python 3.10 or newer and SQLite with FTS5. Name each source with a pseudonym and keep the output directory local. The `export` command opens each explicitly named SQLite file in read-only mode and takes an in-memory SQLite online backup. SQLite reads committed WAL pages and excludes pending transactions.

```powershell
python tools/migration/export_legacy.py export --source 'device-a=C:/fixtures/device-a.sqlite' --source 'device-b=C:/fixtures/device-b.sqlite' --output C:/fixtures/export
python tools/migration/export_legacy.py verify --output C:/fixtures/export
python -B -m unittest discover -s tools/migration -v
```

The tests create disposable databases with the actual v1 migrations via `spikes/migration/probe.py`. Run the CLI against an SQLite database file, keeping any associated WAL sidecar beside it. Independently retain the v1 rollback archive as described in `docs/migration.md`.

## Artifacts

All three JSON files have a `format`, `version` of `1`, and `sourceSchemaVersion` of `17`.

| File | Contents |
| --- | --- |
| `projection.json` | `records` buckets for `lanes`, `tasks`, `steps`, `reminders`, `captures`, and `dayNotes`. `observedOrder` retains per-origin public-ID sequences for lanes, tasks by lane, and steps by task. `tombstones` retain deletion timestamps, contributing origins, observed kinds, and the resolution. `preferences` contains agreed values from the allowlist. |
| `report.json` | `issues` with `review` or `quarantine` severity, counts per code, output counts by kind and state, tombstone outcomes, and `divergences` with the competing projected records, origins, hashes, and resolution. Invalid candidates have a row hash and bounded diagnostics. |
| `manifest.json` | Source fingerprints and counts by pseudonym, SHA-256 for each artifact, and a `writing` or `complete` checkpoint. Source fingerprints cover the extraction inputs and observed legacy order. |

Artifacts use compact UTF-8 JSON with sorted object keys, preserved array order, and no terminal newline. Verify the SHA-256 of the file bytes before reading the projection. An interrupted export can resume by running the same `export` command with the same aliases and source fingerprints. It reuses verified artifacts and publishes missing ones. An identical completed export verifies the artifacts and leaves their bytes and timestamps intact. Use a fresh output directory when the source projection changes. The directory also contains an empty `.export.lock` file used to prevent concurrent publication.

## Field and ordering contract

Every record has `legacyId`, `publicId`, `createdAt`, and `updatedAt`. Public IDs are UUIDv5 under namespace `524cd2e5-2d3e-45a0-ada3-acd15f5c24b8` with the name `<bucket>:<legacyId>`. Scope destination identity by workspace, bucket, and legacy ID. Day notes use the exact local `YYYY-MM-DD` as `legacyId` and `localDate`. Their empty bodies are preserved.

| Bucket | Additional fields |
| --- | --- |
| `lanes` | `name`, `orderIndex`, `isDefault` |
| `tasks` | `lanePublicId`, optional fractional `rank`, `title`, optional `description`, `tags`, `priority`, `state`, optional `dueAt`, `attribution` |
| `steps` | `taskPublicId`, `title`, `completed`, integer `rank` |
| `reminders` | `title`, optional `description`, `tags`, `priority`, `state`, `dueAt`, optional `snoozeUntil`, optional `recurrence` and `recurrenceBasis`, `attribution` |
| `captures` | `body`, `tags` |
| `dayNotes` | `localDate`, `body` |

Task and reminder priorities use `low`, `normal`, or `high`. Their states retain v1’s `pending`, `fired`, `snoozed`, `dismissed`, and `completed`. `attribution` holds legacy `source` and optional `externalId` as data. Pending v2 provider links require a verified connection. Recurrence retains `daily`, `weekly` with Monday as `0`, `monthly` with the stored day, or `interval` with `everySeconds`. Rules carry `recurrenceBasis: "legacy_utc"`. Unexpected recurrence or snooze metadata on a silent task is preserved when valid and flagged in the report. A task `due_at` of zero omits `dueAt`. Other task instants keep their millisecond value and receive a date-intent review flag. Sound references receive a presence-only report entry. The preference allowlist currently contains `list_sort_order` with `date_asc` or `date_desc`.

Read lane, task, and step arrays in their published order when importing. Lanes use `orderIndex`, then `createdAt`. Equal keys use the fullest observed sequence, with pseudonym order as the tie-breaker and a report entry for conflicting or partial observations. Tasks use lane order, then their original fractional rank, newest update, due instant, and legacy ID. Steps use task order, then rank and legacy ID. If the reconciled lane set needs a default, it prefers the seeded v1 lane when eligible, then the first eligible lane in published order, with a report entry. A projection without any valid lane requires review before restore.

## Reconciliation and adapter handoff

For a same-kind key, the newest `updatedAt` wins when validated. Distinct valid payloads with equal newest timestamps, malformed competing versions at or above the newest valid timestamp, and IDs observed as both tasks and reminders are quarantined. Tombstones apply to the observed v1 entity kind and beat row updates at or before the deletion time. Step tombstones beat newer edits as in v1. The report flags untyped tombstones matching more than one kind. Day notes are outside the v1 tombstone namespace. Tasks and steps require their referenced parents to survive reconciliation.

Review the report before mapping the projection into a destination archive. The destination adapter owns workspace and user identity, v2 task status and date semantics, timezone policy, and import checkpoints. In particular, v1 persisted a monthly day through `31` while the scheduler clamped days above `28`. The destination recurrence policy needs an explicit decision. Import lanes before tasks and tasks before steps. Keep reminder delivery disabled throughout import and restore verification.
