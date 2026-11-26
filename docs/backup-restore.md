# Klaxon v2 workspace backup and restore

Call `backups:exportWorkspace` with `{ workspaceId }` as the signed-in workspace owner. Save the returned `archive` string as a UTF-8 `.json` file. The export contains readable workspace data. Store it somewhere with access limited to the people you intend to share it with.

The version 1 envelope has `format: "klaxon.workspace"`, `version: 1`, a lowercase hexadecimal `checksum`, and `payload`. The checksum is SHA-256 of the UTF-8 payload serialized as compact JSON with object keys sorted by JavaScript string order at every level. Array order is significant. The checksum detects corruption. Anyone with the file can edit it and compute a new checksum.

## What the archive contains

The payload contains the workspace name, projects and boards, lanes, tasks, ordered steps, captures, day notes, reminders, day plans, time blocks, external task references, and the workspace owner's preferences. It preserves planning record public IDs, revisions, timestamps, local dates, ranks, and the order of relationship lists. Portable relationships use public IDs within the corresponding collection. Restore allocates fresh database IDs and resolves each link using the restored records.

External task links retain provider, object ID, label, and canonical URL when present. A managed mirror becomes a detached reference. Its connection, cached fields, and refresh timestamp are omitted. Source relationships to captures and legacy attribution survive. Sources bound to an integration connection or agent credential and import filters scoped to a connection are omitted. Provider-wide import filters are retained.

The archive excludes user accounts, sessions, workspace membership grants, other users' preferences, integration connections and secrets, agent credentials, mirrored calendar events, sync checkpoints, push subscriptions, reminder occurrences and jobs, delivery attempts, activity history, plan revision history, operation receipts, and migration bookkeeping. Restore creates one new owner membership for the signed-in account. Existing reminder definitions, recurrence, state, and trigger timestamps survive. The restore mutation creates no scheduled jobs, subscriptions, or deliveries.

## Rehearse and verify a restore

1. Export a synthetic or disposable workspace and keep the original archive available. Use `npm --prefix apps/backend test -- test/backups.test.ts` to run the registered functions with a local Convex test database and synthetic identities.
2. Generate a UUID `operationId` and keep it with the archive for this restore attempt. Call `backups:restoreWorkspace` with `{ archive, operationId }` as a signed-in user. The mutation verifies the archive and commits the new workspace, membership, records, and a restore receipt in one transaction. It returns the new `workspaceId` and `workspacePublicId`. The receipt belongs to the recipient's personal workspace, which is initialized if needed. If the response is lost, retry with the same archive and UUID to recover the same result. A different verified checksum with that UUID conflicts. Generate a distinct UUID to create another copy intentionally.
3. Export the returned workspace and compare it with the original export. Then inspect task/step order, capture promotion and attribution, project boards, plan/block associations, dates, recurrence and snooze values, detached external references, and the owner's preferences. Verify that the original workspace remains available and the new workspace has only its owner membership.
4. Reauthorize integrations and issue fresh credentials separately if the copy becomes active. Review restored reminder definitions with the future delivery setup before enabling it.

Each direction is limited to 500 planning records total and 512 KiB of UTF-8 JSON. Export also caps the aggregate size of source rows read at 1 MiB. If a limit is exceeded, the operation fails without returning a partial archive or publishing a partial restore. Unsupported versions, malformed values, checksum mismatches, duplicate public IDs within a collection, and dangling or inconsistent planning relationships also fail. No older v2 envelope versions or v1 SQLite backups are accepted by this endpoint. See [Legacy migration](migration.md) for the v1 workflow.
