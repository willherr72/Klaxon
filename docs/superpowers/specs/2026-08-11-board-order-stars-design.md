# Tasks Board: Persistent Card Order + Star Priority (v0.8.0)

**Date:** 2026-08-11
**Status:** Approved design, pre-implementation
**Target release:** v0.8.0 (wire-format break — both devices must update)

## Context

v0.7.5 made long lanes scrollable and gave touch a 200 ms hold-to-drag.
Two gaps remain on the Tasks board:

1. **Drag order doesn't persist.** Lane order is derived `updated_at
   desc`, and every drop calls `set_task_lane`, which bumps
   `updated_at` — so any dragged card snaps to the top of its lane once
   the derive effect re-runs. The drop position is an illusion.
2. **Tasks have no priority control.** `Reminder.priority`
   (`low | normal | high`) exists and syncs, but the editor hides the
   priority selector when `silent` is true — a task keeps whatever it
   was created with, invisibly.

## Goals

- Cards stay exactly where they are dragged, across restarts and
  across devices.
- Tasks show and set a 1–3 star priority (reusing `Reminder.priority`)
  from the card face and the editor.
- A per-lane one-shot "sort by stars" action; drag remains king.

## Non-goals

- No auto-grouping or enforced priority ordering in lanes.
- No new priority field — stars ARE `low/normal/high`.
- Calendar revival, iroh upstream issue: separate efforts (the iroh
  writeup will be drafted for user review; it posts publicly).

## Data model

**Migration 014:** `ALTER TABLE reminders ADD COLUMN task_sort_key
REAL` (nullable; meaningful only for tasks).

- Lanes render **ascending** — smallest key at the top.
- **Backfill:** per lane, walk today's visible order (`updated_at
  desc`) assigning 1024, 2048, 3072, … so nothing visibly moves on
  upgrade.
- **New tasks** (create with a lane, or lane assigned later without an
  explicit position): key = `min(lane) − 1024`, or 1024 in an empty
  lane — new tasks land on top, preserving current feel.

## Backend commands

**`place_task(reminder_id, lane_id, before_id?, after_id?)`** — the
only way drops persist. `before_id` = card above the drop position,
`after_id` = card below (both optional at the lane edges). Rust fetches
the neighbors fresh from the DB and computes the midpoint; the frontend
never does float math, so a stale UI cannot corrupt ordering. Also sets
`task_lane_id` (validated, same as `set_task_lane`) for cross-lane
drops — one record written per drag. Edge cases:

- top: `after.key − 1024`; bottom: `before.key + 1024`; empty lane: 1024.
- **Rebalance:** if `after.key − before.key < 1e-6`, renumber the whole
  lane to 1024·n in one transaction, then place. Rare, self-healing.

**`sort_lane_by_stars(lane_id)`** — stable rewrite of one lane's keys:
priority `high → normal → low`, ties keep current relative order.
Renumber to 1024·n; **skip writing rows whose key doesn't change** to
minimize sync churn.

**Lane changes from the editor** (or any update that changes
`task_lane_id` without an explicit position): repo layer assigns a
top-of-new-lane key. The editor already writes `task_lane_id` through
the ordinary update payload — `set_task_lane`'s only caller is the
board, so once the board moves to `place_task`, remove `set_task_lane`.

**Stars need no new backend** — the board and editor set `priority`
through the existing reminder-update path.

## Sync & compatibility

- `task_sort_key` rides inside the reminder record under existing
  record-level LWW (`updated_at` watermarks). Concurrent reorders of
  different cards merge cleanly; same-card races resolve newest-wins,
  like every other field.
- **Accepted risk (pre-existing, not new):** any bulk write
  (`sort_lane_by_stars`, rebalance) bumps `updated_at` on touched rows;
  under record-level LWW a concurrent offline edit to one of those rows
  on the other device can lose. Mitigated by skipping no-op writes;
  accepted for a two-device personal deployment.
- **Wire format:** the postcard `Reminder` payload gains a field —
  pre-0.8 peers fail decode with the existing friendly
  "peer running an older version" error until both devices update.
  Known pattern (0.4→0.5 did the same). Release notes must say
  "update both devices."

## UI

**Card face:** the meta row gains a three-star control — always three
glyphs wide, filled count = priority (low ★, normal ★★, high ★★★),
empty slots faint. High fills in klaxon orange; low/normal muted so a
board of normal tasks doesn't glow. Tapping star N sets that priority
via the normal update path; the tap stops propagation (doesn't open the
editor). Quick taps pass through the 200 ms drag-hold as
svelte-dnd-action's synthesized clicks — verified in the vendored
source — so this works on the Fold.

**Editor:** task mode (`silent`) shows the same star row labeled
PRIORITY, exactly where ringing reminders show signal-light tiers.
Same field, two skins.

**Lane header:** a small sort glyph beside the count badge triggers
`sort_lane_by_stars`; tooltip explains it; no confirmation (cheap to
undo by dragging).

**Board wiring:** `cardsByLane` derives sorted by `task_sort_key`
ascending (fallback `updated_at desc` for null keys, defensive only —
backfill should leave none). `onCardFinalize` reads the dragged card's
new neighbors from the finalized array and calls `place_task`. The
isDragging derive-freeze stays as is.

## Polish pass (short leash)

- Verify drag auto-scroll near the top/bottom edge of a scrolling lane
  (svelte-dnd-action claims scrollable-container support; may already
  work post-0.7.5). Fix configuration if not.
- Nothing else speculative.

## Testing

- Rust unit tests: midpoint insertion (top/bottom/middle/empty),
  rebalance trigger + renumber, stable star sort with no-op skip,
  top-of-lane key on lane change and create.
- Three-DB mesh test extended: `task_sort_key` forwards through the
  watermark path (pin it like the dirty-flag retirement did).
- `svelte-check` stays 0/0.
- Hardware drill on both devices before release: drag persists across
  restart and across sync; stars set from card + editor; sort-by-stars;
  touch scroll still works (regression check on 0.7.5).

## Release

v0.8.0. Changelog entry + release notes with the both-devices-must-
update warning. Same asset-name contract
(`Klaxon_0.8.0_x64-setup.exe`, `klaxon-0.8.0-arm64.apk`).
