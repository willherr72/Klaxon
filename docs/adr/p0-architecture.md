# P0 architecture decision record

## P0-03 native session candidate

The [approved P0-03 backlog](../../KLAXON_V2_DESIGN_AND_IMPLEMENTATION_PLAN.md#9-implementation-backlog) calls for login, refresh and logout on both native targets. Before wiring a WebView to Convex, test whether a new native process can recover an owner-bound refresh marker and still require provider confirmation before granting access. The Windows candidate uses current-user DPAPI. The Android candidate uses an app-owned Android Keystore key to protect a record in private storage. Access tokens stay in memory. Both routes use OS facilities within the $0 additional budget. [Microsoft ProtectedData](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata) · [Android Keystore](https://developer.android.com/privacy-and-security/keystore)

Use only inert synthetic markers, a temporary store, two fixture owners and a simulated refresh response. Successful refresh may rotate the marker. A transport failure grants no access and permits retry. Expiry clears the record. Logout must survive relaunch, and one owner must never resume from the other owner's record. Keep marker values out of output and plaintext files. Record OS protection, cold-process behavior and provider simulation separately. The portable account client continues to require sign-in on reload.

**Hosted native session prerequisite, November 24.** The packaged command returns a status. The existing Convex HTTP and realtime clients require an access token, and the portable account client also holds the refresh token for rotation and sign-out. The packager restricts the synthetic session build to offline use. Connecting a hosted origin alone cannot establish an authenticated native session. [Account client](../../spikes/p0/portable/account.js) · [Packager](../../spikes/p0/native/package.mjs)

The Windows experiment exercises the option in which native code owns authenticated reads and subscriptions. The WebView receives projected task IDs and titles over Tauri IPC. Native drops the active subscription on sign-out, and the WebView discards replies that were already in transit when the session changed. A Windows process hosting a simulated provider exercises this boundary with no network or added service. [Packaged test and limits](../klaxon-v2-progress.md#packaged-windows-authenticated-task-read-and-subscription)

Production transport remains undecided. Keeping both tokens behind the native boundary requires a provider-compatible native subscription transport, including reconnect and refresh. The alternative supplies a short-lived access token to the supported Convex SDK in WebView memory while native owns refresh and revocation. The next offline comparison is to run the SDK route against intercepted HTTP and realtime responses and use the same owner-switch assertions. Hosted provider authentication and Android task IPC remain separate gates.

## Shared client and backend

Accepted for the spike on 2026-11-23. Retain the existing shared static Svelte/Vite build. Keep native OS services behind Tauri commands. Place the spike in its own package so its dependency graph and generated configuration cannot enter a v1 release. Start with client routing that works with a static host and Tauri asset URLs; test direct task-detail navigation before choosing history fallback or hash routes in P1.

Convex owns online state. An owner-indexed subscription to a bounded task list is the first slice. Resolve the owner from the verified session inside each backend function. Start with Convex Auth; retain this choice only after real login, refresh, logout and reconnect work in Svelte, WebView2 and Android WebView. Capture callback and secure storage behavior on each. A successful local server test cannot prove availability with the desktop powered off.

Keep deterministic integration reconciliation and reminder scheduling in the backend. Give agents scoped, versioned HTTP/MCP access to the same validated domain functions. Select native vs web notification delivery from actual background and closed-app evidence. A provider acknowledgement alone cannot establish that a person received a reminder.

Will's [owner-reported physical smoke](../klaxon-v2-progress.md#remaining-p0-tests) supports keeping Convex for the hosted task spike. Android saved a rename while Windows was powered off, and Windows read it back after restart. Android signed in again after reopening. The native credential-storage decision and the notification delivery decision remain provisional.

Keep v1 authoritative during rehearsal. Use synthetic archives and a disposable workspace. Cross-device reconciliation, restore and explicit owner acceptance precede a change of authority. Running both schedulers on real data would make delivery results ambiguous.

The loopback probe permits synthetic password registration and keeps tokens in memory. Before a hosted test, restrict enrollment to disposable test identities, use HTTPS and confirm the team is Free. The P1 auth decision depends on reload, expiry, concurrent refresh and revocation in actual clients. Keeping the same UI code does not make browser storage or native callbacks equivalent.
