# P0 architecture decision record

Accepted for the spike on 2026-11-23. Retain the existing shared static Svelte/Vite build. Keep native OS services behind Tauri commands. Place the spike in its own package so its dependency graph and generated configuration cannot enter a v1 release. Start with client routing that works with a static host and Tauri asset URLs; test direct task-detail navigation before choosing history fallback or hash routes in P1.

Convex owns online state. An owner-indexed subscription to a bounded task list is the first slice. Resolve the owner from the verified session inside each backend function. Start with Convex Auth; retain this choice only after real login, refresh, logout and reconnect work in Svelte, WebView2 and Android WebView. Capture callback and secure storage behavior on each. A successful local server test cannot prove availability with the desktop powered off.

Keep deterministic integration reconciliation and reminder scheduling in the backend. Give agents scoped, versioned HTTP/MCP access to the same validated domain functions. Select native vs web notification delivery from actual background and closed-app evidence. A provider acknowledgement alone cannot establish that a person received a reminder.

Keep v1 authoritative during rehearsal. Use synthetic archives and a disposable workspace. Cross-device reconciliation, restore and explicit owner acceptance precede a change of authority. Running both schedulers on real data would make delivery results ambiguous.

The loopback probe permits synthetic password registration and keeps tokens in memory. Before a hosted test, restrict enrollment to disposable test identities, use HTTPS and confirm the team is Free. The P1 auth decision depends on reload, expiry, concurrent refresh and revocation in actual clients. Keeping the same UI code does not make browser storage or native callbacks equivalent.
