# Phase 0 platform capabilities

Provider interface review is complete for the operations below. Tenant-specific authorization, remote MCP execution with a scoped Dot identity and physical-device push remain open. Dot’s scheduled browser fallback passed once with Windows powered off. The prototype may use synthetic fixtures. Work integrations require employer authorization for the intended destination, fields and retention before consent or import. [Scheduled browser fallback evidence](../dot-playbook.md#scheduled-browser-fallback)

| Provider | Initial interface and boundary | Fallback or unresolved test |
|---|---|---|
| Linear | OAuth with read scope for assigned issues. Filter by authenticated assignee and approved teams. Read can authorize more than the imported fields. Bound pagination and reconcile changed issues. [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication) | Tenant consent unverified. Use manually entered authorized links. |
| Outlook | Delegated Graph calendarView with Calendars.ReadBasic for a bounded time window. Persist only intervals and availability by default. Handle exceptions, all-day events and deletions during reconciliation. [Graph calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0) | Tenant consent and approved fields unverified. Enter manual busy blocks. |
| GitHub | Link PRs by URL. For optional private metadata, restrict installation to selected repositories with Pull requests read permission. Check-run data requires separately justified Checks read access. [Pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) · [Checks](https://docs.github.com/en/rest/checks/runs) | Organization approval unverified. Preserve link-only operation. |
| Obsidian | Use a mobile-compatible plugin with vault-relative APIs and a revocable per-device Klaxon credential. Sync only explicitly selected material. Node and Electron APIs are unavailable on mobile. [Obsidian mobile development](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Getting%20started/Mobile%20development.md) | Test on disposable desktop and Android vaults before claiming compatibility. Use manual links meanwhile. |
| T3 | The current tool catalog exposes thread creation and PR linking. Use explicit thread links and a separate revocable Klaxon API credential for later status writeback. | Catalog discovery establishes tool availability here. End-to-end callbacks from T3 to v2 remain untested. Use manual links and status updates. |

## Ordinary reminder delivery

Adopt Web Push as best effort and retain native scheduling as a fallback candidate until device evidence supports removing it. The server owns occurrences. Allocate one delivery route per device and occurrence, invalidate stale revisions, and provide overdue history and visible permission state. A push service accepting a request does not establish that the user saw a notification. [Edge Web Push implementation](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push)

The Android SDK’s adb devices command returned an empty list on this Windows host. The repository has native notification support, but no verified disposable Web Push subscription was supplied. Neither platform has measured delivery results for this run.

| State | Windows Edge / installed PWA | Android Chrome / installed PWA |
|---|---|---|
| App focused | Pending | Pending |
| Background, screen locked | Pending | Pending |
| App window closed, browser permitted in background | Pending | Pending |
| Browser explicitly quit or force-stopped | Pending | Pending |
| Permission denied or revoked | Pending | Pending |
| Offline at due time, then reconnect | Pending | Pending |

For each cell, enroll a disposable browser profile on the actual target and send an ordinary server-originated push using a unique synthetic occurrence ID. Record OS/browser versions, notification and power settings, due time, push-service acceptance, service-worker receipt, observed system notification, acknowledgment and duplicate count. For denial or disconnection, inspect permission status and overdue history after reopening. Repeat with an edited and a canceled occurrence. If closed-app delivery misses the owner’s required window, use reconciled native delivery on that platform and repeat the matrix with duplicates checked. Until then, timing and closed-app guarantees remain unverified.

From the repository root, run `node --test spikes/p0/reminder-evidence.test.mjs` to rehearse how to interpret one occurrence on one device. The synthetic traces distinguish service receipts from observed display, reject duplicate or superseded displays, reject display after cancellation, and require a current overdue history entry after reconnect. All device cells above still require physical observations.

For the permission-denied or revoked row, the offline trace rejects a new Web Push display while permission is denied. To count a fallback observation, the same reopening must show both the denied permission status and an overdue history entry for the current occurrence revision. A new opening or permission change requires fresh observations. The trace exercises the evidence check without changing a browser permission or generating a notification.

See the [Dot playbook](../dot-playbook.md) for the owner-account tests and manual planning fallback.
