# Convex Auth and realtime feasibility

The default probe uses an anonymous Convex deployment bound to loopback and creates random synthetic accounts and tasks. Hosted mode uses privately enrolled synthetic accounts. It uses the Convex Auth username/password components, an owner-scoped query and two mutations. Each session holds access and refresh tokens in memory. The Svelte component renders the subscribed task list.

## Reproduce on Windows

The Convex backend passed TypeScript 5.9.3 strict checks. Use Node 24, npm, Microsoft Edge and, for the Windows host test, the x64 Evergreen WebView2 runtime with Windows PowerShell. Run these commands from this directory with port 3210 available and a clean shell without Convex deployment or credential overrides.

```powershell
npm ci
$env:CONVEX_AGENT_MODE = 'anonymous'
npx --no-install convex dev --typecheck enable
```

Confirm that the CLI reports a local deployment at `http://127.0.0.1:3210` and that the functions are ready. The probe uses this endpoint when P0_CONVEX_URL is unset. In a second terminal in the same directory, run:

```powershell
node probe.mjs
node probe.mjs --webview2
```

The browser probe opens three isolated headless Edge contexts. The host probe starts three independent Windows Forms WebView2 processes with temporary profiles and verifies the downloaded Microsoft WebView2 SDK package against its pinned SHA-256 digest. Both use the same Svelte component and browser JavaScript. Stop the Convex CLI with Ctrl+C when testing is finished. Deployment state and generated files are ignored by Git. Synthetic rows persist locally across reruns.

## Observations

| Client | Verification |
| --- | --- |
| Microsoft Edge 158.0.4370.33 on Windows | Passed the browser flow below |
| Microsoft WebView2 157.0.4341.60 on Windows | Passed the same flow in standalone WinForms hosts |

Each run verifies signup and separate login for the same account, explicit refresh token rotation and continued authenticated access. A second account receives an empty authenticated task list and cannot rename the first account's task. After the first client creates a task, the second renders its stable ID and title. The second renames it and the first renders the new title without reloading. For each session, logout invalidates the signed-in check and subsequent refresh.

The package lock fixes Convex 1.51.0, Convex Auth 2.1.0 and Svelte 5.59.1. This flow uses framework-independent Convex APIs with Svelte rendering. Access-token expiry, automatic refresh, persisted sessions, OS secure storage, Tauri packaging and managed HTTPS deployment need their own verification. The Windows host result covers the rendering engine on this PC. It does not exercise the shipping Tauri shell or its origin and CSP configuration.

## Local provider acceptance for an open subscription

Pending owner authorization for temporary test identities and provider-issued sessions. The existing browser probe unsubscribes and closes its socket before sign-out. Its logout result proves explicit access and refresh denial after revocation. The packaged Windows HTTP fixture accepts only fixed inert grants. Running either command above as-is cannot establish what an open packaged subscription receives. [Browser logout](browser.js) · [Windows grant validation](native/src-tauri/src/windows_session.rs)

For the proposed run, use a fresh project directory and isolated CLI state, with no inherited deployment selection, provider credentials or prior fixture database. The spike permits public synthetic signup only when its backend origin is exactly `http://127.0.0.1:3210`. If that port is occupied, stop before startup. The CLI and any cleanup must operate only on state created for this run. Before counting packaged evidence, confirm the native client actually consumes the returned grant and its SDK connects to the intended loopback provider. [Signup guard](convex/users.ts) · [Packager](native/package.mjs)

1. Open two independently authenticated sessions for owner A and one for owner B. Create one synthetic task as A. Both A sessions must render the same ID and title from their subscriptions; B's authenticated read must omit it.
2. Revoke the session whose still-open subscription is under observation, using that session's refresh grant through a separate request. Keep its SDK, cached access token and original subscription alive. Signing out the independently logged-in A control revokes a different session.
3. After acknowledgment, verify the target's existing access token returns false from `isAuthenticated` and no rows from a fresh `tasks.list`. Separately observe the already-open subscription transition from the known nonempty result to an empty result and the rendered row disappear. Rename the task from the surviving A control and confirm its new title there. Record any disconnect, forced refresh, or local clearing before the transition as inconclusive for uninterrupted subscription invalidation.
4. Confirm the revoked grant cannot refresh, the surviving A control still sees its task, and B still has no access. Close clients, revoke remaining test sessions, stop the disposable backend and remove only its verified test state. Record timestamps, outcomes and cleanup without account names or tokens.

