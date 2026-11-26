# Disposable Dot task operator

The operator script stages the existing backend and the sibling OAuth fixture in a temporary directory. The deploy target must be a new Convex Development deployment with zero tables, functions, and configured environment variables. The script checks these conditions before uploading code, then checks the staged database before enrolling the synthetic owner. Use a deployment created for this single exercise.

If the connector reveals its callback only during setup, use `stage-only` on the empty deployment, then `setup-discovery` on that same fixture. This makes the public MCP URL and issuer metadata available. Will can enter the URL, select OAuth, set the public client ID to `klaxon-dot-test`, and copy the exact public redirect URI from the setup page. No task or grant exists at this point. Set the verified redirect URI and the remaining operator inputs, then run `connect`. The private sign-in begins only after the operator confirms readiness. Use `retire` to end setup without issuing a grant.

Run these commands from the repository root before touching the designated deployment.

```powershell
node --test spikes/p3/dot-operator/staging.test.mjs
node spikes/p3/dot-operator/operator.mjs check-stage
```

On Windows with the pinned local Convex binary installed, rehearse against the isolated loopback deployment. The rehearsal checks staged deployment, CLI stdin configuration, actual owner sessions and binding, denial of a valid raw bearer at the staged HTTP route, one task and its exact write replay through the internal handlers that receive verified OAuth claims, and revocation of the grant and owner sessions. Issuer signature verification and the exact MCP operation gate have focused tests in the sibling fixture. Hosted connector authorization and refresh require the actual Dot.

```powershell
node --test spikes/p3/dot-operator/rehearse.local.mjs
```

## Operator inputs

Provide these values through process environment variables using the private operator input already approved for the exercise.

| Variable | Value |
|---|---|
| `KLAXON_DOT_DEV_NAME` | The new disposable Development deployment name |
| `KLAXON_DOT_CONFIRM_FRESH` | The identical name after checking the dashboard |
| `KLAXON_DOT_DEV_KEY` | Its Development deploy key with the matching `dev:<name>\|…` prefix |
| `DOT_OAUTH_CLIENT_ID` | The synthetic OAuth public client identifier |
| `DOT_OAUTH_REDIRECT_URI` | The exact HTTPS Dot callback verified in the owner's connector settings |
| `DOT_OAUTH_PRIVATE_JWK` | The synthetic RSA signing key as one JSON object |
| `DOT_OAUTH_PASSPHRASE_SHA256` | The lowercase SHA-256 hash of the synthetic authorization passphrase |
| `DOT_OAUTH_EXPIRES_AT` | An explicit Unix timestamp in milliseconds setting the cutoff, two minutes to one hour ahead |
| `DOT_OAUTH_REFRESH` | Optional `true` when refresh is in scope |

The command keeps secrets in process memory and pipes OAuth configuration to the pinned Convex CLI on stdin. It prints no deploy key, credentials, passphrase, signing key, token, or raw CLI diagnostic.

```powershell
node spikes/p3/dot-operator/operator.mjs run
```

The operator creates a synthetic owner, its personal workspace, and one expiring grant limited to `tasks:read` and `tasks:write`. It binds the exact fixture issuer, subject, and client ID through the authenticated owner session. The starting task count is zero. The operator verifies discovery and an authenticated MCP initialization before handing off the public URL. Pass the fixture passphrase to the authorized owner through the private channel.

If initialization fails before consent and retirement succeeds, `retry` can recover the same marked owner and workspace. It requires one retired fixture credential, zero owner sessions, an empty OAuth configuration and no task, consent or activity records. It rotates the synthetic owner's password and issues a replacement grant. The first credential stays revoked.

Use only the displayed public fixture ID, operation IDs, titles, and reason. Ask Dot to list ready tasks and observe an empty list. Have it create one ready task with the displayed ID and title, then read it back. Have it call `update_task` with expected revision 1 to change only the title. Then have it retry the exact original create and compare the receipts. That replay should return the original revision 1 receipt, and a subsequent read should show the renamed task at revision 2. Keep the live connector result as evidence for the replay and any refresh exercise.

After the one-task check, enter `VERIFY` at the operator prompt. The script verifies that the deployment contains one task and exactly two operation receipts, and confirms both activity events belong to that grant and were made through MCP. It independently sends a signed synthetic MCP request before and after revoking the credential. HTTP 401 after revocation establishes denial of the same previously accepted token. The operator prompt expires at the fixture cutoff and triggers teardown. The script then pauses with the OAuth routes active so Dot can attempt a denied read before you press Enter to remove the issuer configuration. The independent probe exercises Klaxon's grant check and the Dot read provides the hosted connector evidence.

## Teardown

Press Enter at the prompt to skip acceptance verification and retire. Normal completion and ordinary failures attempt to revoke the grant, invalidate all sessions for the marked synthetic owner, remove OAuth configuration, and remove the marked temporary stage. The operator command prints each cleanup status independently. If the process was interrupted, repeat the designated target inputs and run the recovery command. It validates the staged fixture marker and the synthetic owner's marker before revoking that owner's sessions. It also attempts to clear fixture configuration if revocation fails.

```powershell
node spikes/p3/dot-operator/operator.mjs retire
```

After revocation, remove the synthetic Dot connector and retire or delete the disposable Convex deployment and its deploy key through the owner-approved control plane. This also removes the staged code and synthetic account. The command leaves that final control-plane action to the operator.
