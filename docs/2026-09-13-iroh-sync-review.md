# Iroh sync reliability review

Reviewed 2026-09-13 against commit `b2c3f81ca04537678c0da4255db62db71f05eba9` (v0.10.2).

This is an investigation and proposed follow-up scope. The improvements below are not part of v0.10.2. That release fixes recurring-reminder decoding and was verified syncing between the upgraded phone and desktop.

## 1. High priority: separate delivery cursors from wall-clock timestamps

Evidence: `src-tauri/src/sync/task.rs:624`, `:645`, `:684`; `src-tauri/src/db/thoughts.rs:194`; `src-tauri/src/db/reminders.rs:387`.

Push selects rows newer than `last_push_at`, releases the database lock while sending, then advances that cursor to the greater of the receiver's acknowledgment time and the newest transmitted row. An edit made during that network round trip can fall behind the new cursor despite never being sent. Receiver clock skew can widen this gap. Another device pulling the sender may recover the edit, but this is not a reliable delivery guarantee.

An isolated in-memory SQLite model using the production `updated_at > ?1` predicate reproduced this sequence:

1. The outgoing snapshot contains a row timestamped 1000.
2. A local edit timestamped 1100 arrives while the snapshot is in flight.
3. The receiver acknowledges at 1200; the sender records cursor 1200.
4. The next outgoing selection excludes the unsent edit at 1100.

The same model confirmed that an offline change arriving through another peer with timestamp 900 remains invisible behind cursor 1200. Preserving an origin timestamp is useful for conflict resolution, but it does not identify when a change became available on the forwarding device. Existing three-device tests start their pulls at zero, so they do not cover this case.

Recommended design: give locally created and successfully imported changes a monotonically increasing local revision, committed with the data. Exchange opaque source revision cursors; advance only to the revision included in the acknowledged snapshot. Keep conflict timestamps separate. Include deletes and all synced entity types. Do not generate revisions for unchanged echoes. Version this protocol and initialize existing pairings through reconciliation so already skipped rows can recover.

Simply replacing acknowledgment time with the maximum transmitted timestamp narrows the push race but does not solve late mesh arrivals, clock rollback, or equal-timestamp edits.

Validation needed: edits during an in-flight push, skewed clocks, equal timestamps, offline A-to-B-to-C forwarding after C already has a nonzero cursor, deletes, restart, and upgrade reconciliation. The reproduction above is a SQL/cursor model, not a full network integration test.

## 2. High priority: acknowledge only durable successful application

Evidence: `src-tauri/src/sync/ops.rs:90` through `:168`; `src-tauri/src/sync/task.rs:516` through `:550` and `:624`.

Incoming Push logs individual database errors and still returns a successful acknowledgment. Pull application discards database errors and advances its cursor. A rejected write can therefore be omitted from future retries. An older duplicate returning `Ok(false)` is harmless and must remain distinct from a real database error.

Recommended design: apply each batch and its cursor update in a transaction. Roll back and return a typed error on any actual write failure; publish UI and alert side effects only after commit. Preserve idempotent retries. Record complete sync success after both directions succeed, or expose separate receive/send status: currently the success timestamp advances immediately after Pull even when Push subsequently fails.

Validation needed: inject a failing write halfway through a batch; prove no partial commit or cursor advancement, then retry successfully. Exercise the production apply function, rather than only a test helper that duplicates it.

## 3. Medium priority: unify foreground, manual, and worker sync scheduling

Evidence: `src/App.svelte:413`; `src-tauri/src/commands.rs:646`; `src-tauri/src/sync/task.rs:270`, `:318`, `:336`, `:394`; `src-tauri/src/mobile_bg.rs:126`; Android `MainActivity.kt`.

Android connectivity callbacks already notify Iroh about network changes. However, bringing the webview to the foreground calls `sync_now`, which directly runs a pass. It bypasses the scheduler's resume/network-change handling and can overlap its regular pass or a warm background worker. Android also excludes the endpoint watchdog entirely. Absence of a mobile recovery path is confirmed in code; a permanently wedged endpoint was not proven to be the cause of this phone's earlier timeout.

Final live observation: the desktop recorded another successful sync at 06:22:25 UTC, then the upgraded phone logged relay loss at 06:22:36 UTC and connection timeouts. At approximately 06:29 UTC, Android reported `mWakefulness=Dozing` and Klaxon's existing process as `top-sleeping`. Its warning log contained no new Postcard decode errors. This establishes that the phone was asleep during the final check; it does not establish a failure to recover after waking. Represent an unavailable sleeping peer separately from malformed-data or storage errors, and test recovery on resume before claiming that recovery is fixed.

Recommended design: route these triggers through one coordinator with at most one outgoing pass per peer. On foreground resume, notify Iroh of potential network change before retrying. Add a bounded, cooldown-protected endpoint health check after repeated foreground failures, rebuilding only when local endpoint failure is established. Preserve endpoint identity and pairings; do not run expensive probes on every background wake.

Iroh explicitly documents Android's need for Java-side network notifications and permits redundant notifications: [Iroh network_change documentation](https://docs.rs/iroh/latest/src/iroh/endpoint.rs.html).

Validation needed: background/foreground on unchanged Wi-Fi, Wi-Fi-to-cellular transition, airplane-mode recovery, simultaneous manual/periodic/worker triggers, and a peer that is simply offline.

## 4. Medium priority: reuse a connection within each sync pass

Evidence: `src-tauri/src/sync/iroh_client.rs:56` through `:145`; `src-tauri/src/sync/task.rs:614`; `src-tauri/src/sync/iroh_handler.rs:47`.

Hello, Pull, and Push each establish a fresh connection inside a shared ten-second pass budget. The server already supports multiple request streams on one connection. This spends extra time establishing connections and creates more opportunities for a transient failure between phases.

Recommended design: start with one connection per pass and a separate bidirectional stream per request. Keep bounded connection and request deadlines, report the failing phase, and reconnect on the next retry. Measure direct and relay latency before adding a long-lived connection cache. Expected performance benefit is an inference, not a benchmark result.

[Iroh's connection documentation](https://docs.rs/iroh/1.0.3/iroh/endpoint/struct.Connection.html#method.open_bi) supports multiple streams on one connection.

## 5. Medium priority: explicit protocol compatibility and useful failures

Evidence: `src-tauri/src/sync/proto.rs:21`, `:139`, `:399`; `src-tauri/src/sync/iroh_handler.rs:61`, `:81`; `src-tauri/src/sync/iroh_client.rs:156`.

The ALPN remains `klaxon/sync/0` across positional Postcard schema changes. Hello exchanges app versions without negotiating a wire version. Decode failures terminate the response stream, which is how the original recurring-reminder error became an unhelpful early EOF on the other device.

Recommended design: negotiate an explicit protocol version or capabilities before sending mutable data. Return a bounded, stable error where the envelope is readable, and use a defined stream/application error for malformed frames. Show an actionable update message for incompatible peers and keep transport timeouts distinct from decoding or storage failures. Remove shared-secret prefixes from diagnostic logging while updating this path.

Validation needed: supported old/new version pairs, all reminder repeat variants, truncated/oversized frames, storage errors, and interrupted responses. Add real endpoint integration coverage in a supported CI environment; the current Windows unit-test loader limitation should not leave transport behavior permanently covered only by manual testing.

## Suggested release order

Prioritize cursor correctness and durable acknowledgments, with an explicit compatibility/migration design. Then ship foreground recovery, coordinated scheduling, and connection reuse. Each user-facing change should receive a newer versioned GitHub release with the signed Android arm64 APK and Windows NSIS installer, as required by `AGENTS.md`.
