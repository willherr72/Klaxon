# Free-tier deployment gate

Reviewed 2026-11-23. Use a disposable project in a confirmed Convex Free team. Starter can bill overages. Check plan in the team dashboard before hosted setup and record the plan, region and date without credentials. Use provider subdomains and a static Cloudflare Pages Free project. No Workers, paid identity provider or metered AI is needed for the spike.

The published Convex allowances include 1M function calls, 20 GB-hours of action compute, 0.5 GB database storage, 1 GB database I/O and 1 GB egress. Recheck terms and actual dashboard usage before cutover. Track subscription updates and retries alongside scheduled jobs. Pause noncritical polling first on quota pressure, show stale integration timestamps and preserve queued work. Test quota degradation with synthetic limits. [Convex pricing](https://www.convex.dev/pricing)

Pages Free allows 500 builds per month, one concurrent build, 20 minutes per build and 25 MiB per asset. Keep native installers in GitHub releases. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

A tested portable export/restore belongs to P1-07. Before release restore a checksum-verified archive into a different disposable workspace and compare domain records and relationships. Reissue credentials separately.
Budget monthly calls, compute, I/O and egress across the team, including development projects. Database and file storage measure retained GB. Confirm remaining shared capacity in the dashboard before load tests.

## Unsigned validation costs

On November 24, 2026 (Central), an anonymous GitHub repository metadata request returned HTTP 200 and `visibility: public` for Klaxon. At `5c6305315be86fa52e12e4969a1342f89fbb80c6`, the v2 validation jobs select `ubuntu-24.04` and `windows-2022`. GitHub classifies both as standard hosted runners and includes their compute for public repositories. The workflow keeps its portable HTML artifact for one day. Recheck billing if repository visibility or runner class changes. This check covers validation compute; Convex capacity is recorded separately below. [Repository metadata](https://api.github.com/repos/willherr72/Klaxon) · [Workflow](../.github/workflows/v2-validation.yml) · [Standard runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) · [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## P0 single-owner task-list estimate

For a 30-day example, assume one owner makes 20 successful task renames per day across Windows and Android combined. Each device opens one list subscription, reconnects once, and makes one extra explicit list read after a timeout each day. Assume both devices receive every rename and each list read or update reads all 20 rows from the database. The spike limits the owner-indexed list to 20 rows. Cache reuse and batching can reduce actual work. [Task query](../spikes/p0/convex/tasks.ts) · [Subscribed client](../spikes/p0/portable/account.js) · [Convex usage definitions](https://docs.convex.dev/production/state/limits)

| Monthly metric | Calculation | Share of published Free allowance |
|---|---|---|
| Function calls | 600 renames (`30 × 20`) + 1,380 list calls (`30 × 2 devices × (20 updates + 2 starts + 1 retry)`) = **1,980** | **0.198%** of 1M calls |
| Database I/O | Assume 1,000 bytes per returned row including index reads and 4,000 bytes total per rename including index work. `1,380 × 20 × 1,000 + 600 × 4,000` = **30 MB** (decimal) | **3.0%** of 1 GB |

For this task-list slice, database I/O uses a larger fraction of its allowance than calls. Authentication, other team projects, future jobs and integrations are outside the estimate. The byte sizes are assumptions. At the next authorized usage review, compare database I/O and call deltas for a known batch of edits with both subscriptions active, then check total shared-team usage before projecting remaining capacity.
