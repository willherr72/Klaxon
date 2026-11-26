# Klaxon v2 backend

The Convex schema and server-side read helpers live in this package. Run the checks from the repository root with the pinned Node version.

```sh
npm ci --prefix apps/backend
npm --prefix apps/backend run verify
```

## Identity and revisions

Each workspace owns its records. Convex document IDs identify relationships within a deployment. A portable ID identifies a record within its workspace and entity type across export, restore and import. An importer can therefore preserve a legacy ID while resolving the destination document ID separately. The row revision lets future mutations reject stale updates. A revision and an update timestamp serve different purposes.

Compound indexes support lookups by workspace and key. Convex permits duplicate index keys. P1-04/05 writes must check uniqueness in the same transaction as the write. A duplicate stable task ID makes the point lookup fail so callers can surface the inconsistency. Cross-record workspace consistency also requires a transaction check when writing references.

## Task queries

The read helpers accept a database reader and an authorized workspace. P1-03 owns the membership check before a registered function delegates to these helpers. Each list query selects one index and requests 1–50 items per page. Callers resume with the returned cursor and the same workspace and filter.

| Filter | Meaning |
| --- | --- |
| Status | Select one of the task statuses in the product spec. |
| Planned date | Read local calendar dates in the half-open interval `[from, until)`. |
| Date-only deadline | Read a deadline entered as a local calendar date, independently of the planned date. |
| Instant deadline | Read UTC epoch milliseconds in `[from, until)`. The caller resolves any timezone-specific day boundaries. |
| Project | Select one project's tasks in rank order within the workspace. |

A lower bound on each date range excludes tasks without that date. A date-only deadline retains its calendar meaning across timezones. An instant deadline keeps its exact time. Time blocks and reminder triggers have separate records, so scheduling a task does not rewrite its deadline.

## Migration boundary

P1-08 will reconcile v1 device snapshots before projection. A v1 reminder can change between a silent task and an ordinary reminder while retaining its source ID. Projecting both copies independently could duplicate it. The importer also needs to preserve fractional task ranks, check ambiguous ties, accept tasks without steps, and preserve empty day notes and local dates. [Migration mapping](../../docs/migration.md)
