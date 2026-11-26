# P0 security decisions

Derive owner and actor on the server. Bind child and referenced records to the same workspace. Make revision checks, receipt writes, domain changes and attributed audit events atomic. Reject a reused operation ID with a different payload. Test unauthenticated reads, cross-owner references and revoked credentials against actual entry points.

Native OAuth callbacks require state and PKCE checks. Keep tokens out of logs, URLs, synced vault settings and portable exports. Hash agent bearer tokens; protect provider refresh tokens with an approved secret store. Validate webhook authenticity and replay behavior. Treat imported descriptions as data. Tenant approval and a bounded metadata policy precede employer connections. Record residual risks and review credential storage on actual devices before P1 approval. The [physical Android verification](klaxon-v2-progress.md#physical-android-hosted-session) passed on one ARM64 phone with the hosted provider. A revoked session stayed signed out across a cold launch. Device-wide outage recovery remains open.
Reauthorize each request before receipt lookup or replay. Scope receipts by workspace, actor and operation ID. Compare the canonical operation including action, target and payload before returning a prior result. Test revoked identities and identical operation IDs from different workspaces.

## P1 authentication and portable archives

The public password sign-in returns the same credential error for an unknown username and an incorrect password. The underlying provider takes different code paths in those cases. Response timing has not been measured. Enrollment is an internal mutation. It returns the app user ID to the operator and revokes the signup session. [Registered auth functions](../apps/backend/convex/auth.ts)

The registered restore and import functions require an authenticated user and only publish to an isolated destination. An archive checksum detects changes against the recorded digest. Someone who controls both the data and its manifest can produce a new matching digest. Keep an independently trusted copy of the original SQLite snapshots for reconciliation and cutover. Portable JSON contains readable planning data and belongs in access-controlled storage. [Rehearsal](v2-legacy-import.md) · [Backup handling](backup-restore.md)
