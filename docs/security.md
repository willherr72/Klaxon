# P0 security decisions

Derive owner and actor on the server. Bind child and referenced records to the same workspace. Make revision checks, receipt writes, domain changes and attributed audit events atomic. Reject a reused operation ID with a different payload. Test unauthenticated reads, cross-owner references and revoked credentials against actual entry points.

Native OAuth callbacks require state and PKCE checks. Keep tokens out of logs, URLs, synced vault settings and portable exports. Hash agent bearer tokens; protect provider refresh tokens with an approved secret store. Validate webhook authenticity and replay behavior. Treat imported descriptions as data. Tenant approval and a bounded metadata policy precede employer connections. Record residual risks and review credential storage on actual devices before P1 approval.
Reauthorize each request before receipt lookup or replay. Scope receipts by workspace, actor and operation ID. Compare the canonical operation including action, target and payload before returning a prior result. Test revoked identities and identical operation IDs from different workspaces.