This expectation follows the pinned Auth 2.1.0 implementation: `signOut` deletes the session associated with the submitted refresh token, and `getAuthUserId` looks up the session identified by the access token. The spike's task-list query returns an empty result when that lookup yields no user. Runtime observations for this procedure are still pending. [Task query](convex/tasks.ts)

## Android emulator and Windows Edge

Use a fresh API 36 Google Play x86_64 AVD, boot it fully and open Chrome once. Choose **Use without an account** in Chrome’s first-run screen. Run the local deployment described above. From the spike directory, point the adapter to the disposable device. Substitute its actual serial from `adb devices`.

```powershell
$env:ADB = "$env:LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
$env:KLAXON_PROBE_AVD = "emulator-5584"
node probe.mjs --android-chrome
```

The adapter checks the emulator property, forwards its Chrome debugging socket and reverses two loopback ports for the page and backend. Existing reverse routes cause a setup failure. The probe removes its mappings on exit. Close the disposable AVD after testing.

On November 23, 2026, Windows Edge 158.0.4370.33 created a synthetic task and Android Chrome 133.0.6943.137 rendered it. Android explicitly refreshed its session and renamed the task, and Edge rendered the change. The second account could neither list nor rename that task. Each session logged out and its refresh token was rejected. This exercised the API 36 emulator browser with the Windows host running the backend. Later package and physical-device results are tracked in the [P0 register](../../docs/klaxon-v2-progress.md#remaining-p0-tests).

## Hosted development deployment

Use an empty, disposable development deployment in a confirmed Free team. Enroll two distinct, randomly generated synthetic accounts through the deployment administrator’s internal fixture operation. Keep these accounts dedicated to the probe. Account B must have an empty task list.

In a separate shell, set `P0_CONVEX_URL` to the hosted HTTPS deployment origin and provide the synthetic credentials through process variables `P0_USER_A`, `P0_PASS_A`, `P0_USER_B` and `P0_PASS_B`. Launch the same Edge, WebView2 or Android probe command. The browser bundle includes only the public backend origin. The runner supplies credentials to each test session at runtime. Hosted mode checks that anonymous signup returns the enrollment-required error, then verifies refresh, task propagation, cross-owner isolation and logout. Android uses its own network connection to Convex and an ADB reverse mapping to the local test page.

The probe page and automation process run on Windows. A hosted run here verifies cloud-backed reads and writes while Windows is online. A desktop-off acceptance run requires an independently loaded client on another device.

The internal mutation `authFixtures:enroll` takes `{username, password}` and returns null. Run it using a Development deployment key in the provisioning process. It revokes the session created during enrollment. The marker table must be empty outside this transaction and must be excluded from migration or restore. Verify with `convex data fixtureEnrollments --limit 1`. Start the browser probe in a separate process without a deploy key. Password verification is rate-limited per fixture. The runner honors one short retry interval returned by the provider.

Hosted evidence from November 23, 2026: Edge 158.0.4370.33, standalone WebView2 157.0.4341.60 and Android emulator Chrome 133.0.6943.137 passed login, explicit refresh, owner isolation, subscription updates, logout and revoked refresh against the Free Development deployment. During the Android run, Edge entered offline mode after creating the task. Android renamed it over its own HTTPS connection and Edge rendered the updated title after reconnect. Windows still supplied the emulator and the test page. Will subsequently reported a successful physical Android edit and Windows readback after shutdown and restart. See the [owner report and its limits](../../docs/klaxon-v2-progress.md#remaining-p0-tests).
