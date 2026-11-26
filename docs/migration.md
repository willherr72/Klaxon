# Legacy migration

## P0 feasibility, November 23, 2026

Klaxon 0.11.1 records schema versions 1–17 in SQLite. Each migration commits its DDL and version together. Opening an older database through the app applies pending migrations. For an export, use SQLite read-only mode against a consistent snapshot. The existing online-backup implementation accounts for WAL. The encrypted v1 portable backup includes the database and Iroh secret. Keep that archive local for rollback. Upload only a validated field projection.

Run `python spikes/migration/probe.py` from the repository root with a Python build that includes SQLite FTS5. The P0 probe applied all 17 SQL migrations from the repository to a temporary synthetic database. It inserted a completed silent task in the default lane, a completed child step, a daily reminder, a thought and a local-date note. Reopening with SQLite URI mode=ro verified the parent and lane joins, state, recurrence, capture count, day key, schema version and integrity check. The database file SHA-256 matched before and after reading. Convex import, cross-device reconciliation, native rollback and v2 restore still require rehearsals.

## P1-08 field mapping

| Legacy source | Intended v2 mapping | Verification |
| --- | --- | --- |
| task_lanes | Lanes keyed by legacy ID, with name, order, default and timestamps | Preserve order_index then created_at and exactly one default |
| reminders with silent=1 | Tasks with stable legacy ID, lane relationship, title, description, tags, priority, dates, state and source attribution | Keep task_sort_key precision and existing tie order. Treat undated task sentinel 0 as absent. Preserve genuine scheduled instants. Flag ambiguous date semantics. |
| reminders with silent=0 | Independent reminders with stable ID, due instant, priority, snooze and recurrence | Preserve pending, fired, snoozed, dismissed and completed distinctly. Preserve daily, weekly weekdays, monthly day and interval seconds, and raw values on exceptions. Flag device-local sound references. |
| task_steps | Task steps keyed by legacy step ID | Resolve task_id, preserve completed, timestamps and sort_key then ID |
| thoughts | Captures keyed by legacy ID | Preserve body, tags and timestamps |
| day_notes | Notes keyed by workspace and local YYYY-MM-DD | Keep empty notes, dates and timestamps. Avoid UTC conversion of date-only keys. |
| tombstones | Evidence for reconciling device exports | Compare deletion timestamps against surviving versions before resolving |
| settings | Individually reviewed user preferences | Export allowlisted keys only. Review unknown keys locally without copying their values into logs. |

Preserve legacy source and external_id as attribution. Establish provider links only after validating the provider and connection. Record any unsupported state or recurrence in the divergence report along with its entity key. Some lane or task order keys can tie. Record observed sequence and flag unresolved ties. Exclude peers, Iroh identity files, secrets, credentials, agent receipts, sync journal, epochs and cursors, armed alarms and FTS tables from portable domain data.

## Rehearsal and reconciliation

1. Assign pseudonymous device origins to synthetic snapshots. Open each read-only and fail closed on unknown schema versions. Record export format and source schema versions, per-kind counts and a SHA-256 over canonical payload bytes.
2. Import into an isolated workspace. Scope stable import keys by workspace, entity kind and legacy ID. Compare same-key payloads across origins before applying. Keep source hashes for provenance and retain divergent candidates for explicit resolution. Import lanes before tasks, tasks before steps. Keep delivery disabled.
3. Commit each batch with its mapping and checkpoint. Replay an identical archive, interrupt after a batch and resume, and try a divergent archive. Require one destination entity per key. Quarantine malformed JSON, orphan steps, missing lanes and unknown values with bounded diagnostics.
4. Compare source and exported counts per kind and state, ID sets, parent-child edges, visible ordering, recurrence payloads, priorities, timestamps, date-only values and all exception counts. Export v2 to versioned JSON and restore it into a second empty workspace. Compare normalized records and relationships. Keep a signed-off divergence report.

## Owner-approved cutover and rollback

Confirm v1 convergence across devices or reconcile separate device exports first. Freeze v1 writes, stop old schedulers, take final encrypted v1 backups, export, import and verify. Enable v2 reminders only after reconciliation. Reauthorize integrations and issue fresh agent credentials. Retain signed v1 releases and backups until acceptance and a stable observation period.

