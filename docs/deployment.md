# Free-tier deployment gate

Reviewed 2026-11-23. Use a disposable project in a confirmed Convex Free team. Starter can bill overages. Check plan in the team dashboard before hosted setup and record the plan, region and date without credentials. Use provider subdomains and a static Cloudflare Pages Free project. No Workers, paid identity provider or metered AI is needed for the spike.

The published Convex allowances include 1M function calls, 20 GB-hours of action compute, 0.5 GB database storage, 1 GB database I/O and 1 GB egress. Recheck terms and actual dashboard usage before cutover. Track subscription updates and retries alongside scheduled jobs. Pause noncritical polling first on quota pressure, show stale integration timestamps and preserve queued work. Test quota degradation with synthetic limits. [Convex pricing](https://www.convex.dev/pricing)

Pages Free allows 500 builds per month, one concurrent build, 20 minutes per build and 25 MiB per asset. Keep native installers in GitHub releases. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

A tested portable export/restore belongs to P1-07. Before release restore a checksum-verified archive into a different disposable workspace and compare domain records and relationships. Reissue credentials separately.
