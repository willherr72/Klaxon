# Convex Auth and realtime feasibility

This disposable project uses an anonymous Convex deployment bound to loopback. It creates random synthetic accounts and tasks. It uses the Convex Auth username/password components, an owner-scoped query and two mutations. Each session holds access and refresh tokens in memory. The Svelte component renders the subscribed task list.

## Reproduce on Windows

The Convex backend passed TypeScript 5.9.3 strict checks. Use Node 24, npm, Microsoft Edge and, for the Windows host test, the x64 Evergreen WebView2 runtime with Windows PowerShell. Run these commands from this directory with port 3210 available and a clean shell without Convex deployment or credential overrides.

```powershell
npm ci
$env:CONVEX_AGENT_MODE = 'anonymous'
npx --no-install convex dev --typecheck enable
```

Confirm that the CLI reports a local deployment at `http://127.0.0.1:3210` and that the functions are ready. The probe pins this endpoint. In a second terminal in the same directory, run:

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
