# Phase 0 platform capabilities

Provider interface review is complete for the operations below. Tenant-specific authorization, remote MCP execution with a scoped Dot identity and background or closed-app push remain open. Dot’s scheduled browser fallback passed once with Windows powered off. The prototype may use synthetic fixtures. Work integrations require employer authorization for the intended destination, fields and retention before consent or import. [Scheduled browser fallback evidence](../dot-playbook.md#scheduled-browser-fallback)

| Provider | Initial interface and boundary | Fallback or unresolved test |
|---|---|---|
| Linear | OAuth with read scope for assigned issues. Filter by authenticated assignee and approved teams. Read can authorize more than the imported fields. Bound pagination and reconcile changed issues. [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication) | Tenant consent unverified. Use manually entered authorized links. |
| Outlook | Delegated Graph calendarView with Calendars.ReadBasic for a bounded time window. Persist only intervals and availability by default. Handle exceptions, all-day events and deletions during reconciliation. [Graph calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0) | Tenant consent and approved fields unverified. Enter manual busy blocks. |
| GitHub | Link PRs by URL. For optional private metadata, restrict installation to selected repositories with Pull requests read permission. Check-run data requires separately justified Checks read access. [Pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) · [Checks](https://docs.github.com/en/rest/checks/runs) | Organization approval unverified. Preserve link-only operation. |
| Obsidian | Use a mobile-compatible plugin with vault-relative APIs and a revocable per-device Klaxon credential. Sync only explicitly selected material. Node and Electron APIs are unavailable on mobile. [Obsidian mobile development](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Mobile%20development.md) | Manual links passed in disposable Windows and Android emulator vaults. Plugin credentials and automatic rename handling remain open. |
| T3 | The current tool catalog exposes thread creation and PR linking. Use explicit thread links and a separate revocable Klaxon API credential for later status writeback. | Catalog discovery establishes tool availability here. End-to-end callbacks from T3 to v2 remain untested. Use manual links and status updates. |

## Obsidian note links and credentials

Store the logical vault alias and normalized vault-relative note path. On each device, map that alias to its local vault, retain the exact local vault name or ID returned by Obsidian, then build an `obsidian://open` link with separately percent-encoded `vault` and `file` values. Obsidian assigns each folder on a computer its own vault ID. A copied vault can therefore need a different local mapping. A note rename also needs to update the saved relative path or resolve a plugin-managed stable identifier. [Obsidian URI reference](https://obsidian.md/help/uri)

The plugin settings can hold the name selected through `SecretComponent`. At use time, `app.secretStorage.getSecret(name)` retrieves the value for that vault or returns null. This is a store shared by plugins, so the Klaxon grant still needs narrow permissions and independent per-device revocation. Desktop 1.11.5 documents OS-backed encryption on disk. Android storage behavior and actual revocation remain open. [Obsidian secret storage guide](https://docs.obsidian.md/plugins/guides/secret-storage) · [Desktop encryption change](https://obsidian.md/changelog/2026-01-20-desktop-v1.11.5/)

Windows Obsidian 1.12.7 opened the intended Markdown note via an explicit URI delivered to the app using its disposable profile. The fixture switched to a control note, opened the selected note, renamed it through Obsidian, switched away, and opened the renamed note with the updated relative path. The vault ID stayed the same. This supports manual path reconciliation. On Android 1.15.1, implicit `ACTION_VIEW` opened the correct same-path note across two app-storage vaults, including cold launch. The locator copied by Obsidian preserved a significant trailing space. A trimmed locator still dispatched but left the previous note visible. Android also reopened the renamed note after manually updating the path. Klaxon's launch path, Windows OS-wide dispatch, automatic rename tracking and plugin credential storage and revocation still need their own evidence. [Android rehearsal](../klaxon-v2-progress.md#obsidian-android-note-links) [Desktop rehearsal](../klaxon-v2-progress.md#obsidian-desktop-note-links)

## Ordinary reminder delivery

Adopt Web Push as best effort and retain native scheduling as a fallback candidate until device evidence supports removing it. The server owns occurrences. Allocate one delivery route per device and occurrence, invalidate stale revisions, and provide overdue history and visible permission state. A push service accepting a request does not establish that the user saw a notification. [Edge Web Push implementation](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push)

For the one-time focused run on November 24, 2026, both push services returned HTTP 201. Will confirmed the matching worker receipt and one visible OS notification on each device, then reported removing both test subscriptions. Worker receipt and first-seen timestamps remain unrecorded. [One-time owner runbook](../p0-reminder-owner-test.md)

| State | Windows Edge / installed PWA | Android Chrome / installed PWA |
|---|---|---|
| App focused | Pass, one visible copy (owner report, Edge tab) | Pass, one visible copy (owner report, Chrome tab) |
| Background, screen locked | Inconclusive for visible delivery. HTTP 201, one matching Edge worker receipt, display request resolved. Owner did not see the notification and reported a gap in observation. | HTTP 201, with worker receipt and owner observation pending. |
| App window closed, browser permitted in background | Pending | Pending |
| Browser explicitly quit or force-stopped | Pending | Pending |
| Permission denied or revoked | Pending | Pending |
| Offline at due time, then reconnect | Pending | Pending |

For each cell, enroll a disposable browser profile on the actual target and send an ordinary server-originated push using a unique synthetic occurrence ID. Record OS/browser versions, notification and power settings, due time, push-service acceptance, service-worker receipt, observed system notification, acknowledgment and duplicate count. For denial or disconnection, inspect permission status and overdue history after reopening. Repeat with an edited and a canceled occurrence. If closed-app delivery misses the owner’s required window, use reconciled native delivery on that platform and repeat the matrix with duplicates checked. Until then, timing and closed-app guarantees remain unverified.

From the repository root, run `node --test spikes/p0/reminder-evidence.test.mjs` to rehearse how to interpret one occurrence on one device. The synthetic traces distinguish service receipts from observed display, reject duplicate or superseded displays, reject display after cancellation, and require a current overdue history entry after reconnect. The remaining device cells still require physical observations.

For the permission-denied or revoked row, the offline trace rejects a new Web Push display while permission is denied. To count a fallback observation, the same reopening must show both the denied permission status and an overdue history entry for the current occurrence revision. A new opening or permission change requires fresh observations. The trace exercises the evidence check without changing a browser permission or generating a notification.

See the [Dot playbook](../dot-playbook.md) for the owner-account tests and manual planning fallback.
