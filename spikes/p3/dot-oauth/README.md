# Disposable Dot OAuth fixture

Use this fixture only on a new, empty Convex Free Development deployment for one authorized synthetic connector test. The staging script copies the backend and overlays the authorization server and agent gate in the temporary copy. Use the sibling operator workflow for deployment checks, ownership binding, test input, and retirement. [Operator workflow](../dot-operator/README.md)

## Local verification

From the repository root, install the existing backend dependencies and run the fixture check. It type-checks a temporary staged copy and exercises the actual HTTP routes using Convex Test. The test supplies its own generated key and intercepts the MCP verifier's JWKS request locally.

```powershell
npm --prefix apps/backend ci
node spikes/p3/dot-oauth/verify.mjs
```

The staging script accepts one absolute, nonexistent path outside the repository. It copies the backend source and manifests without local environment files, dependency directories, or deployment settings.

```powershell
node spikes/p3/dot-oauth/stage.mjs <absolute-new-temporary-directory>
```

## Operator configuration

If the connector reveals its callback only after discovery, the operator may temporarily set `DOT_OAUTH_SETUP_ORIGIN` to the exact approved bare Convex site origin before enabling OAuth. Use the preregistered public client ID `klaxon-dot-test` with no client secret. On an authorization attempt the setup page shows the connector's proposed public HTTPS callback as plain text. Copy it only after verifying the connector's identity and URL. Setup leaves consent, redirects, token issuance, and OAuth storage inactive. Set the verified callback explicitly for the full flow and remove `DOT_OAUTH_SETUP_ORIGIN` when preparing the approved run.

| Environment variable | Required value |
|---|---|
| `DOT_OAUTH_ENABLED` | `true` after all other settings and the synthetic grant are ready |
| `DOT_OAUTH_ORIGIN` | The approved bare HTTPS Convex site origin |
| `DOT_OAUTH_EXPIRES_AT` | The operator-approved absolute UTC epoch millisecond cutoff, at most one hour ahead |
| `DOT_OAUTH_CLIENT_ID` | The one configured public client identifier |
| `DOT_OAUTH_REDIRECT_URI` | The exact canonical public HTTPS callback shown by that connector |
| `DOT_OAUTH_PRIVATE_JWK` | The locally generated synthetic RSA private JWK, with at least 2048 bits and a key ID |
| `DOT_OAUTH_PASSPHRASE_SHA256` | Lowercase SHA-256 of the high-entropy synthetic passphrase |
| `DOT_OAUTH_REFRESH` | Optional `true` to accept `offline_access` and issue rotating refresh tokens |
| `DOT_OAUTH_WORKSPACE_ID`, `DOT_OAUTH_TASK_ID` | The operator's synthetic public workspace and task IDs |
| `DOT_OAUTH_CREATE_ID`, `DOT_OAUTH_UPDATE_ID` | Two distinct version 4 UUIDs chosen for the exact test operations |

Set Klaxon's OAuth issuer to the bare site origin, its JWKS URL to that origin plus `/dot-oauth/jwks`, and its resource to that origin plus `/mcp`. The operator binds subject `klaxon-dot-fixture` and the configured client ID to one synthetic credential with `tasks:read` and `tasks:write`. The resource metadata advertises exactly those two scopes. The authorization server advertises `offline_access` separately when refresh is enabled.

Generate the RSA key in the operator's private shell. The assignment captures the JWK without displaying it.

```powershell
$env:DOT_OAUTH_PRIVATE_JWK = node -e 'const c=require("node:crypto"); const k=c.generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"jwk"}); process.stdout.write(JSON.stringify({...k,kid:c.randomBytes(8).toString("hex")}))'
$fixturePassphrase = Read-Host "High-entropy synthetic fixture passphrase" -MaskInput
$fixturePassphraseBytes = [Text.Encoding]::UTF8.GetBytes($fixturePassphrase)
$env:DOT_OAUTH_PASSPHRASE_SHA256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($fixturePassphraseBytes)).ToLowerInvariant()
[Array]::Clear($fixturePassphraseBytes, 0, $fixturePassphraseBytes.Length)
Remove-Variable fixturePassphrase, fixturePassphraseBytes
```

Use the operator's private input handling for the key and hash. The owner enters the passphrase on the consent screen after checking the exact client, callback, resource, and scopes. The displayed nonce is single-use and the authorization code requires the client's S256 verifier. The public client sends its configured ID with no client secret.

## Endpoints and evidence

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource/mcp` | Discover the protected MCP resource and its two task scopes |
| `/.well-known/oauth-authorization-server` | Discover the authorization endpoints and supported PKCE method |
| `/dot-oauth/authorize` | Open the reviewed consent page and submit same-origin approval |
| `/dot-oauth/token` | Redeem an authorization code or rotate a refresh token |
| `/dot-oauth/jwks` | Read the public RSA verification key |
| `/dot-oauth/revoke` | Revoke a refresh token family |

The staged MCP server exposes only `list_tasks`, `get_task`, `create_task`, and `update_task`. Its dispatch checks the exact OAuth principal, workspace, task, operation IDs and payload. The allowed scenario lists ready tasks, reads the synthetic task, creates the single ready task, and renames it at revision 1. The staged dispatch uses the existing list handler and refuses any page with an unexpected task, more than one row, or a continuation cursor. Exact retries use the existing actor-scoped operation receipts. The operator workflow independently checks that the deployment recorded the two expected mutations.

Access tokens last up to five minutes within the approved interval. Refresh tokens rotate, replay revokes the family, and the family ends at the approved cutoff. The operator revokes the Klaxon grant for immediate MCP denial and retires the disposable deployment after acceptance. Hosted compatibility still requires the actual connector run. No dynamic registration, account-provider sign-in, or production issuer is included.
