# Klaxon 2.0 progress

Baseline c89b655 (v0.11.1). Development branch `v2`. Opened 2026-11-23. P0 is in progress. Will reports that physical Android synced with Windows powered off. Dot also passed a one-time scheduled browser read/write with Windows off. P1 remains queued while native sessions, physical reminders and the remaining Dot checks are open. See the [remaining tests](#remaining-p0-tests). [Draft PR 14](https://github.com/willherr72/Klaxon/pull/14) collects initial discovery and spike evidence.

## Remaining P0 tests

**P0-03 desktop-off smoke passed, owner-reported November 24, 2026.** Will signed in on both clients and created a synthetic task. He reported fully shutting down and unplugging Windows, reopening the client and signing in on Android over an independent network, renaming the task and confirming the save. After restarting Windows, he saw the renamed task there. His report covers one task. The record contains no independent observation, exact timing, task ID, browser/build version or extended disconnect/reconnect evidence. The [extended device procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance) remains available if those details become necessary.

| Gate | Evidence already available | Next test and stop condition |
|---|---|---|
| P0-03 native session | Both packaged fixtures resumed inert sessions across fresh processes and remained signed out after logout. Windows WebView2 rejected corrupted DPAPI ciphertext and accepted the restored original. Android preserved its Keystore record through a simulated outage and cleared it on definitive expiry. | Hosted authenticated resume, refresh and revocation through OS-protected storage remain open on both platforms. The portable account client still requires sign-in after reload. |
| P0-06 ordinary reminders | Fourteen offline checks passed. The free HTTPS receiver was provisioned and its link supplied to Will for the [one-time focused test](p0-reminder-owner-test.md). | Await two owner enrollments, private subscription handoff and Will's go-ahead before sending once per target. Physical observations on both platforms remain pending across the [device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery). |
| P0-04 owner Dot | Scheduled browser fallback passed once with Windows off (owner-confirmed). Dot restored the verified client after the prior tab and preview were lost, signed in, saw a connected subscription and renamed exactly one pre-staged synthetic task. A fresh server read at 2026-11-24 16:31:38 UTC confirmed the same ID and new title. Will independently reported seeing the result on Android and Windows. | Remote MCP, scoped agent identity, audit attribution, idempotency receipts and expiry/revocation remain unverified. The browser smoke needs no repeat. See the [Dot playbook](dot-playbook.md#scheduled-browser-fallback) for the managed-preview caveat and evidence limits. |

### One-time reminder sender and receiver rehearsal

Tested source `14404564d7071e48bc397963e161a79c902dc851` on November 24, 2026 with Node 24.12.0. The existing Development record covers task sync in an owner-confirmed Free team. The isolated fixture uses a static HTTPS receiver and an operator-run sender, independent of Convex. This review used repository records and public browser documentation. No live deployment inspection or provisioning took place.

| Command from repository root | Observed result |
|---|---|
| `npm ci --offline --prefix spikes/p0/reminder-push --ignore-scripts --no-audit --no-fund` | Installed the isolated locked dependencies from the local package cache. |
| `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` | 14/14 passed with zero skips. The existing five evidence cases, four sender tests, four receiver tests and one sender-to-worker test ran offline. The pinned library prepared signed, encrypted requests using deterministic dummy inputs. Transport and display calls were fakes. |
| `node spikes/p0/reminder-push/rehearse.mjs` | Two mock 201 responses for the same synthetic occurrence, one per target. Both worker receipt and visible receipt remained unobserved. |

The receiver page also passed an intercepted headless Edge check. A blank public-key configuration stopped before the permission call. With mocked permission, registration and subscription APIs, the page exercised subscription export, receipt lookup and cleanup. Independent review found that a malformed second subscription could consume the one-shot run. The sender now prepares both encrypted requests locally before claiming the run directory. The regression verifies that a preparation error prevents both transport calls and that a claimed or uncertain run cannot be retried in the same directory.

The first physical check will be a manually triggered ordinary reminder on focused Windows Edge and Android Chrome tabs. Record the operator's acceptance status, the worker's receipt timestamp and Will's matching OS observation independently. One matching visible copy per target can close those two cells. Real delivery, timing under background restrictions and production scheduling remain unmeasured. [Owner and operator procedure](p0-reminder-owner-test.md)

On November 24, 2026, Will authorized provisioning. The operator staged the receiver from draft head `955ab8b1092a8a7d7a3510ac72aea9869ad76167` with a fresh disposable VAPID public key and retained the private key outside the served directory. A no-account Cloudflare Quick Tunnel exposed a loopback server restricted to the five static files. Public HTTPS GETs matched all staged bytes, returned JavaScript MIME for both target-specific worker URLs and returned 404 for probes outside the asset list. The temporary link was supplied directly to Will. The host must stay online throughout this focused test. Enrollment, transport, and visible device delivery were still pending at handoff.

### Packaged Android session evidence

Tested source `f7f9feaffbcdf3f5726eb0fed22865fd0f2a7cca` on November 24, 2026. From `spikes/p0`, `node native/package.mjs --target x86_64 --session` built the isolated Tauri debug APK. `node native/smoke.mjs android-session emulator-5576` exited 0 on the disposable Android 16/API 36 x86_64 emulator with WebView 133.0.6943.137, airplane mode enabled and no default network. APK SHA-256 was `e1954dd67af6258b34d1cc9fd501035c8a0665fab7f881600e801f9f279b01f5`. [Build prerequisites and procedure](../spikes/p0/native/README.md#packaged-android-session)

| Fresh Android app process | WebView action and observed result |
|---|---|
| First launch | Resume returned `signed-out`. Starting the fixture returned `fixture-ready` and wrote an encrypted native record. A duplicate start returned only `unavailable` and left the existing session usable. |
| After force-stop | An explicit resume returned `authenticated`. The native simulated provider accepted the decrypted inert marker. Sign-out returned `signed-out` after deletion of the test alias and file. |
| After another force-stop | Resume returned `signed-out` with both the alias and record absent. The app-private no-backup directory was empty. The harness verified the fixture package was uninstalled. |

The harness observed three distinct app PIDs and all six raw Tauri callbacks, including the rejected duplicate start. Each callback contained only its expected scalar status. A control write on each WebView verified the local/session storage event listener. The six session actions produced zero Web Storage writes. After each action, local/session storage, origin cookies, IndexedDB and Cache Storage were empty. The plaintext marker and its tested hex/base64 forms were absent from the inspected DOM, WebView console/errors and 286 app logcat lines across the three processes. The test removed its WebView debug forwards and stopped the emulator.

During harness development Android WebView rejected a browser-wide cookie query. The final test queried cookies for the packaged origin using the page's DevTools session. The standard portable build retained its recorded HTML digest and passed all 11 browser regressions. The standalone Android fixture compiled after sharing its storage code. Its earlier 22-process run is recorded separately below.

Keystore operations, IPC, app restarts and cleanup ran on the emulator. The provider decision ran locally with a fixed synthetic marker.

#### Cold resume during a simulated provider outage

On November 24, 2026, the new outage assertion failed on the previous APK at the first cold attempt (expected `retry-required`). With tested source `bdaffc45cd63e815acb230e601e3fc687ee42d9a`, both commands above exited 0 on API 36 x86_64, WebView 133.0.6943.137, in airplane mode with no default network. The rebuilt APK SHA-256 was `a76dfd2c9c5fb6b471198efa4e99d7bf6766011f1372e5331842b77fd2907026`.

| Fresh app process | Result through the packaged WebView |
|---|---|
| 1 | Confirmed signed out, seeded one native record, then confirmed a duplicate seed was rejected. The harness saved the ciphertext for comparison and enabled the native outage fixture. |
| 2 and 3 | Both cold resumes returned only `retry-required`. Neither granted an authenticated session. After each attempt the encrypted record was byte-identical to the original. |
| 4 | After the harness removed the outage flag, the same Resume action returned `authenticated` without another seed. Sign-out removed the test alias and record. |
| 5 | Cold resume returned `signed-out` and the no-backup directory was empty. |

All eight raw Tauri callbacks matched their expected scalar status. Across five distinct app PIDs, the eight actions triggered zero Web Storage writes. The checked stores and origin cookies were empty after each action. The harness detected no marker in the inspected DOM, WebView console/errors or 482 app log lines. The fixture was uninstalled, its debug forwards were absent and the emulator stopped.

#### Definitive expiry on cold resume

On November 24, 2026 the previous APK failed the new assertion at the first cold resume after simulated expiry (expected `signed-out`). With tested source `f127a8c9f53ec300e8429ce73f588dd7a4eedae7`, both `node native/package.mjs --target x86_64 --session` and `node native/smoke.mjs android-session emulator-5576` exited 0 from `spikes/p0`. The API 36 x86_64 emulator ran WebView 133.0.6943.137 with airplane mode enabled and no default network. APK SHA-256 was `d42ffc4e0757f25f240442bfaff93e68131f27d6ea479ee4693b26bc2a4c51d6`.

| Fresh app process | Observed result |
|---|---|
| 1–4 | Seeded one synthetic session. Two cold outage attempts preserved byte-identical ciphertext, then a recovered provider accepted the same record. |
| 5 | With definitive expiry simulated, resume returned `signed-out` after native code checked both the alias and file were absent. The harness independently observed an empty no-backup directory. |
| 6 | After restoring provider availability, cold resume still returned `signed-out`. Only then did an explicit fresh seed succeed. Seeding refuses to overwrite a surviving alias or file. |
| 7–8 | A cold resume accepted the newly seeded session. Sign-out cleared it and the next cold resume returned `signed-out`. |

Eight distinct app PIDs produced twelve status-only Tauri replies and zero Web Storage writes. The checked stores and origin cookies were empty. The harness found no marker in the inspected DOM, WebView console/errors or 760 app log lines. It uninstalled the fixture and removed the debug forwards. The emulator was stopped. Independent review checked the alias/file assertions and status-only bridge. The provider decision was simulated throughout.

For integration, `npm run build` and `npm run test:portable` from `spikes/p0` built the ordinary offline client and passed 11/11 regressions with zero skips. Hosted refresh/revocation, physical hardware protection and real-device reminders remain open. P1 remains queued.

### Packaged Windows DPAPI session evidence

Tested source `d3fad4fa7dfac0c02fd9144880544910d1f8b52d` on November 24, 2026. From `spikes/p0`, `node native/package.mjs --target windows --session` built the isolated debug executable. `node native/smoke.mjs windows-session` passed on WebView2 158.0.4370.33, including three consecutive final runs. The executable SHA-256 was `754812e84f6c2b8f9f65fd3ff2dc656bad005934b5e6a27513a856d5ccbb45f5`. [Reproduction](../spikes/p0/native/README.md#packaged-offline-client)

| Fresh Windows host and WebView | Result |
|---|---|
| 1 | Empty slot returned `signed-out`. Seed wrote one current-user DPAPI record. A duplicate seed returned `unavailable`. |
| 2 | After the harness altered one ciphertext byte, cold resume returned `unavailable` and left the damaged bytes intact. |
| 3 | Restoring the original bytes allowed a cold resume. The simulated provider accepted the fixed marker. Sign-out deleted the slot. |
| 4 | Cold resume returned `signed-out`. The slot remained absent and the harness removed the entire test directory, including its WebView2 profile. |

Each run checked seven raw Tauri replies, all exact scalar statuses. During the session actions there were zero Web Storage writes and the inspected local/session storage, origin cookies, IndexedDB and Cache Storage were empty. No fixture marker was detected in the ciphertext, inspected DOM, WebView console/errors during the actions, or native stdout/stderr captured from launch through close. This covers completed operations within one Windows user profile. The provider acceptance decision used a local fixture.

The no-handler build failed the first resume assertion. An initial Cargo example failed to start, and a repeated smoke exposed a WebView2 endpoint that could outlive its host. The final fixture uses a dedicated binary and waits for endpoint retirement. It requires a distinct native PID, debugger endpoint and fresh page at every restart.

The unsigned Windows PR job now builds and exercises the session fixture after its ordinary client test. Local integration checks from `spikes/p0` passed: `node native/package.mjs --target windows`, `node native/smoke.mjs windows`, `npm run build` and `npm run test:portable` (11/11). The PowerShell 7 standalone DPAPI suite `node --test spikes/p0/native/session.test.mjs` passed 3/3 from the repository root. The Android x86_64 session APK cross-built with `node native/package.mjs --target x86_64 --session`; no Android runtime was exercised in this change.

The independent P0-06 review found that all remaining matrix rows need a working sender, a disposable subscription and observations on actual Windows and Android targets. The five existing synthetic traces already cover the interpretation of receipts, duplicates, revisions, cancellation, reconnect and denied permission. [Device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery)

### Android Keystore emulator evidence

Tested source `73eb3724be64aa70cc4e3eb44f0be1639de0cec5` on November 24, 2026. Android Emulator 36.3.10.0 ran a fresh Android 16/API 36 x86_64 AVD in airplane mode with no default network. From the repository root, `./src-tauri/gen/android/gradlew.bat --offline --console=plain -p spikes/p0/native/android-session assembleDebug` built the test-only APK. `aapt dump permissions` reported no requested permissions. APK SHA-256 was `7d3d26ae6ee4b4202baf19acc34a22a541c21947efacd55f4a6145f0aa7dce3f`. See the [Android setup and commands](../spikes/p0/native/README.md#android-keystore-lifecycle).

`node spikes/p0/native/android-session/check.mjs emulator-5576` exited 0. Each of 22 instrumentation launches ran under a distinct app process ID. Keystore key creation, AES-GCM encryption/decryption, app-private file I/O, key deletion and cold-process relaunch ran on Android. Refresh and expiry decisions used inert markers and a simulated provider.

| Check | Observed result |
|---|---|
| Cold restart and refresh | An empty slot required sign-in. A simulated outage denied access and preserved identical ciphertext. Retry rotated the marker and a fresh process accepted its new generation. Restoring the earlier ciphertext triggered rejection and removal of that owner's slot and alias. |
| App-user isolation | The second fixture user could not decrypt a copied record using its own key. The bytes were preserved and the first user could still resume. Both users shared one app UID. |
| Sign-out, expiry and cleanup | Signing out the second user removed only its alias and file. The first user resumed. After a new sign-in for the second user, expiry of the first user's marker left the second able to resume. Final sign-out required sign-in on relaunch. A fresh process confirmed both aliases and files absent, and the runner verified an empty record directory and uninstalled the APK. |

An initial offline build failed during resource linking because the standalone project omitted the repository declaration for cached AAPT2. The corrected build used the local cache. The emulator was stopped after package removal. Automatic command review blocked recursive deletion of its temporary host directory, which remains outside the worktree.

The subsequent [packaged Android session run](#packaged-android-session-evidence) verified resume and sign-out through the Tauri/WebView boundary. This run establishes Keystore feasibility under the test APK's UID. Hosted refresh/revocation, physical hardware protection and real-device reminders remain unverified.

### Windows native session and reminder evidence

On November 24, 2026 the new P0-06 permission trace initially failed against the old replay with an unknown event (four passed, one failed). From the repository root, `node --test spikes/p0/reminder-evidence.test.mjs` passed 5/5 with zero skips on `d19810558374b1d9ca9d5abc390f5fad242fbaee`. Independent review found that observing the same denied permission twice could discard valid evidence from the current reopening. The regression now retains that evidence while an actual permission change or another opening requires fresh observations. Provider receipts alone never established display. All Windows and Android device measurements remain pending.

Tested source `d3b90b345fe3dbec5e102344047d12f010b00917` on November 24, 2026, using Node 24.12.0 and Windows PowerShell 5.1. The [candidate decision](adr/p0-architecture.md#p0-03-native-session-candidate) and the [offline probe](../spikes/p0/native/README.md#synthetic-secure-session-probe) apply only to P0. Both new suites now run in the existing unsigned v2 PR workflow.

| Command | Observed result |
|---|---|
| From root, `node --test spikes/p0/native/session.test.mjs` | 3/3 passed, zero skips. Twenty fresh Windows processes exercised DPAPI for two synthetic application owners in one Windows profile. An outage denied access and retained the marker for retry. Successful refresh rotated it. Expired and replayed markers were rejected by the simulated provider. Logout survived relaunch. Copying another owner's ciphertext denied access. Marker checks passed for worker output and UTF-8/UTF-16LE plaintext in the fixture directory. |
| From root, `node --test spikes/p0/reminder-evidence.test.mjs` | 4/4 passed. Synthetic traces rejected duplicate, superseded and canceled displays, distinguished receipts from visible delivery, and required current overdue history after reconnect. The [physical device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) is still pending. |
| From `spikes/p0`, `node --test account-session.test.mjs` | 6/6 intercepted browser regressions passed, covering memory-only reload, failed refresh, late reads and sign-out ordering. |

Independent review found that a failed DPAPI read could discard a recoverable record. The revised worker preserves unreadable ciphertext and returns no session. The reviewer reran the corrected three Windows cases and the four reminder cases. The storage probe exercised local logout only. Packaged Tauri integration and server revocation of a restored native session remain open.

The subsequent [Android Keystore run](#android-keystore-emulator-evidence) exercised the Android candidate. P1 remains queued.

On `94481b40e14ecb2cd06ed6d07162e7c13524c366`, Linux validation passed. All three Windows cases timed out starting their first Windows PowerShell worker, including the empty-slot read. CI skipped the later WebView2 build and smoke steps. The log did not identify the operation that stalled inside the worker. The revised CI command selects the job's PowerShell 7 executable and closes worker stdin. The 15-second per-operation limit and all DPAPI assertions remain active. Locally, `node --test spikes/p0/native/session.test.mjs` passed 3/3 on each host with zero skips. An independent reviewer also ran the PowerShell 7 workflow command. [Failed Windows job](https://github.com/willherr72/Klaxon/actions/runs/45445259790/job/138627783353)

### Local synthetic verification

The November 24 replay used local synthetic data. Baseline source was `25caf30aa406ff2ed9d5882ef443db020fa19ca2`. The added browser regression is in `7caddeb3e4d153ed2aad7966ca0fe18d65a86c96`. The owner report does not identify the artifact revision used on the phone.

| Working directory | Commands | Observed result |
|---|---|---|
| Repository root | `npm run verify -- --frontend` | Version alignment passed, 23 tooling and 65 UI tests passed, zero Svelte diagnostics, Vite build passed. |
| Repository root | `python spikes/migration/probe.py` and `python -m unittest discover -s scripts/tests -v` | Synthetic schema-17 projection, interrupted write, WAL snapshot, truncated backup rejection and intact retry passed. All four Android harness tests passed. |
| `spikes/p0` | With `P0_PUBLIC_DEV_ORIGIN` unset, `npm run build` then `npm run test:portable` | Baseline 10/10, then 11/11 with the new regression. In an isolated browser with intercepted transport, a successful sign-in and task read left local storage, session storage and cookies empty. Reload returned to sign-in with the prior row absent. |
| `spikes/p0` | With Cargo on PATH and `CARGO_NET_OFFLINE=true`, `node native/package.mjs --target windows` then `node native/smoke.mjs windows` | Unsigned fixture built. Windows WebView2 preserved the synthetic ID and renamed title across reload and process restart. Rebuilt EXE SHA-256 was `d62fef96b5a6e2887f86980b296c2a25d72ed4a81808a6ac62adb7e7125aa296`. Embedded HTML matched the prior digest. |
| `spikes/p0/native/.run` | For each retained fixture APK, `aapt dump badging <apk>`, `apksigner verify --verbose <apk>` and `Get-FileHash -Algorithm SHA256 <apk>` | Both package IDs and single ABIs matched, both v2 signatures verified and both hashes matched the [recorded artifacts](../spikes/p0/native/README.md#local-verification-november-23-2026). Static checks only. |

An independent reviewer reran the new regression with `node --test --test-name-pattern "reloading after an authenticated read" account-session.test.mjs` from `spikes/p0` (1/1 passed), verified 42 local documentation links and anchors, and confirmed `git diff --check 25caf30` passed. The review clarified attribution in the Dot playbook.

## Delivery sequence

Each numbered task in [the approved backlog](../KLAXON_V2_DESIGN_AND_IMPLEMENTATION_PLAN.md#9-implementation-backlog) is one planned reviewable PR against v2. The table gives dependencies and the evidence required before advancing. Record the PR URL, tested SHA, commands/results, independent review findings and outstanding blockers here when a unit lands.

| Backlog | Sequence within phase | Acceptance |
|---|---|---|
| P0-01 through P0-07 | Baseline and isolation first. Auth/realtime owns shared identity. Investigate providers, Dot and delivery independently. Consolidate evidence in ADRs last. | Two intended devices share a synthetic task with Windows desktop powered off. Record login lifecycle, delivery matrix and Dot results or limitation. |
| P1-01 through P1-09 | Foundation → schema → auth → domain → receipts → subscriptions. Export precedes legacy import. Finish observability before gate. | A03, A04, A17, A19, A20. Reconcile divergent device fixtures. |
| P2-01 through P2-11 | Design primitives before editing/capture and Today. Organization and calendar feed planning. Prove reminder occurrences before delivery. Activity and PWA close phase. | A05–A11, A22, A24. Keyboard and touch walkthrough on target clients. |
| P3-01 through P3-09 | Versioned API and credentials before MCP. Planning context before atomic apply and autonomy. Verify Dot playbook and daily lifecycle against safety suite. | A02–A04, A07, A17, A18, A22–A24. |
| P4-01 through P4-08 | Connection framework first. Linear import then reconciliation can parallel Outlook reads then reconciliation. Add GitHub, settings and failure suite. | A06, A12–A14, A16. Tenant approval before work data. |
| P5-01 through P5-07 | After P3 contracts stabilize, scaffold plugin, implement live views and capture, test mobile. T3 links first, optional adapter only after supported API proof. Join in cross-client E2E. | A01, A13, A15, A23. |
| P6-01 through P6-06 | After P2 delivery contract, parallel Windows and Android shells. Reconcile alarms if required. Cache reads before evaluating offline writes. Run lifecycle matrix. | A09–A11, A23 plus reboot, logout and upgrade. |
| P7-01 through P7-08 | Assemble CI evidence and independent security/cost reviews. Rehearse migration and rollback before owner acceptance. Owner approval precedes final freeze and cutover. Sign both assets before publishing. Retire Iroh after observation. | A01–A24, zero unresolved critical findings, reconciled archives, actual devices and explicit approval. |

## Decision and evidence log

- P0-01. Baseline architecture and regression evidence belong in [testing](testing.md) and [migration](migration.md).
- P0-02/03. Branch created from the production baseline. Hosted isolation, authenticated web/native sessions and desktop-off synchronization require separate evidence. See [spike](../spikes/p0/README.md).
- P0-04/05/06. Track provider support, actual identity/device observations and fallbacks in the [platform investigation](adr/platform-capabilities.md) and [Dot playbook](dot-playbook.md).
- P0-07. The owner confirmed Free for the spike. A read-only review on November 24, 2026 verified the allowances in the [cost record](deployment.md) against [Convex pricing](https://www.convex.dev/pricing) and [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/). Deployment region, actual shared-team usage and remaining capacity are unverified. Hosted native refresh/revocation, physical delivery and scoped Dot execution remain open. [Architecture ADR](adr/p0-architecture.md) · [Security](security.md) · [API boundary](api/README.md)

## Backlog register

| ID | Planned PR scope | Status | PR / verification |
|---|---|---|---|
| P0-01 | Baseline | Inventoried | [Test results and historic CI failures](testing.md) |
| P0-02 | Isolation | Complete | v2 branch and disposable hosted Development deployment in owner-confirmed Free team. Preflight returned zero tables and zero functions. Only synthetic fixtures enrolled. [PR 14](https://github.com/willherr72/Klaxon/pull/14) |
| P0-03 | Auth/realtime spike | Owner-reported desktop-off smoke passed | [Owner report and remaining tests](#remaining-p0-tests). The [Windows](#packaged-windows-dpapi-session-evidence) and [Android](#packaged-android-session-evidence) packaged synthetic resume/sign-out tests passed. Restoring a hosted account session through either packaged client remains open. |
| P0-04 | Dot spike | Scheduled browser read/write passed with Windows off | [Observed run and outstanding checks](dot-playbook.md#scheduled-browser-fallback) |
| P0-05 | Integrations | Interfaces reviewed | [Scopes and unresolved tenant consent](adr/platform-capabilities.md) |
| P0-06 | Reminders | One-time fixture rehearsed; device tests pending | [Sender and receiver evidence](#one-time-reminder-sender-and-receiver-rehearsal) · [Owner runbook](p0-reminder-owner-test.md) · [Push matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) |
| P0-07 | ADRs | Provisional | [Architecture](adr/p0-architecture.md), [cost](deployment.md) and [security](security.md). Revisit on account/device evidence. |
| P1-01 | Repository foundation | Queued | — |
| P1-02 | Schema | Queued | — |
| P1-03 | Auth | Queued | — |
| P1-04 | Task domain | Queued | — |
| P1-05 | Mutation safety | Queued | — |
| P1-06 | Reactive frontend | Queued | — |
| P1-07 | Export/restore | Queued | — |
| P1-08 | Legacy migration | Queued | — |
| P1-09 | Observability | Queued | — |
| P2-01 | Design system | Queued | — |
| P2-02 | Task editing | Queued | — |
| P2-03 | Inbox/capture | Queued | — |
| P2-04 | Today | Queued | — |
| P2-05 | Organization | Queued | — |
| P2-06 | Calendar | Queued | — |
| P2-07 | Planning constraints | Queued | — |
| P2-08 | Reminder domain | Queued | — |
| P2-09 | Delivery | Queued | — |
| P2-10 | Activity/undo | Queued | — |
| P2-11 | PWA | Queued | — |
| P3-01 | Public API | Queued | — |
| P3-02 | Credentials | Queued | — |
| P3-03 | Remote MCP | Queued | — |
| P3-04 | Context | Queued | — |
| P3-05 | Bulk plans | Queued | — |
| P3-06 | Autonomy | Queued | — |
| P3-07 | Dot playbook | Queued | — |
| P3-08 | Lifecycle | Queued | — |
| P3-09 | Agent safety | Queued | — |
| P4-01 | Connection framework | Queued | — |
| P4-02 | Linear import | Queued | — |
| P4-03 | Linear reconcile | Queued | — |
| P4-04 | Outlook calendar | Queued | — |
| P4-05 | Outlook reconcile | Queued | — |
| P4-06 | GitHub | Queued | — |
| P4-07 | Integration settings | Queued | — |
| P4-08 | Failure testing | Queued | — |
| P5-01 | Plugin scaffold | Queued | — |
| P5-02 | Live task blocks | Queued | — |
| P5-03 | Capture/links | Queued | — |
| P5-04 | Plugin tests | Queued | — |
| P5-05 | T3 access | Queued | — |
| P5-06 | Optional T3 adapter | Queued | — |
| P5-07 | Cross-client E2E | Queued | — |
| P6-01 | Windows | Queued | — |
| P6-02 | Android | Queued | — |
| P6-03 | Native reminders | Queued | — |
| P6-04 | Offline reads | Queued | — |
| P6-05 | Offline edits | Queued | — |
| P6-06 | Lifecycle matrix | Queued | — |
| P7-01 | CI | Queued | — |
| P7-02 | Security review | Queued | — |
| P7-03 | Reliability/cost review | Queued | — |
| P7-04 | Migration rehearsal | Queued | — |
| P7-05 | Owner acceptance | Queued | — |
| P7-06 | Cutover | Queued | — |
| P7-07 | Release/docs | Queued | — |
| P7-08 | Iroh retirement | Queued | — |

## Independent review

Platform reviewer identified ambiguous authorization on receipt replay, inconsistent wording for desktop-off acceptance and missing quota accounting periods. Updated the API/security decisions to reauthorize before replay, aligned the test with physical desktop shutdown and clarified team-wide quota budgeting. At the initial review the CI filters only targeted main. The overnight PR adds unsigned validation specifically for v2.

Correctness/security and regression reviewers found that an initially empty client list could let the cross-owner read assertion pass before the server replied. The revised probe awaits the authenticated query and checks same-owner updates in the rendered Svelte DOM. Independent rerun passed in Edge 158.0.4370.33. The schema-17 projection also passed on rerun.

Local P0-03 results on 2026-11-23: Windows Edge 158.0.4370.33 created a task and Android API 36 emulator Chrome 133.0.6943.137 rendered it. Android refreshed its session and renamed the task. Edge rendered the new title. WebView2 157.0.4341.60 passed the same auth and realtime checks in separate Windows hosts. The backend ran on Windows. At that stage a hosted physical desktop-off run was still needed. Capture actual native auth persistence, physical notification outcomes and Dot access before closing P0.

The Windows Edge and Android emulator Chrome probe passed twice. The final run exited successfully and removed all test ADB mappings. The disposable emulator and local Convex backend were stopped.

Hosted preflight: the owner supplied a Convex deployment. Its cloud version endpoint returned HTTP 200. Its HTTP actions origin returned HTTP 404 with HTTP actions disabled. CLI login status reported no account token. The owner confirmed the Free plan and corrected the deployment classification to Development. This initial preflight used read-only reachability checks. The preflight established reachability only.

Hosted P0-02/03 on 2026-11-23 (Chicago). The scoped CLI identified Development on the owner-confirmed Free team. Preflight found no tables or functions. Deployed only the spike and enrolled two synthetic identities. Verified enrollment is internal, the transient enrollment table is empty, and public signup is denied. Windows Edge, WinForms WebView2 and Android API 36 emulator Chrome verified authenticated task access over HTTPS. Android renamed a shared task with Edge offline and Edge rendered the change after reconnect. All successful runs checked cross-owner denial, logout and revoked refresh. The Android test page was served from Windows. Will subsequently ran the physical smoke described in the [owner report](#remaining-p0-tests).

Independent review found the oldest-first 20-row subscription would hide new tasks on later runs. The probe now subscribes to the latest 20, rejects conflicting platform selections and attempts logout after failures. Initial hosted retries exposed a sign-in failure and a reconnect timeout. The harness now honors the provider’s rate-limit interval and coalesces refresh requests when the live client requests a fresh token. The subsequent Android/Edge run passed. V1 and its release pipeline were outside the change.

Regression check: the default anonymous loopback Edge run also passed local signup, refresh, task propagation, owner isolation and logout after the hosted changes. Its backend was stopped and ports 3210/3211 were clear. Hosted Android cleanup found zero remaining ADB mappings before the disposable emulator was stopped.

## Overnight P0 build and recovery verification (November 23–24, Chicago)

[Draft PR 14](https://github.com/willherr72/Klaxon/pull/14) started the overnight run at `92a809480910eb37c9f1b3af4a36d2b63aec885e` against `v2` at `c89b655a4e04c38cc8155a8e76a977d156942727`. The production app, releases and signing workflows are outside this patch. All new execution evidence for this run used local synthetic fixtures or intercepted test responses. The earlier hosted evidence above is from the prior run.

| Revision | Command / environment | Outcome |
|---|---|---|
| `8319d29` | `python spikes/migration/probe.py`, Windows Python 3.14 | Schema-17 projection, snapshot during a pending WAL transaction, rejection of truncated backup and successful retry from intact snapshot. |
| `967a63e` → `7bb253c18529edf25943fb5f4c1d5cf292bc8c16` | From spikes/p0, `npm run build` then `npm run test:portable` | First run exposed a loopback origin that the destination test expected to reject. Restricted account builds to a bare HTTPS Convex origin. Four browser tests passed locally. Early Actions runs were superseded during development. |
| `fd86b4052e5896d906a61a73ed4b7bcd253d00b3` | V2 PR workflow on standard GitHub runners | Linux builds the portable HTML, runs the v1 frontend/tooling checks, Android harness units, migration probe and Chromium tests, and attaches the browser-tested HTML for one day. Windows compiled the isolated Tauri executable. Its WebView2 debugging socket never appeared on the 2025 runner, so that smoke failed. [Run 45335918821](https://github.com/willherr72/Klaxon/actions/runs/45335918821) |
| `148e70a85911715e7cd814a7b097bd2503b5e159` | From spikes/p0, `npm run build` then `npm run test:portable`, Windows Edge | Eight browser tests passed. Independent review found duplicate local creates after a corrupt-row readback, a stopped subscription after refresh failure, and stale HTTP results crossing an account change. Regression coverage includes quota exhaustion, retained drafts, corrupt-row repair, failed sign-in, interrupted refresh and late reads. Account tests intercept traffic before loading the page. |

The local root `npm run verify -- --frontend` passed 23 tooling tests and 65 UI tests, zero Svelte diagnostics and a successful build. For independent testing on another computer, use [Dot's fixture exercise](dot-playbook.md#independent-portable-client-exercise-for-dot). The [physical test procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance) requires an independently available enrolled-account client, a real Android device with its own internet connection, and the Windows PC powered off. The fixture artifact has device-local storage and can be exercised without an account.

P1 remains queued. The [remaining tests](#remaining-p0-tests) cover device notifications, native sessions and owner-authorized Dot acceptance. Independent fixture testing on Dot's cloud computer can proceed now. Production cutover and employer connections remain outside P0.

### Native packages and follow-up checks

- Source `0c76ddc9c58f38993cce5e9735abe19de2be7378` passed all **10** portable browser tests under `npm run test:portable`. Five exercise the actual bundled SDK against intercepted HTTP/WebSocket responses. They cover both orderings of failed refresh vs failed sign-out, safe reauthentication after refresh failure, rejected verification and isolation of late reads. The other five cover artifact boot, disconnected persistence, invalid origins, failed sign-in, quota failure and corrupt storage. An independent reviewer reran all ten.
- Source `de76b20778d016da32d9c306ff73318b1ca0c9b1` contains the revised Windows CI runtime check and native packaging. The Windows job now selects the standard 2022 runner, verifies that the Microsoft runtime is installed and checks either supported debug-port file location. Actions run results are attached to the [draft PR checks](https://github.com/willherr72/Klaxon/pull/14/checks). The first 2025 runner failure and its Linux artifact remain in [run 45335918821](https://github.com/willherr72/Klaxon/actions/runs/45335918821). That Linux artifact was independently downloaded and cold-opened in offline Edge, then tested for create and reload.
- Reproduce the Windows executable, Android x86_64 emulator APK or arm64 APK from `spikes/p0` using `node native/package.mjs --target windows`, `--target x86_64` or `--target aarch64`. These packages use the separate `dev.klaxon.p0native` application identity. See [native prerequisites and smoke commands](../spikes/p0/native/README.md). Use [the account-mode build and physical-device protocol](../spikes/p0/portable.md) for a future authorized test. A locally stored task with the same ID after a restart verifies fixture persistence only.

Local native build evidence for source `4490cfc587e2366d79ca8a0435b06a8f3079e9b3`:

| Fixture | Local SHA-256 | Evidence |
|---|---|---|
| Portable HTML | `19ce40ffabe6a07e504c44144a55e24e975a8b8f74162daa4944e86a3278796f` | Independent builds of dist/index.html and native/.frontend/index.html matched. The fixture forbids network connections in its content security policy. |
| Windows x64 EXE | `debd90f919e252fea6bfba5153969b4f0529762ce1b3c62c08e4b89749e11cf9` | Authenticode status NotSigned. `node native/smoke.mjs windows` exercised create, rename, read, reload and process restart in a temporary WebView2 profile. |
| Android x86_64 APK | `c875ada4874723e3b0111d31b844e0fd177900e1b6ec93a2b0dc9b41876951f2` | Disposable API 36 emulator, airplane mode, no default network. `node native/smoke.mjs android emulator-5588` exercised the UI, force-stop and relaunch. |
| Android arm64 APK | `e01763928c28f9b77fa70aae39c1f72c48383798aea9bc2eb60323301ad507ee` | Built locally. Android build tools confirmed dev.klaxon.p0native and arm64-v8a. Physical install and execution pending. |

Both APKs are debug packages for the spike, with a test signing identity. The build now starts from a fresh APK output and the smoke verifies the selected fixture artifact. Package digests identify these local files. Rebuilds using a different debug certificate or native toolchain can differ. Frontend source, fixture protocol and native wrapper are versioned in the draft PR. Production signing, release and device migration were not exercised.

Final cleanup: the smoke uninstalled the test package, removed its debug forwards, stopped the disposable emulator and removed its Windows WebView2 profiles. Automatic approval review blocked recursive deletion of the stopped AVD directory under Windows Temp. The retained synthetic directory is outside the repository.
