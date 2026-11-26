# Klaxon v2 backend

The Convex schema and server-side read helpers live in this package. Run the checks from the repository root with the pinned Node version.

```sh
npm ci --prefix apps/backend
npm --prefix apps/backend run verify
```

## Identity and revisions

Convex Auth 2.1 verifies a live session for each workspace request. Operators enroll a user with the internal `auth:enrollWithUsernamePassword` mutation. It returns the app user ID and revokes the signup session. The pinned integration uses Convex 1.51's internal handler interface for this registration. Rerun the provider test before upgrading either dependency.

An authenticated user calls `workspaces:ensurePersonal` to open their first owned workspace. The workspace and its owner membership are created together. Readers may read tasks, projects and ordered steps. Planners and owners may edit them. Operations marked `manage`, including export and health reads, require both the owner membership and the workspace's owner ID.

Each workspace owns its records. Convex document IDs identify relationships within a deployment. A portable ID identifies a record within its workspace and entity type across export, restore and import. An importer can therefore preserve a legacy ID while resolving the destination document ID separately. The row revision lets future mutations reject stale updates. A revision and an update timestamp serve different purposes.

Compound indexes support lookups by workspace and key. Convex permits duplicate index keys. P1-04/05 writes must check uniqueness in the same transaction as the write. A duplicate stable task ID makes the point lookup fail so callers can surface the inconsistency. Cross-record workspace consistency also requires a transaction check when writing references.

## Task queries

The read helpers accept a database reader and an authorized workspace. The registered `tasks:list`, `tasks:get`, `projects:list` and `steps:list` queries check current membership before reading records. Each list query selects one index and requests 1–50 items per page. Callers resume with the returned cursor and the same workspace and filter.

| Filter | Meaning |
| --- | --- |
| Status | Select one of the task statuses in the product spec. |
| Planned date | Read local calendar dates in the half-open interval `[from, until)`. |
| Date-only deadline | Read a deadline entered as a local calendar date, independently of the planned date. |
| Instant deadline | Read UTC epoch milliseconds in `[from, until)`. The caller resolves any timezone-specific day boundaries. |
| Project | Select one project's tasks in rank order within the workspace. |

A lower bound on each date range excludes tasks without that date. A date-only deadline retains its calendar meaning across timezones. An instant deadline keeps its exact time. Time blocks and reminder triggers have separate records, so scheduling a task does not rewrite its deadline.

## Migration boundary

The source CLI reconciles schema-17 device snapshots before projection. A v1 reminder can change between a silent task and an ordinary reminder while retaining its source ID. The importer records ambiguous identities for review and keeps imported reminders inactive. An owner can rehearse one bounded archive in a dedicated workspace. [Source CLI](../../tools/migration/README.md) · [Import and limits](../../docs/v2-legacy-import.md)

## Task writes and live verification

Call `tasks:apply` with the workspace ID, a fresh operation UUID and a command. Existing records require their current revision. A successful retry with identical input returns the original result, including its activity event ID. Reusing that UUID with different input yields `OPERATION_ID_CONFLICT`. A stale revision yields `REVISION_CONFLICT` with the current revision. The server checks write permission on every attempt, including retries.

On Windows with the pinned local Convex binary, run these checks sequentially from the repository root. Each starts its own loopback backend with synthetic accounts. They cover provider session rotation and sign-out, concurrent edits over two subscriptions, and a schema-17 SQLite import followed by export and restore. [Backup format](../../docs/backup-restore.md) · [Operator runbook](../../docs/v2-operations.md)

```sh
npm --prefix apps/backend run test:provider
node --test apps/backend/test/domain.session.mjs
node --test apps/backend/test/migration.session.mjs
```
