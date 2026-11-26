# Klaxon v2 operations

## Owner health and incident logs

Use the following Convex queries on demand with the owner's authenticated session. Each uses a workspace index and returns at most 10 rows. `truncated: true` means more records exist. These snapshots are intended for triage.

| Query | What it shows |
| --- | --- |
| `health:jobs` | The newest import runs by creation time, with format, state, timestamps, and whether the run has recorded errors. |
| `health:integrations` | Connection state and last update, ordered by provider and then account key. Use the returned connection ID to look up its checkpoints. |
| `health:checkpoints` | The selected connection's recorded success and failure timestamps and whether an error is recorded. A missing success timestamp means no success has been recorded for that checkpoint. |

An empty snapshot means there are no matching records. A connection marked `active` only describes its stored state. Compare the last successful checkpoint with the expected cadence when diagnosing stale data. For `reauthorization_required`, use the supported owner reauthorization flow when available. For a failed import, retain the source archive and reproduce the issue with synthetic data before attempting a retry.

For incident reports and structured logs, use UTC timestamps, the function name, deployment environment, code revision, known status or app-defined error category, and aggregate counts or elapsed time. Use the platform request ID for private correlation. Omit arguments, response bodies, provider URLs and error strings, account and row identifiers, imported content, and all credentials, secret references and cursors. Review dashboard excerpts before sharing. Keep raw exports and provider responses out of tickets and chat.

## Deployment

Use Node 24.12.0 from [the repository pin](../.node-version), Convex 1.51.0, and Convex Auth 2.1.0 from [the backend lockfile](../apps/backend/package-lock.json). The Node pin is for tooling. The health queries execute in the default Convex runtime. [Convex runtimes](https://docs.convex.dev/functions/runtimes)

From the repository root, run the local checks against synthetic data.

```sh
npm ci --prefix apps/backend
npm --prefix apps/backend run verify
```

For an authorized deployment, use a disposable Free project with synthetic workspaces first. Confirm the target project, deployment, and plan in the dashboard. From `apps/backend`, use the pinned `npx convex deploy --dry-run` to review the target and bundle, then `npx convex deploy` with the deploy key for that environment. Keep deploy keys and backend secret variables in the deployment or CI secret store. Give CI only the deploy permissions it needs. Convex Auth 2.1.0 uses the deployment's signing key via the mounted `auth` component. [Deployment CLI](https://docs.convex.dev/cli/reference/deploy) · [Deployment settings](https://docs.convex.dev/dashboard/deployments/deployment-settings) · [Convex Auth provider](https://docs.convex.dev/convex-auth-api/server/#convexauthprovider)

After deploying to the disposable target, confirm sign-in, an owner health read, a denied non-owner read, and client connectivity against the intended deployment. Record the commit, deployment environment and UTC time. Take a backup before a production schema change. For a code rollback, redeploy a known-good revision after confirming its schema can read the current data. See the existing hosting and cutover gate. [Klaxon deployment gate](deployment.md)

For deployments upgraded from the first calendar schema, invoke the internal `calendar:backfillOverlapIndex` mutation until it reports `updated: 0`. Each transaction indexes up to 128 blocks and 128 imported events. New block writes and restores populate the index immediately. Until backfill finishes, a window with extensive history can return `CALENDAR_RANGE_LIMIT`.

## Web Push delivery

Serve the Development web build over HTTPS. The Convex deployment reads `KLAXON_WEB_PUSH_ENABLED=true`, a matching VAPID key pair in `KLAXON_WEB_PUSH_VAPID_PUBLIC_KEY` and `KLAXON_WEB_PUSH_VAPID_PRIVATE_KEY`, a `mailto:` contact in `KLAXON_WEB_PUSH_VAPID_SUBJECT`, and an independent 32-byte base64url `KLAXON_WEB_PUSH_STORAGE_KEY`. Keep both private keys in the deployment's secret configuration. Replacing the storage key requires re-enrolling devices whose subscription data used the previous key.

In **Reminders → Delivery settings**, enable workspace delivery, then enroll each browser that should receive reminders. Create one future occurrence for a delivery check after enrollment. An accepted provider request, a worker receipt, and a visible notification are separate observations. Record the occurrence time, device and browser, delivery outcome and visible copy count. Delivery history and overdue reminders remain available in the planner.

Explicit rate limits can trigger a bounded retry. A missing response after dispatch leaves the outcome uncertain. The delivery window is five minutes. To retire the route, revoke the browser enrollment in delivery settings and turn off workspace delivery. Removing a grant cannot recall a request already sent to a provider. [Delivery worker](../apps/backend/convex/deliveryWorker.ts)

## Backup and recovery

- For a deployment recovery point, use Convex **Backup & Restore**. Include file storage when the application depends on it. Free offers on-demand backups, with up to two per deployment held for seven days. Budget for the database reads and file bandwidth and storage. Download a copy when a longer retention period is needed and keep it in encrypted, access-restricted storage. Record its source revision, UTC snapshot time and checksum. [Convex backup and restore](https://docs.convex.dev/database/backup-restore)
- Keep the matching code in version control and deployment settings in the protected configuration store. Inventory pending jobs separately so they can be reconciled after a recovery. A deployment snapshot contains sensitive table data and optionally files. Use the Klaxon versioned JSON export for portable workspace recovery and reissue credentials separately. [Convex snapshot contents](https://docs.convex.dev/database/backup-restore#what-does-the-backup-not-contain) · [Klaxon migration and restore](migration.md)
- Rehearse recovery with a synthetic snapshot in a disposable target. Verify its checksum before importing and verify workspace ownership, record counts, relationships and representative reads afterward. A deployment restore replaces existing table data. For an authorized production restore, take a fresh recovery point first, reconcile pending work before resuming jobs and verify auth and client access on the recovered deployment. [Convex backup and restore](https://docs.convex.dev/database/backup-restore#restoring-from-backup)

## Free limits and headroom

Provider caps checked on 2026-11-25. Convex Free publishes 1 million function calls, 20 GB-hours of action compute, 1 GB of database I/O and 1 GB of file egress per month, plus 0.5 GB of database storage and 1 GB of file storage. Subscription updates and scheduled executions count toward function calls. Starter allows billable overages. Cloudflare Pages Free allows 500 builds per month, one concurrent build, up to 20 minutes per build and 25 MiB per asset. [Convex resource limits](https://docs.convex.dev/production/state/limits) · [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

For a future authorized measurement, record the Convex team's plan, region, billing period and current usage by metric across all its projects. From **Team → Usage**, compare equal, quiet and workload windows at the available dashboard resolution. Count client-minutes, refreshes, task edits, subscriptions, scheduled jobs and polling separately. Use the observed increments to project the remaining period. For monthly metrics, subtract usage to date and projected additional usage from the displayed cap. For retained storage, subtract current usage and expected growth from the cap. Account for imports and backups separately. Document the time windows, workload and any unrelated usage. Leave headroom unverified when the measurements cannot isolate the workload. [Convex team usage](https://docs.convex.dev/dashboard/teams/teams#usage) · [P0 workload estimates](deployment.md)

Published caps and P0 estimates provide planning inputs. Actual team usage and headroom remain unmeasured here. If usage approaches a cap, slow noncritical polling and maintenance first, surface stale integration state and preserve queued work. Review deployment-level limits separately because a disable threshold can stop requests for the deployment. [Convex usage limits](https://docs.convex.dev/production/usage-limits)
