# Legacy import rehearsal

The Convex importer accepts artifacts produced by the local [schema-17 exporter](../tools/migration/export_legacy.py). Rehearse with disposable SQLite fixtures and a local v2 deployment. The import creates a separate workspace owned by the authenticated caller and preserves the caller’s existing workspace and v1 snapshots.

## Run a rehearsal

1. Export a synthetic snapshot. Give each source a pseudonymous label. Reconcile all intended sources in the same export.

   ```sh
   python -B tools/migration/export_legacy.py export --source alpha=path/to/synthetic.sqlite --output path/to/export
   python -B tools/migration/export_legacy.py verify --output path/to/export
   ```

2. With an authenticated Convex client, call `imports:createWorkspace` with an existing workspace ID you own and a UUID `operationId`. Save the returned rehearsal `workspaceId`. Repeating the creation request with the same source workspace and operation ID returns the same destination.
3. Call `imports:apply` with the rehearsal `workspaceId`, a UUID `operationId`, an IANA `timezone`, and the exact UTF-8 contents of `manifest.json`, `projection.json` and `report.json` as the strings `manifest`, `projection` and `report`. Keep the original formatting and line endings. The server checks both artifact hashes against the manifest, then checks report totals, reconciliation decisions, tombstone observations, and version hashes against the supplied evidence. Inconsistent artifacts fail before the importer writes any rows or ledger entries.
4. Review the returned run or retrieve it with `imports:get` using the rehearsal `workspaceId` and the run’s `publicId`. `imports:listHolds` accepts `workspaceId`, `state` (`quarantined`, `divergent` or `deleted`) and Convex `paginationOpts`. It returns source IDs, candidate hashes and issue codes. Keep the local artifacts to inspect candidate contents, device observations, and report details.

The cap is 512 KiB for all three UTF-8 artifacts combined, 500 total projected rows and review entries (including source candidate variants), and eight source labels. An archive occupies a single transaction. Its committed checkpoint is `complete` with `nextBatch` 1. Transient errors can be retried with the same inputs and operation ID. The transaction includes domain rows, mappings, run, operation receipt and activity. A failure rolls back the transaction in full.

Replaying the same archive and timezone returns the same run and keeps destination rows and mappings unique. A different archive or timezone in the same rehearsal workspace returns `LEGACY_IMPORT_ARCHIVE_CONFLICT`. An operation ID already used for different inputs in the same workspace returns `OPERATION_ID_CONFLICT`. Import an independently reconciled archive into its own rehearsal workspace.

## Verify what arrived

| Source | Destination behavior |
| --- | --- |
| Lanes and steps | Use the reconciled array order as the destination rank, including tied legacy ranks. Steps link to their imported parent and retain their completion flag. |
| Silent tasks | Pending maps to `ready` and completed maps to `done`. A genuine nonzero legacy due instant becomes an instant deadline, with the source date-intent warning retained. Fractional ranks are preserved, ties use the reconciled order, and an absent rank sorts after the ranked tasks in its lane. Completion timestamps remain absent when v1 supplied only a completion flag. Unsupported states or scheduling metadata are held for review. |
| Reminders | Retain state, due instant, snooze and recurrence. Rules retain `legacy_utc` semantics, and the supplied timezone is stored on the reminder. Imported reminders have no next trigger, occurrence, scheduled job or delivery registration. |
| Captures and day notes | Preserve capture bodies and tags, note bodies including empty notes, and exact local-date keys. |
| Attribution and preferences | Keep legacy attribution as text. The allowlisted legacy sort preference is recorded as unapplied in the run diagnostics. |

Compare imported rows and relationship order to the local projection. Each destination keeps the source projector’s public UUID. The import ledger maps the original SQLite table and legacy ID in the rehearsal workspace. Silent tasks and ordinary reminders share the original `reminders` identity namespace. Counts use projected rows and held source identities rather than the sum of physical rows across device snapshots. Tombstone counts describe reconciliation evidence. Source manifests retain per-device counts.

`needs_reconciliation` means the run contains rejected or divergent evidence, or an unresolved source issue. A valid selected version can still be imported while an older malformed candidate keeps its own hash, timestamp, and issue codes on the mapping. The run reports the candidate issue even when the destination row was imported. The hold query lists mappings by their identity-level state. Use the local report to inspect malformed candidates for imported identities.

`verified` indicates that the supplied artifacts passed checksum and internal consistency checks and the accepted projection was materialized. The hashes are supplied by the exporter, and Convex receives only the artifacts. An internally consistent archive can still omit or alter information from the original SQLite snapshot. Keep the original snapshot and compare an independently regenerated export when source provenance or completeness matters. Source versions, order observations, and report payloads remain in the local artifacts while the destination keeps bounded diagnostics, hashes, and timestamps. Malformed row identities can only be counted.

The registered endpoint tests use byte-for-byte CLI artifacts from synthetic exports. They check owner authorization, scope and replay, checksums, rejection of inconsistent reports with refreshed checksums, retention of malformed candidates alongside selected versions, source and destination holds, ordered joins, absent delivery data, and rollback after a forced failure following the writes. Transaction rollback covers an interrupted attempt. An already committed rehearsal stays in its separate workspace and replays its existing run. To recheck a historical import with the current importer, use a new rehearsal workspace. The v1 device restore and cutover procedure is covered in [Legacy migration](migration.md).

```sh
cd apps/backend
npm test -- legacyImport
```
