# Agent collaboration through MCP

Date: 2026-11-05
Status: proposal; no agent endpoint or model integration is implemented by this change.

## Experience

Connect a preferred agent to Klaxon and ask it to help plan and maintain work:

- “What should I work on today?” reads unfinished tasks, board order, due
  reminders, and the requested day's notes. The agent explains its suggestions
  and links them to actual item IDs. It asks about missing constraints such as
  available time instead of inventing estimates or dependencies.
- “Move the release task ahead of the cleanup task” changes board placement
  and appears in the open app immediately.
- “Move the testing step before publishing, and add a changelog step” edits
  ordered steps inside a task, with per-step completion visible in the app.
- “Remind me tomorrow at 9 to review this” creates a real scheduled reminder
  after resolving the date, time zone, and any ambiguity.
- “Save that as a thought, tagged #klaxon” adds a normal searchable thought.

Start with an external agent connected over MCP. Klaxon supplies context and
actions; the user's chosen model supplies conversation and planning. Embedded
chat can use the same services later, once these interactions work well.

## What exists today

`src/lib/api.ts` exposes typed frontend calls to `src-tauri/src/commands.rs`:
reminders, completion/snooze, task lanes and placement, thoughts and search,
and day notes. Tasks are reminders with `silent = true`; board order uses
`task_lane_id` and `task_sort_key`. Use `place_task` semantics with neighboring
IDs rather than letting a model compute sort keys.

There is no structured subtask/step or dependency model. The requested scope
includes both task cards and ordered steps within tasks. Add a proper ordered
child entity with migrations, sync, deletion behavior, backup/restore, and UI
support. Markdown checklists in a description cannot provide reliable
structured step operations.

Suggested `task_steps` fields are `id`, `task_id`, `title`, `completed`,
`sort_key`, `created_at`, and `updated_at`. Stable step IDs survive reordering;
placement accepts neighboring IDs rather than caller-computed sort keys.
Initially support one level of steps and ordering within a task. Cross-task
moves can be a later explicit operation. Completing all steps should not
silently complete the parent or cancel a reminder; completing the parent should
preserve the step history. The UI needs add/edit/complete/reorder controls so
the user and agent can work on exactly the same records.

Extend the sync journal, snapshot/batch schema, tombstones, and apply logic for
steps. Apply parent tasks before their steps; a deleted parent must suppress
late-arriving child updates rather than resurrect orphan steps. Define and test
concurrent reorder tie-breaking and parent deletion versus step edit. Decide
the wire-version migration explicitly: older devices must not silently discard
steps while claiming a complete sync. Existing task/reminder IDs and pairings
must remain intact, and an old backup should migrate to an empty steps table.

The Tauri invocation API is internal to the app; it is not already an external
MCP endpoint. Command functions combine database writes with scheduler reloads,
UI events, alert cancellation, and sync nudges. A side process writing SQLite
directly would bypass some of those effects.

## Connection and shared services

Suggested path:

`MCP client → klaxon-mcp (stdio) → local authenticated IPC → running desktop app → shared Rust services`

Package a small Rust MCP executable alongside the Windows app. The agent starts
it using standard MCP stdio configuration. Keep stdout exclusively for MCP
messages and send diagnostics to stderr. Use an MCP SDK for initialization,
version negotiation, tool schemas, cancellation, and structured results.

The desktop app owns a local IPC endpoint (a named pipe restricted to the
current Windows user; a user-only Unix socket for development). Enable agent
access explicitly in Settings. Register each client with a revocable local
credential and grant read access or read/write access. Keep credentials out of
synced settings, logs, backups intended for sharing, and examples. OS user
isolation plus the credential is the trust boundary; a client-supplied name
alone is not authentication. No public HTTP listener or additional sync peer
is needed for the initial version.

Extract reusable domain operations from `commands.rs`. Both Tauri commands and
IPC call those operations, with the app retaining its database connection and
scheduler/sync ownership. Allowlist domain operations; never expose a generic
Tauri invocation, SQL, filesystem, shell, settings, or pairing-secret tool.
If Klaxon is closed, return an actionable unavailable error; do not open a
second database writer or silently report success.

