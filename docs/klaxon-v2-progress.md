# Klaxon 2.0 progress

Baseline c89b655 (v0.11.1). Development branch `v2`. Opened 2026-11-23. P0 is in progress. Will reports that physical Android synced with Windows powered off. Dot also passed a one-time scheduled browser read/write with Windows off. P1 remains queued while native sessions, physical reminders and the remaining Dot checks are open. See the [remaining tests](#remaining-p0-tests). [Draft PR 14](https://github.com/willherr72/Klaxon/pull/14) collects initial discovery and spike evidence.

## Remaining P0 tests

**P0-03 desktop-off smoke passed, owner-reported November 24, 2026.** Will signed in on both clients and created a synthetic task. He reported fully shutting down and unplugging Windows, reopening the client and signing in on Android over an independent network, renaming the task and confirming the save. After restarting Windows, he saw the renamed task there. His report covers one task. The record contains no independent observation, exact timing, task ID, browser/build version or extended disconnect/reconnect evidence. The [extended device procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance) remains available if those details become necessary.

| Gate | Evidence already available | Next test and stop condition |
|---|---|---|
| P0-03 native session | Both packaged fixtures resumed inert sessions across fresh processes and remained signed out after logout. Windows WebView2 rejected corrupt DPAPI ciphertext and preserved a valid record through a simulated outage and cold retry. Android preserved its Keystore record through a simulated outage and cleared it on definitive expiry. Windows also passed the [authenticated task read and subscription test](#packaged-windows-authenticated-task-read-and-subscription) against a simulated native provider. Both [Windows](#packaged-windows-dpapi-to-sdk-handoff) and [Android emulator](#packaged-android-keystore-to-sdk-handoff) SDK handoffs passed for reads, subscriptions, outage denial and owner switching with an intercepted provider. Both packages also passed [synthetic access-token replacement](#packaged-sdk-access-token-replacement). Windows passed [refresh-record recovery after process termination](#windows-refresh-record-recovery). The Android emulator passed [failed publication and real writer termination before and after publication](#android-refresh-record-recovery). Both platforms validated synthetic initial grants. Android also passed [initial sign-in process-death recovery](#android-initial-sign-in-to-keystore). Both [Windows](#windows-sign-out-after-a-lost-acknowledgment) and [Android](#android-sign-out-after-a-lost-acknowledgment) recovered from a lost simulated sign-out acknowledgment across restarts. | Hosted authenticated cold resume, token rotation, revocation and reconnect on both platforms remain open. The portable account client still requires sign-in after reload. |
| P0-06 ordinary reminders | Will confirmed one visible notification and the matching worker receipt in each focused client, Windows Edge and Android Chrome. He removed both subscriptions and the operator retired the receiver. Both push services returned HTTP 201. For the later Windows locked-screen attempt, Will read one matching worker receipt with a resolved display request. He did not see the notification and reported a gap in observation. The Windows-only sender regression suite passed 17/17. | Receipt and first-seen times were not recorded. The remaining [device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) covers background, closed, force-stopped, denied and offline states. |
| P0-04 owner Dot | Scheduled browser fallback passed once with Windows off (owner-confirmed). Dot restored the verified client after the prior tab and preview were lost, signed in, saw a connected subscription and renamed exactly one pre-staged synthetic task. A fresh server read at 2026-11-24 16:31:38 UTC confirmed the same ID and new title. Will independently reported seeing the result on Android and Windows. | Remote MCP, scoped agent identity, audit attribution, idempotency receipts and expiry/revocation remain unverified. The browser smoke needs no repeat. See the [Dot playbook](dot-playbook.md#scheduled-browser-fallback) for the managed-preview caveat and evidence limits. |

### One-time reminder sender and receiver rehearsal

Tested source `14404564d7071e48bc397963e161a79c902dc851` on November 24, 2026 with Node 24.12.0. The existing Development record covers task sync in an owner-confirmed Free team. The isolated fixture uses a static HTTPS receiver and an operator-run sender, independent of Convex. This review used repository records and public browser documentation. No live deployment inspection or provisioning took place.

| Command from repository root | Observed result |
|---|---|
| `npm ci --offline --prefix spikes/p0/reminder-push --ignore-scripts --no-audit --no-fund` | Installed the isolated locked dependencies from the local package cache. |
| `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` | 14/14 passed with zero skips. The existing five evidence cases, four sender tests, four receiver tests and one sender-to-worker test ran offline. The pinned library prepared signed, encrypted requests using deterministic dummy inputs. Transport and display calls were fakes. |
| `node spikes/p0/reminder-push/rehearse.mjs` | Two mock 201 responses for the same synthetic occurrence, one per target. Both worker receipt and visible receipt remained unobserved. |

The receiver page also passed an intercepted headless Edge check. A blank public-key configuration stopped before the permission call. With mocked permission, registration and subscription APIs, the page exercised subscription export, receipt lookup and cleanup. Independent review found that a malformed second subscription could consume the one-shot run. The sender now prepares both encrypted requests locally before claiming the run directory. The regression verifies that a preparation error prevents both transport calls and that a claimed or uncertain run cannot be retried in the same directory.

The first physical check used one manually triggered occurrence for focused Windows Edge and Android Chrome tabs. The sender ran at 20:19:05 UTC on November 24, 2026. Each push service returned HTTP 201, and Will reported seeing exactly one notification on each device. Will also confirmed the matching worker receipt on each device and removal of both subscriptions. Both focused cells passed on owner observation. Worker receipt times, first-seen times and elapsed delivery times remain unrecorded. Background delivery and production scheduling remain unmeasured. [Owner and operator procedure](p0-reminder-owner-test.md)

On November 24, 2026, Will authorized provisioning. The operator staged the receiver from draft head `955ab8b1092a8a7d7a3510ac72aea9869ad76167` with a fresh disposable VAPID public key and retained the private key outside the served directory. A no-account Cloudflare Quick Tunnel exposed a loopback server restricted to the five static files. Public HTTPS GETs matched all staged bytes, returned JavaScript MIME for both target-specific worker URLs and returned 404 for probes outside the asset list. The temporary link was supplied directly to Will. After both focused observations and unsubscribe, the operator stopped the tunnel and loopback server, verified the listener was gone and received HTTP 530 from the former link. The private run directory, test key files and both matching Windows Downloads exports were removed. The original Android download was outside operator inspection.

The next physical reminder row is backgrounded Windows Edge and Android Chrome tabs with both screens locked. The [owner procedure](p0-reminder-owner-test.md#two-device-background-procedure-requires-separate-approval) separates visible delivery while locked from receipts and sightings after unlocking. At source `fa4f0d423208085dd62230a10da89d210b1e4939`, `node spikes/p0/reminder-push/rehearse.mjs` returned two mocked HTTP 201 results with both worker and visible receipts unobserved. `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` passed 14/14. The subsequent Windows-only run is recorded below. Android lock-screen delivery remains untested.

For the November 24 locked-screen run, Will confirmed Windows Edge enrollment and reported Windows locked before the send. The agreed earliest unlock was 23:55 UTC. The operator verified the staged page, module MIME types, Windows worker and private-path exclusions via public HTTPS. The sender at `b25365ed8025fd746f2cb59e8924b7bbd6f39390` claimed one Windows attempt. It sent at 23:49:00.400 UTC and recorded HTTP 201 at 23:49:00.660 UTC. Will read one matching worker row, timestamped 23:49:00.689 UTC, with the display request resolved. He did not see a lock-screen notification and reported a gap in observation. Visible delivery by the 23:54:00.400 UTC cutoff is inconclusive. The operator verified removal of the matching Windows export, private sender input and disposable key file. Will confirmed Edge cleared the subscription, fixture worker and local receipts. The operator stopped the tunnel and server, verified the listener, run directory and matching export were absent, and received HTTP 530 from the former receiver URL. Android was outside this run. The offline regression command `node --test reminder-evidence.test.mjs reminder-push/*.test.mjs` passed 17/17 from `spikes/p0`. [Windows-only runbook](p0-reminder-owner-test.md#current-physical-run-windows-edge-screen-locked)

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

### Packaged Windows cold resume during a provider outage

Tested source `62da2285056509ef1e1476ee0e55d1b7ed70ff0c` on November 24, 2026. From `spikes/p0`, with `CARGO_NET_OFFLINE=true`, run `node native/package.mjs --target windows --session` and `node native/smoke.mjs windows-session`. An initial attachment to the old WebView2 binary timed out. The retry reached the expected failing assertion. After the fix, three consecutive runs passed on WebView2 158.0.4370.33. Each used six fresh host processes and nine status-only bridge replies. Executable SHA-256: `84733adcfd245e64225232511d67de9994bb250b749979165ec708cfde053a0d`.

The simulated outage denied resume with `retry-required` and left the valid DPAPI record byte-for-byte intact. A fresh process resumed after simulated recovery without reseeding. Corrupt ciphertext returned `unavailable` with the provider online or offline. Sign-out removed the record and survived the final restart. Web storage, bridge, inspected logs and cleanup checks passed. The ordinary build and regression also passed with `node native/package.mjs --target windows` and `node native/smoke.mjs windows`. The follow-up below exercises an authenticated task read and subscription through an intercepted provider. [Native session boundary](adr/p0-architecture.md)

### Packaged Windows authenticated task read and subscription

Tested source `cbae4a0fff3427dec34a9268dc047dca31b9a2d1` on November 24, 2026. From `spikes/p0` with `CARGO_NET_OFFLINE=true`, run `node native/package.mjs --target windows --session` and `node native/smoke.mjs windows-session`. Two consecutive final smokes passed on WebView2 158.0.4370.33, six distinct host processes and fresh WebViews per run. Session executable SHA-256 `18244831b22dcac25c8d71e6ca2cdab5e40e016c94cb5df93927272daa16e912`. [Reproduction](../spikes/p0/native/README.md#packaged-offline-client)

| Observation in the packaged test | Evidence |
|---|---|
| Cold resume and authorized tasks | Before resume and during a simulated provider outage, native read, subscribe and publish all rejected access. After DPAPI recovery and provider confirmation, A read only A’s task. A channel update changed its title with no additional list reply. |
| Sign-out and queued replies | The runner held a genuine read reply and channel message in WebView2. Sign-out ended A’s specific channel. Releasing the read left the signed-out list empty. Releasing A’s update after B resumed and subscribed left B’s row intact. B’s own subscription then updated it. Final sign-out persisted across another restart. |
| Boundary and cleanup | Raw replies carried allowlisted statuses, channel control data and rows projected to ID and title. Marker checks covered inspected IPC, DOM and logs. Web storage, cookies, IndexedDB and caches stayed empty. The test removed its native record and temporary WebView profile. |

Against the previous binary, the native task command was absent. Removing the WebView session-generation guard caused all four delayed-delivery regressions to fail while both controls still passed. One integration attempt timed out attaching WebView2 before the task assertions. The harness now waits for the previous browser PID to exit before reopening its profile. Both final runs passed. From `spikes/p0`, `npm run build` and `npm run test:portable` passed (17/17, including six task-session tests). The ordinary Windows client passed `node native/package.mjs --target windows` and `node native/smoke.mjs windows`.

Provider authorization and task data were simulated in one native host at a time. The experiment exercised Windows DPAPI, Tauri IPC and the packaged WebView. The follow-up below used the supported Convex SDK with an inert access token and intercepted HTTP and realtime responses. Android task transport and hosted refresh, revocation and reconnect remain open. [Architecture decision](adr/p0-architecture.md#p0-03-native-session-candidate)

### Offline Convex SDK owner switch

Tested source `b9b9d40a2ac79f3f7fc56669ecbaa184446b71bd` on November 24, 2026. From `spikes/p0`, `node --test sdk-task-session.test.mjs` passed 4/4. `npm run build` passed and `npm run test:portable` passed 21/21 with zero skips. The test bundled Convex 1.51.0 and ran in headless Edge 158.0.4370.33 on Node 24.12.0. A fresh offline browser context loaded a locally fulfilled page. It rejected unexpected network requests. [Browser tests](../spikes/p0/sdk-task-session.test.mjs)

- The simulated native source issued an inert access value. The in-process HTTP endpoint selected the owner from the SDK’s bearer header. The realtime endpoint independently checked the SDK’s authentication message and list subscription. Each owner received only their task. A subscription update arrived without another HTTP read.
- Sign-out immediately cleared the view and closed the outgoing socket. Further reads were denied locally. The runner delivered A’s already-decoded read and subscription callbacks after sign-out and again in a separate run with B active. None rendered rows. Disabling the read guard or update guard independently reproduced the matching stale render in both states.
- A delayed native access result could not open an SDK client for A after B resumed. In a separate check, A’s entire HTTP response was held before SDK decoding and released after B resumed. The SDK completed the read and B’s view remained unchanged. Inspected Web Storage, cookies, IndexedDB and Cache Storage were empty at the end of both owner-switch scenarios.

This covers SDK behavior in a browser with simulated native access and provider responses. The experiment used opaque fixture tokens. Signature validation, expiry, hosted refresh and revocation, native IPC and Android execution require other evidence. The packaged Windows follow-up below replaces the simulated native access source with DPAPI and Tauri IPC. [Candidate decision](adr/p0-architecture.md#p0-03-native-session-candidate)

### Packaged Windows DPAPI-to-SDK handoff

Tested source `ba41658d7ad42a24737bae1e320856b7555dc7e2` on November 24, 2026. From `spikes/p0`, with `CARGO_NET_OFFLINE=true`, `node native/package.mjs --target windows --session` built the unsigned executable. Two consecutive runs of `node native/smoke.mjs windows-sdk` passed on WebView2 158.0.4370.33. Each used five fresh native processes and WebViews. Executable SHA-256 `b1243532488eab644eded0a5ef1c22800fd19131ed3e6880ccadfe126e368d82`. [Reproduction](../spikes/p0/native/README.md#packaged-windows-sdk-handoff)

- A new process denied access until native resume verified the protected record. A damaged record opened no SDK socket. Restoring the original ciphertext allowed native code to issue A’s inert access value over Tauri IPC. Convex 1.51.0 used it for an HTTP read and an authenticated subscription. The offline provider selected the owner independently for each transport.
- During a simulated outage, an authentication error on the established socket triggered a real SDK forced-refresh request. Native rechecked the record and denied issuance. The subscription closed, the rows cleared, and the ciphertext remained byte-identical. A fresh process resumed after recovery. Sign-out deleted the slot; a held A read and A update failed to render after logout and peer resume respectively. B could read and receive B’s updates. Another process confirmed sign-out.
- Only the successful access IPC callback could carry the fixture access value. The harness checked the DOM and browser stores while each owner was authenticated, Web Storage writes during actions, WebView and native logs, and the retired profile. Each run scanned 154 files for the tested plaintext and encoded canaries, then removed its temporary directory. No external WebView request was observed during the monitored actions.
- An initial packaged run exposed a same-owner race. A delayed HTTP result could revert a newer subscribed title. A dedicated offline regression reproduced it; the SDK adapter now drops a read that started before a newer subscription update. `npm run build`, `npm run test:portable` (22/22), `node native/smoke.mjs windows-session` (six processes), and `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib sdk_access_rechecks_record_and_revokes_on_failure` (1/1) passed. The ordinary Windows build and smoke also passed with `node native/package.mjs --target windows` and `node native/smoke.mjs windows`. Static asset checks confirmed the default Windows client and Android session page excluded the SDK fixture.

This establishes the Windows package boundary using an intercepted provider and fixed inert access values. Successful token rotation, provider-side revocation, and hosted reconnect still need separate evidence. The next offline platform check is the same SDK handoff through Android Keystore on a disposable emulator. [Architecture decision](adr/p0-architecture.md#p0-03-native-session-candidate)

### Packaged Android Keystore-to-SDK handoff

Tested source `80133deffa27e9228e95cd02015b767d267e7d98` on November 24, 2026. On a disposable API 36 x86_64 emulator with Android System WebView 133.0.6943.137, the packaged Tauri client used Android Keystore and the real Convex SDK with intercepted HTTP and realtime transports. Airplane mode was enabled, Wi-Fi was off, and the emulator had no active default network. Session APK SHA-256 `1e137d8f7d6a68a6555c837b48ae754cb1e831969885d74e1f85609e820a09a0`. [Reproduction and prerequisites](../spikes/p0/native/README.md#packaged-android-sdk-handoff)

| Command from `spikes/p0` | Observed result |
|---|---|
| `node native/package.mjs --target x86_64 --session` and `node native/smoke.mjs android-sdk emulator-5576` | Eight fresh app processes. Native access was denied before resume and on a corrupted record. A and B each received only their own HTTP rows and subscription updates. Queued A callbacks could not restore old rows after logout or overwrite B’s view. B resumed correctly from a cold process. |
| SDK-triggered refresh within the same smoke | A simulated outage denied refresh, cleared the view and closed the socket. The record remained byte-identical across a cold retry, then resumed after recovery. Definitive expiry denied access and removed the alias and file. A later cold resume stayed signed out, and a fresh seed succeeded. |
| `node native/smoke.mjs android-session emulator-5576` | The existing status-only flow passed across eight processes and 12 status replies. Both Android runs uninstalled their test APKs. The operator verified empty ADB mappings and stopped the named emulator. |
| `npm run build` and `npm run test:portable` | 25/25 passed, zero skips. The portable suite now checks the SDK panel’s build isolation and both possible leftover test sources after an interrupted Android build. |
| `node native/package.mjs --target x86_64` and `node native/smoke.mjs windows-sdk` | The ordinary Android APK excluded the SDK command and Kotlin test plugin. The Windows SDK regression passed across five fresh processes. |

The Android harness attributed access successes and denials to their native IPC callbacks, inspected the DOM and browser stores during authenticated use, monitored storage writes, and scanned 796 app log lines and the protected record for known fixture canaries. No canaries were found in those inspected surfaces. The Android check did not scan the full retired WebView directory. Authentication and expiry decisions came from a local fixture using two fixed access values. Successful provider-issued rotation, hosted revocation, and physical-device behavior still need separate evidence.

Independent review found that interrupted staging could leave a Kotlin or Java test file in the Gradle debug source tree. The packager now rejects those leftovers before invoking a build. The two regression tests failed against the previous packager and passed with the fix. The follow-up below checks successful access-token replacement and rejection of the old value by the simulated provider. [Architecture decision](adr/p0-architecture.md#p0-03-native-session-candidate)

### Packaged SDK access-token replacement

Tested source `3ba3f26535974063387eca3e0cabdf0383cc75c8` on November 24, 2026. On each platform, the simulated provider retired A’s first access value during an active subscription. Convex 1.51.0 forced one native refresh, replaced its socket, authenticated and subscribed with the replacement, used it for a task read and rendered a subsequent pushed title. The encrypted native refresh record remained byte-identical. A second simulated expiry during an outage denied access and cleared the rows. The candidate continues to keep refresh material native. [Architecture decision](adr/p0-architecture.md#p0-03-native-session-candidate)

| Commands from `spikes/p0` | Verified result |
|---|---|
| `node native/package.mjs --target windows --session` and `node native/smoke.mjs windows-sdk` | WebView2 158.0.4370.33, five fresh processes. The harness checked the bridge, DOM, browser stores, native logs and 154 retired profile files for the fixture canaries, then removed the run directory. Executable SHA-256 `614874b32b823995ea63e5cd636881ed6f1f01c7308bd65298912850a22fd9e4`. |
| `node native/package.mjs --target x86_64 --session` and `node native/smoke.mjs android-sdk emulator-5576` | Android 16/API 36, WebView 133.0.6943.137, eight fresh app processes in airplane mode with no default network. Inspected the live WebView stores, IPC and 830 app log lines. The runner confirmed alias/file cleanup, APK removal and empty ADB routes. The emulator was stopped. APK SHA-256 `3cb85ac93ba665a95e155570790d4fd5059ea476536071420af807e20509a213`. |
| `npm run build` and `npm run test:portable` | 27/27 passed. A separate headless Edge probe presented A’s old value to the same simulated provider after cutover. HTTP returned 401. WebSocket returned `AuthError` and the query failed. B still received only B’s reads and subscription updates. |
| `cargo fmt --manifest-path native/src-tauri/Cargo.toml -- --check` and `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib` | Formatting passed. The Windows DPAPI unit test passed with both owner records and the outage and replacement flags. |

The first Windows run timed out on the expiry *after* replacement. Headless Edge reproduced it. The SDK reads issuance and expiry claims before scheduling its next refresh. The opaque replacement left it waiting for confirmation, so it ignored the later expiry. The fixture now returns a JWT-shaped value with fixed historical claims and a deliberately invalid signature. The test provider recognizes its digest and the SDK can complete its refresh state transition. A subsequent Windows run timed out attaching the WebView2 debugger during concurrent local builds. After the Android run and emulator shutdown, the same Windows executable passed without a timeout change.

These checks demonstrate the SDK switching its in-memory access value. Immediate rejection of the old value is a rule of the simulated provider. Hosted JWT validity, issuer-side revocation, signature verification, live refresh-token replacement and unattended reconnect remain open. The [Windows refresh-record recovery check](#windows-refresh-record-recovery) below covers replacement of the native record using a simulated provider response. Testing an authorized hosted account and observing background or closed-app reminder delivery require separate owner-assisted runs.

### Windows initial sign-in to DPAPI

Tested source `8beee2d167d630808aba38685dc9e13bb5d2b070` with simulated Convex 1.51.0 mutation responses and Auth 2.1.0 grants. The packaged client accepted the expected owner's completed grant, stored the refresh marker under DPAPI and required an explicit resume before SDK access. A rejected or mismatched grant left both the destination and staging file absent. A second owner's attempt preserved the first ciphertext byte for byte. The Rust test also removed the synced staging file just before first publication and verified that failure left both paths empty.

| Command | Observed on November 24, 2026 |
|---|---|
| `cargo test --locked --offline --manifest-path spikes/p0/native/src-tauri/Cargo.toml --features custom-protocol,p0-session --lib` | 19 passed. One child-process entry point ran through its parent recovery tests. |
| `node --test spikes/p0/native/session.test.mjs` | Three synthetic lifecycle regressions passed. |
| From `spikes/p0`, `node native/package.mjs --target windows --session` followed by `node native/smoke.mjs windows-sdk` | Built offline. The staged Windows harness ran against the packaged executable across eight fresh hosts and WebViews (WebView2 158.0.4370.33). SDK read, subscription, access cutover and sign-out passed. The scan found no recognizable fixture canaries in host output or 154 retired profile files. The harness removed its scoped data. |

Initial sign-in with a hosted provider remains open. The corresponding Android emulator evidence follows.

### Android initial sign-in to Keystore

Tested source `f16f89e8cafa8b5ddec6edea259df5533c366c1e` on November 25, 2026 UTC. Commands below run from `spikes/p0`, except the Gradle command which runs from the repository root.

| Command | Observed result |
|---|---|
| `node native/package.mjs --target x86_64 --session` | Built the debug APK with the fixture signing identity. Local SHA-256 `578b2cbb320ff2c5a95d3f277b0e08ea53e6adf000fdd8b116e02b6d90718d71`. |
| `node native/smoke.mjs android-sdk emulator-5576` | Passed across 23 fresh app processes and WebViews on Android 16, WebView 133.0.6943.137. Checked 2,338 app log lines and scanned 277,197 bytes in 52 retired WebView and cache files for recognizable fixture canaries. |
| `npm run build` and `npm run test:portable` | Build succeeded and 41/41 tests passed, including eight fake-ADB installer regressions. |
| `./src-tauri/gen/android/gradlew.bat --offline --console=plain -p spikes/p0/native/android-session assembleDebug` | The standalone Keystore fixture also built against the shared store. |

The disposable API 36 x86_64 emulator reproduced the original installer exit 255. The package manager reported `Unknown option -` before reading the APK. Removing the trailing dash from `pm install -S <size>` let the same APK install from redirected stdin. The installer keeps a device-side reservation through uninstall. A lost host acknowledgment can be reconciled with the worker's result, while an unresolved attempt prevents another caller from starting a second install.

The packaged Tauri/WebView fixture validated simulated Convex/Auth grants through the shared Rust decoder and Android JNI. A denied grant, a grant with only its owner ID changed, and a failed first publication all denied access. A second owner's grant could not overwrite an existing session. The emulator used real Android Keystore and `AtomicFile`; the issuer and SDK backend responses were synthetic.

Independent review identified a failure between key creation and first publication. After force-stop at the synced staging file, the previous build returned `unavailable` on cold resume. The corrected fixture recovered two separate interrupted sign-ins. Cold resume discarded the orphan and rejected replay of its ciphertext. Direct peer sign-in recovered in a fresh process without an intervening resume. With a valid encrypted record moved to its backup path, resume and sign-in both denied access. Restoring the backup resumed the original owner, proving its key survived. The unrelated control file survived cleanup.

A separate installer check discarded the host acknowledgment after the real emulator accepted the install command. The helper recovered from the device-side result and rejected a competing reservation. The package, reservation and ADB mappings were absent at teardown, and the emulator stopped. Hosted native sign-in, rotation and provider-side revocation remain open.

Both unsigned draft checks passed at `d19ee662320fcf629b67a3b827972bc7c07e3fe3`. The Android emulator results above came from the local run. [CI run](https://github.com/willherr72/Klaxon/actions/runs/45517039441)

### Windows sign-out after a lost acknowledgment

The Convex Auth 2.1.0 `auth:signOut` mutation accepts the refresh token and returns null, including on repeat calls. The packaged Windows client uses the refresh marker from the DPAPI record and writes a local pending flag before contacting the synthetic issuer. Cold resume and new grants require the pending sign-out to finish. After a valid success response carrying an explicit null, it durably records acknowledgment, removes the ciphertext and clears the flag. A later process can finish an acknowledged cleanup while offline. If the ciphertext disappears before acknowledgment, the pending attempt still requires recovery.

The old Windows executable deleted the local record and reported `signed-out` when the regression expected a retry. It had no issuer step. In the new fixture the simulated issuer records revocation, drops the reply and acknowledges a later request using the same protected successor. The test checks which marker the client presented. Convex Auth itself also permits a spent token to revoke its remembered session and returns null for an unknown token.

The portable client previously completed sign-out after a malformed non-null success value. It now retains its in-memory token so the user can retry. The packaged SDK fixture accepts only a fulfilled `signed-out` IPC reply for completion, clears its task list immediately and closes its socket. Concurrent callers share the native attempt.

Tested source `6dabdc69dbb32fd5e9ed03e526a57b3798805cc3` on November 25, 2026 UTC. Both packaged runs used WebView2 158.0.4370.33. The fixture used current-user DPAPI and an in-process issuer. The test did not contact a hosted deployment.

| Command from `spikes/p0` | Observed result |
|---|---|
| `npm run build` and `npm run test:portable` | Build succeeded and all 44 tests passed. The browser retried the same token after a malformed sign-out result. A concurrent SDK resume made no access request after an unacknowledged sign-out. |
| `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features custom-protocol,p0-session --lib` | 26 tests passed. One subprocess entry point ran through its parent tests. The suite covered corrupted or missing ciphertext, a missing acknowledgment after issuer commit, malformed replies, a live native task provider's next access after another process started sign-out, and process termination after acknowledged record deletion. |
| `node native/package.mjs --target windows --session` and `node native/smoke.mjs windows-session` | Built the offline debug executable. Six fresh hosts passed native task and session regressions, including late delivery across an owner change. |
| `node native/smoke.mjs windows-sdk` | Eleven fresh hosts passed. The initiator closed its SDK socket. A cold host denied resume and preserved the identical rotated ciphertext through a second dropped reply. The acknowledged retry removed the protected record, preserved the unrelated file and remained signed out on relaunch. The scan covered 154 retired profile files; the harness also checked native output and removed its fixture. |

### Android sign-out after a lost acknowledgment

Tested source `b9df6fe3a111b6d92fac1fd2fd833ca049a531cf`, November 25, 2026 UTC. The packaged Android 16 x86_64 client used Android Keystore, Tauri IPC and WebView 133.0.6943.137 on a disposable emulator with no default network. The issuer and SDK transports were simulated. The previous APK reported `signed-out` at the first lost-reply assertion. It only performed local deletion.

| Command from `spikes/p0` | Observed result |
|---|---|
| `node native/package.mjs --target x86_64 --session` | The first build exposed an unavailable Android SDK constant in the directory-sync code. The corrected build passed. Debug APK SHA-256 `97ab01cf70b586bff2af7ccf2c27b1801fbbbde59f37fc293d672274b64fb7f0`. |
| `node native/smoke.mjs android-sdk emulator-5576` | All 28 fresh app processes passed. A dropped reply closed the SDK socket and cleared visible rows. Cold resume and both synthetic sign-ins stayed blocked. Repeated reply loss, outage and a malformed acknowledgment kept the rotated ciphertext byte-identical. |
| Same run, force-stop after acknowledgment | The runner read the acknowledged journal while native IPC was pending, force-stopped the matching writer, and observed its WebView disconnect without a reply. A fresh process finished cleanup offline. Replaying the original ciphertext failed before a new peer grant was issued. An unrelated file survived. |
| Same run, canary scan and teardown | Inspected 2,789 app log lines and 277,366 bytes from 52 WebView profile and cache files. No known session canary was detected there. The session bridge returned statuses and the SDK received synthetic access values in memory. The package, installer reservation and ADB mappings were absent at teardown. The emulator stopped. |
| `npm run build` and `npm run test:portable` | Build passed. All 44 tests passed with zero skips. |
| `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features custom-protocol,p0-session --lib` | 26 Windows Rust tests passed with one subprocess-only entry. Android and Windows reused the acknowledgment decoder. The standalone Android Keystore project also built with the [offline Gradle command](../spikes/p0/native/README.md#android-keystore-lifecycle). |

Next offline P0-03 check: exercise the native Convex mutation request over loopback HTTP with inert input, including a lost reply and a malformed acknowledgment. Hosted native sign-in, authenticated reconnect and provider-side revocation of an already-open subscription still need disposable Development session evidence. Physical-device and reminder gates are unchanged.

### Windows CI process identity

The [Windows rehearsal on `452f74b`](https://github.com/willherr72/Klaxon/actions/runs/45518698895/job/138885211138) reached the SDK smoke and rejected a new WebView2 instance whose PID Windows had reused. The frontend and migration job passed. The harness now matches PID and OS creation time, checks the current host, fixture profile and loopback listener, and verifies the browser PID through CDP. Its final inventory includes fixture children started late in the run.

Tested source `ab0f36206c6bfc841892b1e03ed2eb256270138b` on WebView2 158.0.4370.33. From `spikes/p0`, `npm run test:portable` passed 47/47, including three process-identity regressions. An older plain executable failed the expected frontend-hash check. Rebuilding with `node native/package.mjs --target windows` and running `node native/smoke.mjs windows` passed. With the offline session executable, `node native/smoke.mjs windows-session` passed across six fresh hosts and `node native/smoke.mjs windows-sdk` passed across eleven, scanning 177 retired profile files.

### Windows refresh-record recovery

Tested native source `092bbe3c5402505e3397a24561a9cd67eab5da51` on November 24, 2026. A Windows test process consumed an inert response matching the pinned Convex Auth 2.1.0 refresh contract. It encrypted the successor with current-user DPAPI, flushed a staging file and published it by same-directory replacement. An exclusive Windows file handle serialized refresh, seed and sign-out for the slot.

| Point of interruption | Observation after terminating the writer |
|---|---|
| After flushing staged ciphertext, before replacement | The published record matched its original bytes. Concurrent seed, resume and sign-out were denied. A fresh process recovered the predecessor and removed only the abandoned stage. A retry published the successor. |
| After replacement, before returning to the caller | A fresh process requiring the successor authenticated from the replacement. The ciphertext stayed byte-identical through that resume. |
| Sign-out after an interrupted write | Sign-out cleared the record and its abandoned stage, preserved an unrelated fixture file and allowed a new peer session. |

From `spikes/p0`, `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib` passed all 13 top-level checks. The child worker is ignored by the standalone test runner and is explicitly launched by its parent tests. The native response decoder distinguished valid rotation and definitive `noSession` from malformed or failed mutations. An initial integration regression returned `unavailable` for a definitive `noSession`. After the fix, that response clears the slot and returns `signed-out`, while a failed mutation preserves the record. Formatting and native library compilation passed with the session feature enabled and the ordinary library compiled with the feature disabled.

The portable suite passed 27/27 with `npm run test:portable`. The ordinary Windows build and smoke passed with `node native/package.mjs --target windows` and `node native/smoke.mjs windows`: one task retained its ID and title after relaunch. The embedded frontend matched the portable fixture byte-for-byte and excluded the session command and tested markers. The Android Rust library also compiled with the session feature using `cargo check --locked --offline --target x86_64-linux-android --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib`. Android runtime recovery still requires a separate test.

The packaged test used harness source `dba40c5d35844c275e9526a7316ed80c3d3fe5b3`. From `spikes/p0`, `node native/package.mjs --target windows --session` and `node native/smoke.mjs windows-sdk` passed with WebView2 158.0.4370.33 across eight fresh hosts and WebViews. The executable SHA-256 was `3832919deabeaa31f659553838ba69cf14f3cce860ede7b70da1959e5352bce6`. A’s subscription was authenticated when the runner read the replacement ciphertext. An independently restarted host received simulated `noSession` for the retired record, cleared it, showed no tasks and opened no SDK socket. With the captured successor restored, a fresh host authenticated, read A’s task, received an update and signed out. The runner inspected 174 retired WebView profile files for the tested canaries and removed its temporary directory. The companion `node native/smoke.mjs windows-session` regression passed across six fresh hosts and eight isolated session replies. Process termination during the write itself was exercised in the Rust child tests above.

During development an earlier debugger attachment timed out before the new storage assertion. Diagnostics confirmed WebView2 could leave its debugger port file behind after exit. The harness now clears the retired advertisement and verifies the listener belongs to the new host and its fixture profile before exercising the page. The cause of the earlier timeouts remains unconfirmed.

These interruption tests used actual Windows processes and files. The response came from an in-process fixture. Power interruption, a live issuer, refresh-token replacement on Android and hosted reconnect remain open. [Windows reproduction](../spikes/p0/native/README.md#packaged-windows-sdk-handoff)

### Portable account task freshness

At `9d0238fcd1d3897ed975330820fac82b332a8801`, a browser regression held a manual HTTP read open while the same account's SDK subscription delivered a changed task title. Before the fix, completing the HTTP read restored the old title. The client now compares the active session and the version of its displayed rows before applying the read. The regression checks the visible title after the read completes. From `spikes/p0`, `node --test --test-name-pattern="a manual read cannot replace" account-session.test.mjs` passed, and the full portable suite passed 31/31. The browser ran the bundled Convex SDK with intercepted HTTP and WebSocket traffic.

Review also reproduced the reverse ordering: the HTTP response can contain a newer title than an overlapping subscription callback. At `0ad90650c9f666f5e2b30585f422e804d7fdbd0a`, the client resolves an overlap with one additional read started after that callback. If the subscription changes again during the second read, the UI retains those updates and identifies their source. The browser checks both orderings and the bounded second-read case. A clean export of `b25365ed8025fd746f2cb59e8924b7bbd6f39390` passed `npm run build` and all 33 tests in `npm run test:portable` from `spikes/p0`.

### Android refresh-record recovery

On November 24, 2026, the previous session APK (SHA-256 `3cb85ac93ba665a95e155570790d4fd5059ea476536071420af807e20509a213`) returned `authenticated` after the harness requested a synthetic refresh, but its encrypted record was byte-identical. The same focused comparison passed after rebuilding the Android fixture from `c5cf828`. The fixture uses the Windows spike’s pinned Convex response decoder and verifies that the published ciphertext contains the accepted replacement before issuing access.

From `spikes/p0`, `node native/package.mjs --target x86_64 --session` and `node native/smoke.mjs android-sdk emulator-5576` exercised the packaged Tauri client and Android Keystore on an API 36 x86_64 emulator. The emulator had airplane mode enabled, Wi-Fi off and no active default network. The first full run used 13 fresh app processes, WebView 133.0.6943.137 and 1,333 inspected app log lines. APK SHA-256 was `6b697bf9975dae9ebb7b48a5965dc48b861580a387c431d8abea5bf335b3225f`.

The simulated issuer returned a malformed response, a different owner, an outage or a valid rotated grant. The first three denied access and preserved the predecessor. A partial staging file placed by the runner was discarded on cold resume. A blocked staging write denied access. After a successful write, a fresh process recovered generation A2 from the successor without rewriting it. Replaying the retired predecessor produced definitive `noSession`, removed the test slot and alias, and preserved an unrelated synthetic file. The runner verified a fresh seed, sign-out, uninstall and empty ADB mappings. The partial staging case reconstructed an interrupted filesystem state. It did not terminate an in-flight writer. Hosted issuer revocation and recovery from device power loss remain unverified.

Independent review identified a second failure point after the staging write succeeds. The test fixture removed its synced stage just before `finishWrite`, causing the real Android publish to fail. SDK access was denied and the predecessor survived. On Windows the ADB shell initially returned five bytes for a four-byte binary control because it expanded LF to CRLF. Source `00d1cf7c1ae94153fa9d71eb5e5317e4d06b36b3` switched both ciphertext reads and profile inspection to verified base64 transport. The rerun passed the four-byte device control and inspected 276,712 decoded bytes across 48 regular files under the stopped package’s `app_webview` and `cache` directories. The known canaries were absent from those files and 1,332 app log lines. The companion `node native/smoke.mjs android-session emulator-5576` passed across eight app processes and 12 status-only replies on the same APK, SHA-256 `f39ffab71a7e3e140c6cea559351a64902a38547c58c206259a2e05727dc60d9`.

From `spikes/p0`, `npm run test:portable` passed 30/30. An earlier run timed out on a retry after another tab removed a quota filler. Under controlled scheduling the first tab still saw the filler and correctly preserved the draft. The regression now waits for that tab to observe the deletion before clicking retry, then checks the saved title again after reload. The focused check passed five consecutive times in each of Windows Edge and Chrome. `node native/smoke.mjs windows-sdk` passed across eight hosts and 176 retired profile files with the shared scanner. `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features custom-protocol,p0-session` passed 13 tests. Its subprocess helper was invoked by the recovery tests.

At `7f1e5bf2f726d17cdac93afc180469c136b44099` the packaged driver also terminated the real writer during two pending SDK invocations. It matched a native checkpoint to the live app PID, checked that IPC had not replied, force-stopped that package, and observed both PID disappearance and WebView disconnection.

| Writer boundary | Fresh process result |
|---|---|
| Synced stage present, before publish. Writer PID 11943. | PID 12087 resumed A1 from the predecessor. The retired staging file was discarded. A retry could proceed. |
| Successor published and verified, before acknowledgment. Writer PID 12201. | PID 12343 resumed A2 with the simulated provider set to accept only the successor. Sign-out removed its alias and record while preserving an unrelated fixture file. |

Both pending invocations ended without a reply. The complete `android-sdk` run passed across 19 distinct processes. It checked 1,893 app log lines and 276,917 bytes from 48 retired profile and cache files for known canaries. Session APK SHA-256 was `2565f035a642b446bab3511d29cb70fb2fbf14b158aab5d047d5363b788694c9`. The ordinary `node native/package.mjs --target x86_64` build produced SHA-256 `c794e2e167cb6471cb3fdaa322907abdfe78ddc4873daca6a3a8806b29cb6d9d`. Its DEX and native library excluded the session plugin, failure controls, pause flags and refresh-decoder JNI entry checked in the session APK. The packaged test covers process death on Android. Hosted revocation, OS power loss and physical-device behavior still require their own evidence. [Procedure](../spikes/p0/native/README.md#packaged-android-sdk-handoff)

The ordinary `node native/smoke.mjs android emulator-5576` regression also passed: create, rename, read and restart preserved the synthetic task ID. Both APKs were uninstalled after their runs. The operator verified empty forward and reverse routes and stopped the named emulator.

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
- P0-07. The owner confirmed Free for the spike. A read-only review on November 24, 2026 verified the allowances in the [cost record](deployment.md) against [Convex pricing](https://www.convex.dev/pricing) and [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/). The [two-device task-list estimate](deployment.md#p0-single-owner-task-list-estimate) projects 1,980 calls and 30 MB database I/O over 30 days under its stated assumptions. Deployment region, actual shared-team usage and remaining capacity are unverified. Hosted native refresh/revocation, background and closed-app delivery, and scoped Dot execution remain open. [Architecture ADR](adr/p0-architecture.md) · [Security](security.md) · [API boundary](api/README.md)

## Backlog register

| ID | Planned PR scope | Status | PR / verification |
|---|---|---|---|
| P0-01 | Baseline | Inventoried | [Test results and historic CI failures](testing.md) |
| P0-02 | Isolation | Complete | v2 branch and disposable hosted Development deployment in owner-confirmed Free team. Preflight returned zero tables and zero functions. Only synthetic fixtures enrolled. [PR 14](https://github.com/willherr72/Klaxon/pull/14) |
| P0-03 | Auth/realtime spike | Owner-reported desktop-off smoke passed | [Owner report and remaining tests](#remaining-p0-tests). The [Windows](#packaged-windows-dpapi-session-evidence) and [Android](#packaged-android-session-evidence) packaged synthetic resume/sign-out tests passed. Restoring a hosted account session through either packaged client remains open. |
| P0-04 | Dot spike | Scheduled browser read/write passed with Windows off | [Observed run and outstanding checks](dot-playbook.md#scheduled-browser-fallback) |
| P0-05 | Integrations | Interfaces reviewed | [Scopes and unresolved tenant consent](adr/platform-capabilities.md) |
| P0-06 | Reminders | Focused delivery passed on both devices, owner-reported | [Sender and receiver evidence](#one-time-reminder-sender-and-receiver-rehearsal) · [Owner runbook](p0-reminder-owner-test.md) · [Push matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) |
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