To roll back, freeze v2 writes and reminder delivery, export post-cutover edits, restore the final v1 snapshots with the original identity for each device and reconcile later changes explicitly. Before applying a restore, retain a separate, verified backup of the database being displaced and its device identity. Check pairings, tasks and exactly one reminder delivery before reopening writes. Restoring v1 changes the sync epoch. Test recovery on disposable devices before cutover.

Source references: src-tauri/src/db/migrations.rs, migration_016.sql, migration_017.sql, db/reminders.rs, db/task_steps.rs, models.rs and backup/{snapshot,container,restore}.rs.

### Synthetic failure and recovery evidence

Start the task projection from every reminder with `silent=1`. A v1 task can have zero steps. The fixture includes a pending task with no steps in a custom lane and a completed task with two steps in the default lane. The optional step join retains the first task and orders the second task’s children by `sort_key` and ID. Schema 17 also permits a missing or dangling task lane reference. The preflight checks each task’s lane before the join and reports the count that needs reconciliation. Each rejected synthetic snapshot retains its original file hash.

Schema 17 has no foreign key from a step to its task. The original rehearsal's inner join could still report success when an additional step had no parent. The read-only preflight now checks every step against a silent task. Two disposable snapshots exercise a missing parent and a parent that is an ordinary reminder. Each must report one unresolved step and retain its original file hash after validation. This identifies rows that need reconciliation before import.

`python spikes/migration/probe.py` also seeds a disposable schema-17 database in WAL mode. With one step rename committed and a second rename still pending, the probe takes two copies. Copying the main database file alone produces a copy that passes SQLite integrity and the fixture’s schema and relationship checks, yet still contains the original step title. SQLite’s online backup, taken through a separate read-only connection, contains the committed title. The source retains that same title after the writer closes and rolls back the pending edit.

For a live v1 database, take the snapshot through SQLite’s online-backup API. Integrity and a file hash can verify a copy that has already missed committed WAL changes. In this rehearsal the source main file and WAL stayed byte-identical across acquisition while the writer remained open. The probe also rejects a truncated derivative and successfully rereads the intact snapshot. Import replay, reconciliation across device histories and destination restore remain P1 rehearsals.

For cutover, use a freshly completed export. The v1 automatic snapshot writer creates the timestamped destination before backup completes, and its interval check uses the timestamp in the filename. An interrupted write can therefore leave a recent-looking file that suppresses another automatic attempt for up to 24 hours. A filename alone cannot establish that the backup completed. [v1 snapshot writer](../src-tauri/src/backup/snapshot.rs)

**The v1 restore undo copy missed a committed edit after an abrupt writer exit.** A separate Windows integration probe exercised Klaxon 0.11.1’s `restore::stage` and `restore::apply_staged_if_any` against a temporary schema-17 database. To reproduce, stage a valid replacement, then have a child process update one synthetic thought in the live database with WAL autocheckpoint disabled. Exit the child immediately after commit without closing its SQLite connection. Before applying the staged restore, confirm from a read-only connection that the new value is visible and the WAL has data.

The staged replacement opened successfully. The displaced database in `restore-undo` passed SQLite integrity but contained the original thought. The assertion that undo retained the committed value failed. The swap moves the old main file into undo and removes its WAL. Before cutover, rehearse recovery from the independent pre-restore backup and verify the last committed domain values. The 11 passing baseline backup tests cover ordinary staging and undo. [v1 restore implementation](../src-tauri/src/backup/restore.rs)

**Recovery from a separate encrypted backup passed on Windows.** A second run took a v1 online snapshot through a read-only connection after the same abrupt exit, verified the committed thought, and sealed the snapshot and synthetic device identity using the v1 backup container. After applying the staged replacement and checking its different identity, the probe reopened the encrypted file, staged its contents and restored again. SQLite integrity passed and both the committed thought and original identity matched. This exercised the Rust library with synthetic data. The GUI export, physical devices and v2 migration still need their own acceptance.
