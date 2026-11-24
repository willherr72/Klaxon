# Klaxon 2.0 progress

Baseline c89b655 (v0.11.1). Development branch `v2`. Opened 2026-11-23. P0 is in progress. Will reports that physical Android synced with Windows powered off. Dot also passed a one-time scheduled browser read/write with Windows off. P1 remains queued while native sessions, physical reminders and the remaining Dot checks are open. See the [remaining tests](#remaining-p0-tests). [Draft PR 14](https://github.com/willherr72/Klaxon/pull/14) collects initial discovery and spike evidence.

## Remaining P0 tests

**P0-03 desktop-off smoke passed, owner-reported November 24, 2026.** Will signed in on both clients and created a synthetic task. He reported fully shutting down and unplugging Windows, reopening the client and signing in on Android over an independent network, renaming the task and confirming the save. After restarting Windows, he saw the renamed task there. His report covers one task. The record contains no independent observation, exact timing, task ID, browser/build version or extended disconnect/reconnect evidence. The [extended device procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance) remains available if those details become necessary.

| Gate | Evidence already available | Next test and stop condition |
|---|---|---|
| P0-03 native session | Browser refresh/revocation and intercepted recovery tests pass. Packaged fixtures retain a local row across restart. The account client requires sign-in after reload. | A packaged client with OS-protected session storage is needed on Windows and Android. Using an enrolled disposable account, restart, verify authenticated access, exercise expiry/refresh, then sign out and check that relaunch requires login. Keep the auth decision open if storage is absent or a revoked session still works. |
| P0-06 ordinary reminders | The physical sync smoke exercised task editing. Windows and Android notification delivery remain unmeasured. | A disposable push subscription, working sender and actual Windows/Android targets are needed. Record visible delivery, overdue recovery and duplicates across the [device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery). Stop before choosing a delivery route if only a provider acknowledgment is available. |
| P0-04 owner Dot | Scheduled browser fallback passed once with Windows off (owner-confirmed). Dot restored the verified client after the prior tab and preview were lost, signed in, saw a connected subscription and renamed exactly one pre-staged synthetic task. A fresh server read at 2026-11-24 16:31:38 UTC confirmed the same ID and new title. Will independently reported seeing the result on Android and Windows. | Remote MCP, scoped agent identity, audit attribution, idempotency receipts and expiry/revocation remain unverified. The browser smoke needs no repeat. See the [Dot playbook](dot-playbook.md#scheduled-browser-fallback) for the managed-preview caveat and evidence limits. |

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
- P0-07. [Architecture ADR](adr/p0-architecture.md), [cost](deployment.md), [security](security.md), [API boundary](api/README.md). The owner confirmed Free for the spike. Native session persistence and notification delivery still need evidence.

## Backlog register

| ID | Planned PR scope | Status | PR / verification |
|---|---|---|---|
| P0-01 | Baseline | Inventoried | [Test results and historic CI failures](testing.md) |
| P0-02 | Isolation | Complete | v2 branch and disposable hosted Development deployment in owner-confirmed Free team. Preflight returned zero tables and zero functions. Only synthetic fixtures enrolled. [PR 14](https://github.com/willherr72/Klaxon/pull/14) |
| P0-03 | Auth/realtime spike | Owner-reported desktop-off smoke passed | [Owner report and remaining tests](#remaining-p0-tests). [Browser and emulator probes](../spikes/p0/README.md) passed. Secure native session persistence is open. |
| P0-04 | Dot spike | Scheduled browser read/write passed with Windows off | [Observed run and outstanding checks](dot-playbook.md#scheduled-browser-fallback) |
| P0-05 | Integrations | Interfaces reviewed | [Scopes and unresolved tenant consent](adr/platform-capabilities.md) |
| P0-06 | Reminders | Device tests pending | [Push matrix](adr/platform-capabilities.md). Physical Android push remains unmeasured. |
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