Android receives edits through existing peer sync. The desktop must be running
for this connection, and delivery to the phone still requires a successful
sync. Report “saved locally” separately from “synced.” Direct phone chat or a
remote agent connecting without a desktop is a later transport/product choice.

## Initial tools

- `get_planning_context`: bounded snapshot for a specified local date/range,
  containing tasks, lanes, reminders, and day notes, with local time, time zone,
  item IDs and revision tokens. Thoughts are searched explicitly, not dumped
  into every planning request.
- `list_tasks`, `list_reminders`, `get_item`, `search_thoughts`, `get_day_note`:
  filtered/paginated reads with explicit limits and structured results.
- `create_task`, `update_task`, `move_task`, `complete_task`: use the same
  validation and placement/state semantics as the UI.
- `list_steps`, `add_step`, `update_step`, `move_step`, `complete_step`: operate
  on stable child IDs and validate the parent task and neighboring steps.
  Include steps in task detail/planning reads with the same size limits.
- `create_reminder`, `update_reminder`, `snooze_reminder`: use explicit resolved
  times and existing recurrence validation. Return the stored due time in UTC
  and the requested local zone; do not silently choose a daylight-saving
  interpretation or turn an ambiguous phrase into an immediate alarm.
- `create_thought`, `update_thought`, `set_day_note`: save ordinary app content.

Begin with reads plus individual writes. Bulk reprioritization, deletion, lane
deletion, and reminder dismissal can follow once review and undo are usable.
The agent chooses recommendations from context; a tool need not pretend there
is already an authoritative algorithm for “what to work on.”

## Working together without losing edits

Every mutation carries an operation ID so a retried request returns its original
result instead of creating duplicate reminders. Store that receipt atomically
with the mutation. Updates and moves also carry expected revision tokens;
validate them and the write in the same transaction. Reject stale requests with
the current item so the agent can reread and propose again.

The existing sync epoch/journal provides a candidate source of local revision
tokens. Tokens must be invalidated after restore and must cover lane membership
and relevant neighbor order for placement. Wall-clock `updated_at` alone is
insufficient. This guards changes already received locally; it cannot promise
global serial ordering against edits on an offline peer. Existing sync conflict
rules still apply after that peer reconnects.

Make writes visible in an activity list with client identity, affected item,
timestamp, and result. Undo should be a new validated domain operation with
revision checks, not a raw database rollback that overwrites intervening work.
Explicit requests such as “add this thought” can execute under a write grant;
“what should we work on?” should return suggestions without mutating the board.
For a later batch-plan feature, show a concrete preview and commit only the
reviewed operations against the same revisions, atomically.

Treat stored thoughts/descriptions as user data, not instructions that may
expand permissions. Enforce grants and validation in Klaxon, independently of
the model and MCP tool annotations. Reads must exclude device identities,
pairing secrets, backup credentials, and unrelated settings.

## Privacy and delivery

MCP is a protocol, not a model or a guarantee that data stays on the machine.
A hosted agent may send returned tasks and thoughts to its model provider.
Connection setup must explain that explicitly and offer narrow read scopes;
update the README's exhaustive privacy statement when this feature ships.
A local model/client remains an option without adding a Klaxon cloud account.

Implementation milestones:

1. Extract shared services with parity tests for UI events, scheduler reloads,
   sync journaling/nudges, and alert behavior. Add authenticated IPC and read-only
   MCP tools; exercise them against a disposable running app.
2. Add individual writes, persisted operation receipts, revision checks, client
   revocation, and visible activity. Test duplicate retries after lost replies,
   concurrent UI/sync changes, app shutdown, time-zone boundaries, unauthorized
   calls, and real desktop-to-Android delivery/alarm scheduling.
3. Deliver ordered task steps in the UI, storage/sync, and MCP tools. Verify
   reorder convergence, completion, deletion conflicts, old-backup migration,
   and mixed-version device behavior before shipping.
4. Add reviewed multi-item plans and conflict-aware undo. Consider in-app chat
   once external-agent collaboration is working well.

Ship each user-facing increment as a strictly newer version with aligned
package/Cargo/Tauri versions, dated changelog, verified Windows NSIS installer,
and production-signed Android arm64 APK using the existing signing identity.
The current nightly test-helper fix and this proposal do not change app behavior
or require a replacement app binary.
