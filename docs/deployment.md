# Free-tier deployment gate

Public allowances rechecked 2026-11-25. Use a disposable project in a confirmed Convex Free team. Starter can bill overages. Check the plan in the team dashboard before hosted setup and record the plan, region and date without credentials. Use provider subdomains and a static Cloudflare Pages Free project. The spike needs only static web hosting and the Free backend.

The published Convex Free allowances include 1M monthly function calls, 20 GB-hours of monthly action compute, 0.5 GB database storage, 1 GB monthly database I/O, 1 GB file storage and 1 GB monthly data egress. Function calls include subscription updates and scheduled jobs. Recheck terms and actual dashboard usage before cutover. Pause noncritical polling first on quota pressure, show stale integration timestamps and preserve queued work. Test quota degradation with synthetic limits. [Convex resource limits](https://docs.convex.dev/production/state/limits)

Convex also supports per-deployment thresholds. Exceeding a configured disable threshold blocks new requests until the UTC window resets or an administrator changes the limit. Development deployments lack threshold emails. The team's actual region, usage and headroom still require dashboard verification. [Convex usage limits](https://docs.convex.dev/production/usage-limits)

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

### Active browser sessions

An active Edge tab renewed its 60-second token 8.870 seconds before expiry against the pinned local issuer. Use one explicit refresh mutation every 50 seconds as a planning assumption for each connected, awake client. In the example below, both devices use the portable browser client. Active hours count separately for every signed-in tab. Background suspension, session boundaries, outages and reconnects can change the rate. [Measured renewal](klaxon-v2-progress.md#portable-browser-session-grants) · [Browser refresh path](../spikes/p0/portable/account.js)

| Active hours per device per day | Estimated refresh mutations per 30 days | Task-list calls plus explicit refreshes | Share of 1M Free calls |
|---:|---:|---:|---:|
| 1 | 4,320 | 6,300 | 0.630% |
| 8 | 34,560 | 36,540 | 3.654% |
| 24 | 103,680 | 105,660 | 10.566% |

Refreshes are `2 devices × 30 days × active hours × 3,600 / 50`. The partial call total adds the 1,980 task-list calls above. It excludes sign-in, sign-out, retries, scheduled cleanup, and any additional subscription or component work. Each refresh calls the Auth component, which reads the session, updates token state and stores a successor. The observed subscription stayed open across renewal. Its continued operation does not measure hosted function counts or database bytes. [Spike auth configuration](../spikes/p0/convex/auth.ts) · [Convex usage definitions](https://docs.convex.dev/production/state/limits)

**Database I/O could reach its cap first.** After the assumed 30 MB task workload, the 24-hour scenario leaves about **9.36 kB per refresh** for all additional database work if this is the team's only workload. As a sensitivity check, one extra uncached 20-row task-list read per renewal at the assumed 1,000 bytes per row would put task-list I/O alone at **721.2 MB** for eight hours or **2,103.6 MB** for 24 hours, before auth I/O. The latter exceeds the published 1 GB Free cap. The extra read is hypothetical. Cached reads incur no database bandwidth. [Convex realtime caching](https://docs.convex.dev/realtime) · [Free resource caps](https://docs.convex.dev/production/state/limits)

Keep Free as the deployment requirement. At the next authorized dashboard comparison, record team headroom, then compare a quiet interval with an equal interval containing known active client-minutes and counted refreshes, without task edits. Separately measure the task-edit workload above. Use the incremental calls and database I/O to project the intended active hours against the team's remaining capacity. If dashboard resolution or unrelated traffic obscures the delta, leave capacity unverified. [Convex usage metrics](https://docs.convex.dev/production/usage-limits)
