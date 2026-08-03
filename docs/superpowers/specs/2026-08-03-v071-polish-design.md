# v0.7.1 Polish — Design

**Date:** 2026-08-03
**Status:** Approved (design conversation 2026-08-03)
**Theme:** user-facing polish + sync politeness. Ships as v0.7.1 — the
first release both devices receive through the in-app update flow.

## Scope (agreed)

1. Peer app-version exchange + stale-peer / outdated-peer warnings
2. What's-new card after an update
3. First-run onboarding card
4. README rewrite (screenshots slots, SmartScreen + Android install
   walkthroughs)
5. Small cleanups: ConfirmModal keyboard accessibility, unused CSS,
   `line-clamp` compat, Tasks-board empty state
6. (Already done: dirty-flag cleanup filed as issue #2.)

Audit findings that shaped scope: recurrence needs no work (editor fully
exposes daily/weekly/monthly/interval against the Rust engine);
`EmptyState` already serves Reminders + Thoughts; svelte-check's 7
warnings are 1 real a11y item + 5 unused-selector + 1 compat nit.

## 1. Version exchange — backward compatible (supersedes the "wire break" plan)

Postcard tags enum variants by index, and every RPC rides its own bidi
stream (`iroh_handler.rs` drops a stream on decode error and keeps
serving the connection). Therefore:

- **Proto:** add *trailing* variants — `RpcRequest::Hello { app_version:
  String }` and `RpcResponse::Hello { app_version: String }`. Existing
  variants encode identically; 0.7.0 peers are untouched unless they
  receive a `Hello`, which costs them one stream, not the connection.
- **Client:** once per sync pass, before other verbs, send `Hello` on
  its own stream. Response `Hello` → record the peer's version. Decode
  error / stream reset / 3 s timeout → record `NULL` ("pre-0.7.1 or
  never asked") and continue the pass normally.
- **Handler:** on receiving `Hello`, record the caller's version and
  respond with our own — both directions learn from one exchange.
- **Storage:** migration 012 — `ALTER TABLE peers ADD COLUMN
  last_app_version TEXT` (NULL = never learned). Updated on every
  successful exchange, both sides.
- **No coordination needed.** 0.7.0 ↔ 0.7.1 pairs sync exactly as
  today; version info appears as devices upgrade.

### Peer-row warnings (SyncSection)

Each peer row gains, under the existing name/status line:

- Version line: `v0.7.1` when known; `version unknown` when NULL.
- **Stale warning** (amber): when `last_synced_at` is older than 72 h —
  "Not synced in {relativeTime}".
- **Outdated warning** (amber): when `last_app_version` is non-NULL and
  semver-older than ours — "Running v{x} — update it on that device."
  (Reuses `updates::compare_versions` via a small command or by
  comparing in JS; the Rust command `list_peers` simply includes the new
  column in `PeerView`.)

Newer-than-us is shown without alarm ("Running v{x}") — the *other*
device nags in that pairing.

## 2. What's-new card

- `CHANGELOG.md` is imported into the bundle at build time (vite `?raw`)
  and parsed in JS: extract the `## [{version}]` section for the running
  version (headline + bullets, rendered as plain text/simple markdown).
- Shown once: settings key `last_seen_version` (device-local) ≠ current
  version → dismissible card at the top of the Reminders view. Dismiss
  (or "Got it") writes the key. Fresh installs write the key silently on
  first launch — a brand-new user gets the first-run card, not release
  notes.
- No network involvement; offline-safe immediately after an update.

## 3. First-run card

- Condition: zero reminders AND zero thoughts AND zero peers AND
  settings key `onboarding_dismissed` unset. (Any real usage anywhere
  suppresses it forever; restore of a backup naturally suppresses it.)
- Replaces the standard `EmptyState` in the Reminders view with a card:
  Klaxon one-liner + two actions — **"Create your first reminder"**
  (opens the editor) and **"Pair your other device"** (opens Settings
  scrolled to Sync). Dismiss ("×") sets `onboarding_dismissed`.
- Copy mentions the hotkey (Ctrl+Shift+K default) on desktop only.

## 4. README rewrite

Structure: what Klaxon is (self-hosted, privacy-first, pure P2P — no
server, no account); feature tour; screenshots (slots at
`docs/screenshots/desktop-main.png`, `phone-main.png`,
`tasks-board.png` — user-provided blank-state captures; text ships
first, images slot in); **install walkthroughs** — Windows: SmartScreen
"More info → Run anyway" with explanation (self-signed installer);
Android: sideload + one-time "allow installs from Klaxon" for future
self-updates; updating (the app updates itself from 0.7.0 on); pairing
quickstart; backups; build-from-source (JDK/NDK notes already there);
privacy model (what leaves the device: nothing but iroh traffic to your
own peers, release checks to api.github.com).

## 5. Cleanups

- `ConfirmModal.svelte:53` — clickable non-interactive element: convert
  to `<button type="button">` (or add keydown Enter/Escape handling if
  it's the backdrop; match the modal's existing interaction pattern).
- Unused CSS selectors (5): **verify before deleting** — the TasksBoard
  `.dragging`/`.hovered`/`.dragging-self` ones may be applied via manual
  DOM manipulation in the DnD code, which svelte-check can't see. Delete
  only what's truly dead; convert genuinely-used ones to `:global` or
  inline `class:` bindings so the warning goes away honestly.
- `line-clamp`: add the standard property alongside `-webkit-line-clamp`.
- Tasks board: when every lane is empty, render `EmptyState` (primary
  "No Tasks", secondary "Silent reminders land here") behind the lanes
  header; per-lane empties stay as-is.

## Error handling

Version exchange failures are indistinguishable from old peers by
design — both record NULL and never block a sync pass. What's-new
parsing failure (changelog section missing) → card simply not shown.
All new settings keys are device-local, never synced.

## Testing

- Rust: proto round-trip test — `Hello` encodes/decodes; a
  pre-0.7.1-shaped decode of a `Hello` envelope fails without
  panicking. Migration 012 test. `list_peers` carries the column.
- JS: changelog-section parser unit-testable shape (pure function).
- Hardware: 0.7.0 phone ↔ 0.7.1 desktop syncs (compat proof), then
  upgrade phone via in-app update → both rows show versions.
  **Desktop's first self-update drill happens with this release.**
- First-run card: verified on a wiped dev profile (temp data dir).

## Out of scope

Paid code-signing cert (decision deferred — README documents SmartScreen
instead); F-Droid; theming; calendar (next arc).
