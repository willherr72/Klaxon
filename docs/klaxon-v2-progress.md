# Klaxon 2.0 progress

Baseline c89b655 (v0.11.1). Development branch `v2`. Opened 2026-11-23. P0 is in progress. Will reports that physical Android synced with Windows powered off. Dot also passed a one-time scheduled browser read/write with Windows off. P1 remains queued while native sessions, physical reminders and the remaining Dot checks are open. See the [remaining tests](#remaining-p0-tests). [Draft PR 14](https://github.com/willherr72/Klaxon/pull/14) collects initial discovery and spike evidence.

## Remaining P0 tests

**P0-03 desktop-off smoke passed, owner-reported November 24, 2026.** Will signed in on both clients and created a synthetic task. He reported fully shutting down and unplugging Windows, reopening the client and signing in on Android over an independent network, renaming the task and confirming the save. After restarting Windows, he saw the renamed task there. His report covers one task. The record contains no independent observation, exact timing, task ID, browser/build version or extended disconnect/reconnect evidence. The [extended device procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance) remains available if those details become necessary.

| Gate | Evidence already available | Next test and stop condition |
|---|---|---|
| P0-03 native session | Both packaged fixtures resumed inert sessions across fresh processes and remained signed out after logout. Windows WebView2 rejected corrupt DPAPI ciphertext and preserved a valid record through a simulated outage and cold retry. Android preserved its Keystore record through a simulated outage and cleared it on definitive expiry. Windows also passed the [authenticated task read and subscription test](#packaged-windows-authenticated-task-read-and-subscription) against a simulated native provider. Both [Windows](#packaged-windows-dpapi-to-sdk-handoff) and [Android emulator](#packaged-android-keystore-to-sdk-handoff) SDK handoffs passed for reads, subscriptions, outage denial and owner switching with an intercepted provider. Both packages also passed [synthetic access-token replacement](#packaged-sdk-access-token-replacement). Windows passed [refresh-record recovery after process termination](#windows-refresh-record-recovery). The Android emulator passed [failed publication and real writer termination before and after publication](#android-refresh-record-recovery). Both platforms validated synthetic initial grants. Android also passed [initial sign-in process-death recovery](#android-initial-sign-in-to-keystore). Both [Windows](#windows-sign-out-after-a-lost-acknowledgment) and [Android](#android-sign-out-after-a-lost-acknowledgment) recovered from a lost simulated sign-out acknowledgment across restarts. The [Windows initial sign-in and cold refresh](#packaged-windows-initial-sign-in-over-loopback-http) also passed over native loopback HTTP with a scripted issuer. Windows also passed revocation with a real local provider on an [open subscription](#packaged-windows-revocation-on-a-real-local-provider) and [across disconnect/reconnect](#windows-subscription-reconnect-after-revocation). The [packaged Android emulator](#android-local-provider-preflight) also passed native and WebView loopback checks with a scripted provider. Android passed [open-subscription revocation](#android-revocation-on-a-real-local-provider) and [revocation during a subscription outage](#android-subscription-reconnect-after-revocation) with the real local provider. Both platforms passed their [hosted packaged lifecycles](#hosted-packaged-native-acceptance). | Physical Android and a device-wide network outage remain open. The portable account client still requires sign-in after reload. |
| P0-06 ordinary reminders | Will confirmed one visible notification and the matching worker receipt in each focused client, Windows Edge and Android Chrome. He removed both subscriptions and the operator retired the receiver. Both push services returned HTTP 201. Later locked-screen attempts also returned HTTP 201. Windows Edge recorded one worker receipt with a resolved display request, and Will reported a gap in observation. Android Chrome showed zero worker receipts, and Will saw no notification while locked or after unlocking. | Receipt and first-seen times were not recorded for the focused tests. Visible locked-screen delivery remains unverified on both platforms. The remaining [device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) also covers closed, force-stopped, denied and offline states. |
| P0-04 owner Dot | Scheduled browser fallback passed once with Windows off (owner-confirmed). Dot restored the verified client after the prior tab and preview were lost, signed in, saw a connected subscription and renamed exactly one pre-staged synthetic task. A fresh server read at 2026-11-24 16:31:38 UTC confirmed the same ID and new title. Will independently reported seeing the result on Android and Windows. Dot also passed [browser create](dot-playbook.md#browser-create-acceptance) on November 25. One click was acknowledged at about 15:32:32 UTC. A fresh read at 15:32:39.299 UTC returned the same ID and title exactly once. | Independent cross-client owner confirmation of the create remains unverified. Remote MCP, scoped agent identity, audit attribution, idempotency receipts and expiry/revocation remain unverified. The scheduled browser smoke needs no repeat. See the [Dot playbook](dot-playbook.md#scheduled-browser-fallback) for the managed-preview caveat and evidence limits. |

### Hosted packaged native acceptance

Windows and Android passed their native lifecycle checks on November 25, 2026, using the owner-confirmed disposable Free Development deployment. The tested implementation is `48929c1e04c3288d8445cc34a58618b887072edd`. The operator verified the Development origin with a fresh scoped key and pushed only the isolated backend fixture after a passing dry run. Both packages reported matching HTML, SDK and native origin pins before synthetic logins were supplied.

| Platform | Observed result |
|---|---|
| Windows WebView2 | The Windows phase passed on the second combined invocation. It verified native sign-in, cold resume from DPAPI, rotation, exact-grant revocation while the SDK socket was down, stale-bearer read and rename denial, the independent same-owner edit, cross-owner denial and a signed-out cold launch. The combined command later exited 1 during Android and control cleanup. Executable SHA-256 `1216f2a95694338d458846a409ef060e0f28d5974be2431250b37c6eace9c275`. |
| Android WebView | The subsequent `--platform android` invocation exited 0 on the disposable API 36 x86_64 emulator. Three distinct app processes exercised sign-in, Keystore cold resume and rotation, and cold sign-out. The original subscription kept one in-memory row while cut. After native revocation, its second WSS connection cleared the row and stayed empty through the independent control edit. Fresh HTTP calls returned unauthenticated and zero rows. The stale bearer and other owner could neither read nor rename the task. The bearer stayed unexpired and the SDK reported zero forced refreshes and query errors. Native completion was about 600 ms and the empty callback about 1.7 s after revoke began. Debug APK SHA-256 `53b0d00dd1d64a994af7663ac9dc205e0ab77550dc56b4b943dda2814c8dae7c`, with v2 signature verified. |
| Cleanup | Both earlier failed invocations and the final pass retired their two synthetic owners, two username mappings and one task each. The final run separately verified all three control grants were revoked. The retirement mutation reported zero remaining active sessions for each run, and the enrollment marker table was verified empty. Auth 2.1 retains inaccessible password hashes and created-user bookkeeping without a supported removal operation. The package, install receipt, ADB mappings and fixture profiles were gone, and the emulator was shut down by 13:40:22 UTC. The private key handoff copies were removed locally. Will confirmed revoking the fresh Development key on November 25. |

The second combined attempt received HTTP 401 when its cleanup verifier queried with each revoked control bearer. The regression now accepts that denial only after a null sign-out acknowledgment and a definitive `noSession` replay of the same refresh grant. The Android-only pass verified this path. The first combined failure lacked a platform-specific result, and the second combined failure did not isolate the Android failure's underlying cause.

The [runbook](../spikes/p0/native/README.md#hosted-packaged-native-acceptance) records both package commands, account-free origin attestation and scoped provisioning. The final portable suite passed 109/109. Locked offline native tests passed 19 hosted Windows tests and 39 loopback Windows tests, with one subprocess-only entry exercised by its parent tests. Both Android cross-checks and Rust formatting passed. The outage probe interrupted the SDK WSS connection while native HTTPS and the Edge control stayed online. Physical-device secure sessions, device-wide outages and an all-green combined invocation remain unverified.

### Android ARM64 hosted package rehearsal

On November 25, 2026, the hosted Android fixture built for `aarch64` with the synthetic origin in the [build-only procedure](../spikes/p0/native/README.md#android-arm64-package-rehearsal). The build ran from `spikes/p0` with `CARGO_NET_OFFLINE=true`, Tauri CLI 2.11.0, NDK 27.1.12297006 and Android Build Tools 36.0.0. The initial build produced 4 KiB ELF load segments. With the linker flags scoped to the ARM64 hosted fixture, all four load segments aligned at 16 KiB. The signed APK also passed `zipalign -c -P 16 4`.

The APK SHA-256 was `89a5ec901d50771aec2938db447b1265d9a3282ab7bdcae26d552c89894fae68`. Build Tools identified one `arm64-v8a` ABI, package `dev.klaxon.p0native`, debug build, version 0.1.0, minimum API 24 and target API 36. `apksigner` verified its Android Debug certificate and APK Signature Scheme v2. The archived AArch64 library matched Cargo's output with SHA-256 `5a2e2033d8bb9439c525baac659ea8ad55e5a64e060eec10b92ed6e828a558ff`. Its DEX contained the fixture plugin and Keystore store. Inspection matched the Brotli assets to bytes in the archived library, then verified the HTML origin marker, SDK script integrity, native HTTPS mutation pin and exact origin rules in both CSP layers.

`npm.cmd run test:portable` passed 110/110 after the new packaging regression reproduced the old ARM64 rejection. Rust formatting passed. The package remains on the build host. Phone execution, Keystore and hosted transport remain unverified on ARM64. The existing acceptance and provisioning runners retain their emulator-only admission. [Scope and physical prerequisites](../spikes/p0/native/README.md#android-arm64-package-rehearsal)

The separate [account-free phone entry point](../spikes/p0/native/README.md#account-free-phone-attestation) verifies the APK before selecting an explicitly approved USB transport. It checks for prior installations across Android users and reserves the install before staging. The phone path checks the staged and installed APK hashes and disallows replacement. A confirmed install can reach the origin attestation. Cleanup uses its original path and verified hash. `npm.cmd --prefix spikes/p0 run test:portable` passed 121/121, including simulated late or mismatched install state, rejected commands, foreign forwards and cleanup after a failed exercise. An unidentified surviving forward preserves the original failure and gets a separate cleanup diagnosis.

The revised hosted APK declares `android:allowBackup="false"`. The earlier APK failed this manifest check before ADB. The rebuilt APK, SHA-256 `797283515a45e3cb04d3755292f71d4d953debfd8a3efa1cc8f17c888614581c`, passed host verification before the injected USB boundary. Its signature, alignment and the three embedded origin pins passed again. The temporary manifest and packaging lock were removed.

The [hosted phone mode](../spikes/p0/native/README.md#hosted-phone-lifecycle) keeps one verified install through attestation, scoped enrollment, the three cold-process checks, hosted retirement and device cleanup. It gates key access on a validated Wi-Fi or cellular default and the updated probe marker. Synthetic cases verified binding to the enrolled owners, removal of one-use input after a failed stage, retention of the retry receipt after missing or contradictory retirement evidence, and rejection of a shaped HTTP 202 acknowledgment. The retry reuses the persisted enrollment and task expectations. `npm.cmd --prefix spikes/p0 run test:portable` passed 146/146.

The rebuilt synthetic-origin ARM64 APK, SHA-256 `0e95839307e1d3b77dad05e7bce9819d18778cba3c6e2e77b8646a1a796a7526`, passed the debug signature, manifest, 16 KiB alignment and embedded origin checks. The archived SDK included the new probe version. The package remained on the build host and its admission check stopped at injected USB. Physical execution, the device's connectivity diagnostic format and hosted lifecycle on the phone still need an owner-approved run. No credentials, accounts or deployment changes were used for this rehearsal.

### Android revocation on a real local provider

Passed November 25, 2026, on tested draft head `aa42c61d1fec99c3460da92da9d7c847a2b6c8c1`. Will approved two temporary synthetic owners and one task on a disposable loopback backend. From `spikes/p0`, `node native/smoke.mjs android-provider-acceptance emulator-5586` exited 0 on the first attempt. It used the same [debug APK](#android-local-provider-preflight), Android 16/API 36 x86_64, WebView 133.0.6943.137, Convex 1.51.0 and Auth 2.1.0. ADB reverse connected the offline emulator to the local backend running the indexed test functions.

| Check | Observed result |
|---|---|
| Cold resume | Sign-in consumed the one-use input. After a force-stop, a second app process resumed from Android Keystore and saved a different provider-issued refresh grant for the same owner and session. HTTP, the subscription and the rendered list each showed one matching task. |
| Revoke the Android session | Sign-out with the saved successor received an explicit null acknowledgment. Refresh with the same grant returned `noSession`. Native cleanup removed the key and record. A third process started signed out and denied SDK access. |
| Already-open subscription | The original subscription received one empty update and the visible task disappeared. The socket stayed connected with the same unexpired bearer, zero forced refreshes and zero query errors. Fresh HTTP calls using that bearer reported unauthenticated and zero tasks. From revoke invocation, the empty callback took approximately 300 ms and native completion 500 ms, rounded to the nearest 100 ms. |
| Account isolation | An independent Edge login for the same owner remained authenticated, renamed the task, and rendered the rename through its subscription. The other owner remained authenticated, saw zero tasks and received a denial when attempting to rename it. |
| Cleanup | Both control grants were revoked. At 04:13:18 UTC, the operator verified absence of the fixture package, install receipt, ADB routes, local backend process, listeners on 3210/3211 and temporary backend workspace. The disposable emulator was stopped. |

The Android observation ended before the control rename. The [reconnect test](#android-subscription-reconnect-after-revocation) kept the target subscription open through the edit. The [hosted packaged runs](#hosted-packaged-native-acceptance) followed. Physical Android remains open. [Runbook](../spikes/p0/native/README.md#android-local-provider)

### Android subscription reconnect after revocation

Passed November 25, 2026, on source `a5180172692f2f9f6711a1ecc7e36e58dc3d425f`. The disposable run used the same Android 16/API 36 x86_64 and pinned local Convex/Auth setup as the open-subscription test. The rebuilt debug APK verified with APK Signature Scheme v2 and had SHA-256 `f747266a06fc1d2c2877fd58e44d8595f20d5bd96a78f3b029c0f595a6dc9f5b`. Before account setup, the packaged WebView confirmed a real WebSocket round trip on emulator loopback port 3212, and native and WebView HTTP passed on port 3210.

| Check | Observed result |
|---|---|
| Subscription cut and exact-session revoke | The relay cut one established socket. The SDK was disconnected before and after native revocation, and the last task snapshot stayed visible in memory during the outage. Native revocation finished about 400 ms after invocation. The protected slot was gone before the relay reopened. |
| Reconnected subscription | The original SDK subscription's second connection received the empty callback about 1.3 seconds after revoke invocation. The SDK retained the same unexpired bearer and reported zero forced refreshes, query errors or nonempty callbacks after restore. Its rendered list was empty. |
| Server and account checks | The old bearer received unauthenticated and zero tasks from fresh HTTP queries. A rename was denied with a Convex function-error envelope over HTTP 200. The same-owner Edge subscription rendered its independent rename while the Android subscription stayed empty. The second owner remained authenticated with no rows and could not rename the task. |
| Cold sign-out and cleanup | A third app process stayed signed out and denied SDK access. The operator verified the fixture package, install receipt, both reverse mappings, debug forward, backend and relay listeners, backend process and temporary database were gone by 04:32:12 UTC. The disposable emulator was stopped. |

From `spikes/p0`, `node native/package.mjs --target x86_64 --session --android-provider-preflight` and `node native/smoke.mjs android-provider-acceptance emulator-5586 --reconnect` exited 0. The package build used Cargo offline. `npm --prefix spikes/p0 run test:portable` passed 97/97, including reverse-route setup and removal acknowledgment loss with the native route left intact. This run cut only the SDK socket and observed its in-memory rows. The [hosted packaged runs](#hosted-packaged-native-acceptance) followed. Physical Android and device-wide offline behavior remain open.

### Android local provider preflight

Tested source `4db45e279fdfd513f9aaeb14f8c570cebb4e770d`, draft #14 targeting `v2`. The final account-free packaged run exited 0 after the ADB ownership fixes. `npm --prefix spikes/p0 run test:portable` passed 94/94, including admission under inherited debug/proxy settings, conflicting ADB mappings and lost acknowledgments. `cargo fmt --manifest-path spikes/p0/native/src-tauri/Cargo.toml -- --check` and `git diff --cached --check` passed.

The account-free P0-03 rehearsal passed on November 25, 2026. The debug APK ran on a disposable Android 16/API 36 x86_64 emulator with WebView 133.0.6943.137. Its SHA-256 was `bcc54fd4c8f7109cff98328fc1038b0ca52f56fe4b50758bfcddb32ba334f4c9`. Android Build Tools verified the APK's v2 signature, debuggable flag and single x86_64 ABI. The emulator had airplane mode on, Wi-Fi off and no default network. ADB reverse carried native HTTP, WebView HTTP and an actual WebSocket exchange to host loopback.

| Check | Observed in the packaged app |
|---|---|
| Cold resume and retry | After sign-in consumed the one-use input, the runner force-stopped the app. The new process rejected an HTTP 202 carrying a plausible `noSession` and preserved the Keystore ciphertext byte for byte. The retry accepted an HTTP 200 rotation and later presented the saved successor for sign-out and refresh confirmation. |
| Existing subscription | Before scripted revocation, the SDK's HTTP read, subscription and rendered list each had one row. On the same socket and unexpired bearer, the original subscription received an empty list, the row disappeared, and a fresh HTTP read returned zero rows. The SDK reported zero forced refreshes and zero query errors. |
| Cleanup and relaunch | A third distinct app process returned signed out and denied SDK access. A separate launch recovered a modeled interruption with an acknowledged journal and residual slot file after key deletion. The runner verified fixture uninstallation and empty ADB mappings. The emulator was shut down. |

The first packaged attempt exposed a staging failure. ADB reported success for `exec-in` but the input file was absent. The runner now uses `adb shell -T` with stdin and verifies the bytes before invoking native sign-in.

From `spikes/p0`, reproduce the packaged run with `node native/package.mjs --target x86_64 --session --android-provider-preflight` followed by `node native/smoke.mjs android-provider-preflight <disposable-emulator-serial>`. The issuer and task server scripted their responses. The subsequent approved run exercised the same APK against a real local provider with two independent controls. [Result](#android-revocation-on-a-real-local-provider) [Procedure](../spikes/p0/native/README.md#android-local-provider)

### Android emulator loss of its provider route

On November 25, the packaged Android 16/API 36 x86_64 rehearsal passed with the sole provider route removed. Airplane mode stayed on, Wi-Fi stayed off, and Android reported no active default network. The scripted issuer stayed bound to host loopback. After sign-in, the runner removed `adb reverse` for device port 3210 and started a fresh app process. Resume returned `retry-required`, SDK access returned `signed-out`, and the Keystore-protected record stayed byte-identical. Chromium reported `net::ERR_CONNECTION_REFUSED` for both the HTTP query and SDK WebSocket endpoints. From before route removal to recovery, the issuer recorded zero new TCP connections, HTTP requests or WebSocket upgrades.

The runner restored the same route to the same issuer. Another fresh app process presented the saved predecessor and accepted an immediate scripted rotation. Then authenticated HTTP, the SDK subscription and the rendered list each showed one row. Exact-successor sign-out emptied the original subscription on the same unexpired bearer and socket, denied a fresh HTTP read, and cleared the slot. The final cold launch stayed signed out. Four distinct processes exercised the session lifecycle after a separate account-free transport admission launch.

From `spikes/p0`, `node native/package.mjs --target x86_64 --session --android-provider-preflight` built the offline debug APK. `node native/smoke.mjs android-provider-preflight emulator-5586 --network-outage` exited 0. Android Build Tools verified x86_64, debug mode and the APK's v2 signature. APK SHA-256 `8b29c4a0574f2016d4f5eef47cb4e79035b04a895f1f67e78b8301bd81fb6daa`. The smoke verified package absence and empty ADB mappings. Physical hosted-internet loss, DNS/TLS recovery and warm offline cache behavior remain open. [Reproduction](../spikes/p0/native/README.md#android-local-provider)

The same `android-provider-preflight` command without the flag also exited 0. Its HTTP 202 retry, three-process lifecycle and acknowledged-cleanup recovery still passed. `node --test spikes/p0/native/local-provider/android-session-preflight.test.mjs spikes/p0/native/local-provider/scripted-android-provider.test.mjs` passed 10/10 from the repository root, and `npm.cmd --prefix spikes/p0 run test:portable` passed 152/152. The root application suite passed 65/65. The operator verified the fixture install receipt, scoped ADB mappings, emulator processes, listeners and disposable AVD directory were absent after teardown.

### Packaged Windows revocation on a real local provider

Passed November 25, 2026 at 02:14 UTC. Source `6b85f064d2ed234bcc43cdc60ce26a845d77fd73`. The unsigned Windows executable had SHA-256 `4140d67438475d0072b6123e3f6a6a8823e5c2a6c4e60485e35d10f8e6a728fe`. The run used Convex 1.51.0, Auth 2.1.0, the cached local backend `precompiled-2026-11-21-cf39368`, and two disposable local owners. The packaged client signed in, exited, and resumed in a second native process and WebView2 using its DPAPI-protected record. An independent Edge login for the same owner rendered the same synthetic task.

| Check | Observed result |
|---|---|
| Revoke the packaged session | Native sign-out received an explicit null acknowledgment. Refresh with that same grant returned `noSession`. The native client removed the protected record. |
| Observe the already-open subscription | One callback changed the subscription and rendered list from one row to zero. The original socket stayed connected with the same unexpired bearer, zero forced refreshes and zero query errors. Fresh HTTP queries using that bearer returned unauthenticated and zero task rows. |
| Check the other logins | The independent same-owner login remained authenticated, renamed the task and rendered the rename from its own subscription. The second owner remained authenticated, saw zero rows and received a denial on rename. |
| Timing | Measured from native revoke invocation and rounded to the nearest 100 ms, the empty callback occurred at 0 ms and native revoke completion at 100 ms. Completion includes the refresh-denial probe and local cleanup. |
| Cleanup | Both control grants were revoked and returned unauthenticated. The fixture destroyed its disposable database, accounts and profiles. The final inspection found zero listeners on 3210/3211, zero fixture host/backend processes and zero matching temporary directories. |

From the repository root, `node spikes/p0/native/local-provider/run.mjs` exited 0. Two earlier runs stopped during the control setup. A credential-free comparison isolated Edge's local-network check on the intercepted document. An actual loopback document and the packaged asset both opened the socket. All runs used fresh local state. The passing run used the browser's default security settings.

- `npm --prefix spikes/p0 run test:portable` passed 63/63. This includes three outcome-scoring tests.
- `node --test spikes/p0/native/local-provider/backend.test.mjs` passed 3/3, covering anonymous startup, teardown after callback failure and occupied ports.
- `cargo test --locked --offline --manifest-path spikes/p0/native/src-tauri/Cargo.toml --features p0-local-provider --lib` passed 15/15. The combined `custom-protocol,p0-local-provider,p0-windows-sign-out-http` library run passed 36 with one subprocess-only entry exercised by its parent tests. Rust formatting and Git whitespace checks passed.

The follow-up below covers the disconnected Windows subscription. Android subsequently passed the [open-subscription test](#android-revocation-on-a-real-local-provider). Both platforms subsequently exercised [packaged HTTPS and WSS](#hosted-packaged-native-acceptance). [Procedure](../spikes/p0/README.md#local-provider-acceptance-for-an-open-subscription)

### Windows subscription reconnect after revocation

Passed November 25, 2026 at 03:11 UTC. Source `6b3fc70c9f6b428876abf159d498080054a8b80f`. Unsigned executable SHA-256 `49a87f50615637de34e9fb302a2dfefa249e6d819ad87ff0310fc29b55797558`. From the repository root, `node spikes/p0/native/local-provider/run.mjs --reconnect` exited 0 against the pinned disposable local Convex provider. Only the target's subscription transport was interrupted. Native issuer requests, direct HTTP and the independent Edge control could still reach the backend.

| Observation | Result |
|---|---|
| Start and disconnect | The packaged app signed in and resumed across two distinct native and WebView2 processes. HTTP, the live subscription and the rendered list each contained one synthetic task. The relay cut its one established upstream connection. The SDK reported disconnected before and after native revocation. |
| Revoke during the cut | The native issuer request received acknowledgment, refresh with the same grant returned `noSession`, and the protected slot was absent before the relay reopened. The previously read task remained in memory and visibly rendered while disconnected. |
| Restore the subscription | The same SDK registered connection 2 and delivered one empty update on connection 2. The row disappeared approximately 0.9 seconds after revocation began. Native revoke completed at approximately 0.1 seconds. Both times are rounded to the nearest 0.1 seconds. |
| Reuse the old bearer | After the SDK reconnected, fresh HTTP queries returned unauthenticated and zero rows. The rename returned HTTP 200 with a Convex error envelope and the specific `Task unavailable` rejection. The bearer was unchanged and unexpired, with zero forced refreshes or subscription errors. |
| Verify the surviving sessions | The second login for the same owner renamed the task and saw the new title through its own subscription. The revoked WebView stayed open through this edit and for a further second. It received zero nonempty callbacks after restoration and ended with zero rendered rows. The second owner remained authenticated, saw zero rows and could not rename the task. |

The first run was inconclusive for the write because the test required HTTP 560. An anonymous failing mutation independently reproduced an HTTP 200 error envelope. The final scorer checks both the envelope and the SDK rejection and binds the empty callback to the connection present at verdict. `npm --prefix spikes/p0 run test:portable` passed 72/72, including the relay teardown and scoring regressions. Cleanup revoked the control grants, removed the temporary database, accounts and profiles, and closed the relay. A final inspection counted zero backend listeners, fixture processes and matching temporary directories.

This establishes recovery from a subscription outage on Windows. The visible offline row was an in-memory snapshot. Disk-cache behavior and a device-wide network outage remain unmeasured. The [Android subscription-outage test](#android-subscription-reconnect-after-revocation) measured the same in-memory cache behavior.

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

The remaining physical reminder rows include browser tabs in the background with the screen locked. The [owner procedure](p0-reminder-owner-test.md#two-device-background-procedure-requires-separate-approval) separates visible delivery while locked from receipts and sightings after unlocking. At source `fa4f0d423208085dd62230a10da89d210b1e4939`, `node spikes/p0/reminder-push/rehearse.mjs` returned two mocked HTTP 201 results with both worker and visible receipts unobserved. `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` passed 14/14. The subsequent single-device runs are recorded below.

For the November 24 locked-screen run, Will confirmed Windows Edge enrollment and reported Windows locked before the send. The agreed earliest unlock was 23:55 UTC. The operator verified the staged page, module MIME types, Windows worker and private-path exclusions via public HTTPS. The sender at `b25365ed8025fd746f2cb59e8924b7bbd6f39390` claimed one Windows attempt. It sent at 23:49:00.400 UTC and recorded HTTP 201 at 23:49:00.660 UTC. Will read one matching worker row, timestamped 23:49:00.689 UTC, with the display request resolved. He did not see a lock-screen notification and reported a gap in observation. Visible delivery by the 23:54:00.400 UTC cutoff is inconclusive. The operator verified removal of the matching Windows export, private sender input and disposable key file. Will confirmed Edge cleared the subscription, fixture worker and local receipts. The operator stopped the tunnel and server, verified the listener, run directory and matching export were absent, and received HTTP 530 from the former receiver URL. Android was outside this run. The offline regression command `node --test reminder-evidence.test.mjs reminder-push/*.test.mjs` passed 17/17 from `spikes/p0`. [Windows-only runbook](p0-reminder-owner-test.md#windows-edge-locked-screen-run)

On November 25, Will approved and enrolled in the [Android-only locked-screen run](p0-reminder-owner-test.md#android-chrome-locked-screen-procedure). The sender's new mode requires exactly one Android subscription and rejects a Windows endpoint before claiming the attempt. The operator verified five HTTPS assets, JavaScript MIME types and 404 responses for the Windows worker and private inputs. The offline reminder suite passed 19/19. The two-device mock rehearsal and all 65 app tests also passed.

The sender at `92cbe436512ccacc0c57d6f2faf1660235b0f603` attempted one Android Chrome push at 16:04:00.488 UTC and recorded HTTP 201 at 16:04:00.884 UTC. The five-minute visibility cutoff was 16:09:00.488 UTC, with unlock agreed for 16:10 UTC. Will reported seeing no notification while the phone was locked or after unlocking. Chrome showed zero worker receipts when checked. The observed result does not establish whether the worker ran. The locked-screen cell has no visible delivery pass, and the single attempt is spent.

Will confirmed removal of the Android Chrome test subscription. The operator stopped the temporary tunnel and loopback server, removed the private run directory containing the sender input and disposable key, and deleted the matching export from Windows Downloads after verifying its hash. The listener and run directory were absent, and the former receiver returned HTTP 530. Deletion of the copy in Android Downloads was not separately confirmed.

The isolated receiver previously waited for receipt storage before requesting display. Three synthetic regressions reproduced suppressed display on cache-open rejection, suppressed display on receipt-write rejection, and delayed display during an outstanding receipt write. The receiver now requests display independently and writes the result after the pending row settles. The tests verify one display request per valid push and preserve the final receipt when storage works. They do not identify the cause of the physical miss. `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` passed 22/22 and `npm.cmd test` passed 65/65. `node spikes/p0/reminder-push/rehearse.mjs` accepted both fake sends without observing delivery. The [platform matrix](adr/platform-capabilities.md#ordinary-reminder-delivery) keeps Android native scheduling as a candidate and defines a separate comparison for the next approved device session.

### Android pre-armed alarm rehearsal

On November 25 the separate debug fixture used real `AlarmManager` delivery on an offline API 36 x86_64 AVD. It replaced revision 1 of one occurrence with revision 2, canceled a second occurrence, and verified the arming process exited before the original deadlines. With no exact-alarm permission granted, Android used inexact `RTC_WAKEUP`. A fresh process recorded only revision 2, due at `17:18:25.251 UTC` and received at `17:19:07.268 UTC` (42.017 seconds late). The screen was noninteractive at receipt. Keyguard and idle mode both reported `false`. No other callbacks were recorded through 10.732 seconds after receipt.

Built with `./src-tauri/gen/android/gradlew.bat --offline --console=plain -p spikes/p0/native/android-alarm assembleDebug`. `aapt dump permissions` listed zero requested permissions, and `apksigner verify --verbose` verified the APK's v2 signature. Tested APK SHA-256 `35cf53b6447bd86394126c1c4792ef5d2a72de4e2c101f704340a9b388075496`. `node spikes/p0/native/android-alarm/check.mjs emulator-5588` passed after boot completed and the runner accounted for an extra carriage return in the Windows ADB console response. `npm.cmd --prefix spikes/p0 run test:portable` passed 149/149, and `node --test spikes/p0/reminder-evidence.test.mjs spikes/p0/reminder-push/*.test.mjs` passed 22/22. [Reproduction](../spikes/p0/native/README.md#android-pre-armed-alarm-rehearsal)

The operator verified fixture uninstall, install receipt removal and no ADB mappings for the selected emulator. The emulator processes and listeners exited. A file handle briefly delayed cleanup of the emulator logs. A retry removed the owned AVD directory and verified its absence.

The fixture verified a pre-armed callback with the emulator screen off. Physical notification display, exact timing, idle and reboot behavior, and server-driven arming and cancellation remain open. The next physical comparison needs owner approval and actual visible receipt evidence from a separate native notification fixture. [Device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery)

### Android native visible alarm fixture

Prepared a separate owner-operated debug fixture on November 25. An explicit tap arms one inexact elapsed-time alarm due two minutes later. The fixture displays the matching suffix and UTC cutoff and saves its one-shot callback and display result privately. The receiver persists the claim before requesting display and suppresses requests after the five-minute cutoff. The APK declares only `POST_NOTIFICATIONS`. Its Android v2 signature verified, and SHA-256 is `d7e3a1f313fb51ca1307fb2616728478d8bce1bbdaddae58facb69d538fdce15`. [Build and verification commands](../spikes/p0/native/README.md#android-native-visible-alarm-fixture)

`./src-tauri/gen/android/gradlew.bat --offline --console=plain -p spikes/p0/native/android-alarm-visible assembleDebug` passed. The host Java check passed with an injected request for success, permission denial, channel blocking and failure. It also verified identity matching, duplicate suppression, the elapsed cutoff, and simulated write failure before and after the durable claim. `npm.cmd --prefix spikes/p0 run test:portable` passed 149/149. The existing offline reminder suite passed 22/22.

`node spikes/p0/native/android-alarm-visible/check.mjs emulator-5586` passed on a disposable, offline API 36 x86_64 emulator. A System UI ANR dialog blocked the first launch. After that dialog cleared, the same APK opened its own system permission prompt. Denial disabled arming, left no plan, and persisted through a fresh launch. The smoke verified uninstall and removal of its temporary UI dump. The operator verified removal of the install receipt, selected ADB mappings, emulator processes, listeners and AVD files. Native lock-screen visibility still requires the separately approved, owner-observed phone run. [Owner procedure and scoring](p0-reminder-owner-test.md#android-native-locked-screen-comparison)

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

### Windows native sign-out over loopback HTTP

Tested source `61def53d26951fb96201d9694844b86af5d15087`. The Windows Rust fixture read a synthetic successor from current-user DPAPI. Before each dispatch, the test verified that the on-disk journal contained `pending`. A disposable HTTP server on IPv4 loopback checked all five requests for the expected method, mutation path, content type and token-bearing JSON body. It then dropped the first reply. Malformed JSON, a missing value and a 503 carrying a success envelope also left the ciphertext byte-identical and blocked resume. Only the HTTP 200 response carrying an explicit null completed cleanup.

From the repository root, `cargo test --locked --offline --manifest-path spikes/p0/native/src-tauri/Cargo.toml --features p0-session --lib` passed 27 tests, with one subprocess entry exercised by its parent tests. Cargo formatting passed. The packaged fixture shares request construction and acknowledgment handling. The packaged follow-up below exercises the HTTP path through WebView2.

### Packaged Windows sign-out over loopback HTTP

Tested source `5c3183d0cb88d71299384b2c70cdb427208687c2` with WebView2 158.0.4370.33. Clicking Sign out in the previous executable produced zero HTTP requests. A first HTTP build sent the correct request but held the provider mutex until the HTTP timeout when the issuer waited for a concurrent SDK denial. The corrected build releases that mutex after recording intent and keeps the DPAPI slot locked through acknowledgment and cleanup.

From `spikes/p0`, run `node native/package.mjs --target windows --session --sign-out-http`, then `node native/smoke.mjs windows-sdk-signout-loopback native/src-tauri/target/sign-out-http/debug/windows_session.exe`. The resulting debug executable had SHA-256 `ef7197443007426697d61b4a6ad92a79f4e224690c4ae3c48c2403e91b6532ab`. Three fresh hosts passed. The first denied SDK access while the HTTP request was still open. After the server dropped the reply, the second host denied resume and retained byte-identical ciphertext. Its retry presented the same inert successor, received an explicit null, and cleared the slot. The third host stayed signed out. The runner scanned 172 retired profile files and removed the fixture. The unsigned Windows CI workflow now runs this case.

Both `cargo test --locked --offline --manifest-path native/src-tauri/Cargo.toml --features p0-session --lib` and the same command with `--features p0-windows-sign-out-http` passed 28 tests, with one subprocess entry exercised by its parent tests. The integrated portable suite passed 55/55. The HTTP server and issuer were synthetic. Packaged native sign-in and refresh against an actual issuer, hosted revocation, and authenticated reconnect remain open. [Build and smoke procedure](../spikes/p0/native/README.md#packaged-windows-http-sign-out-fixture)

### Packaged Windows cold refresh over loopback HTTP

Tested source `0fb540d2ced4c82d56931a3a7032b2040c05a5cc`, WebView2 158.0.4370.33. The prior executable sent zero refresh mutations when the harness clicked Resume. The integrated build sent `auth:refreshSession` with the marker read from DPAPI. Four fresh hosts covered the initial seed and three cold launches. HTTP 503 with a misleading `noSession` body denied access and left the ciphertext byte-identical. HTTP 200 with a valid rotation produced a protected successor by the first observed native authentication reply. The final host presented that successor, received HTTP 200 with `noSession`, and cleared only its session slot. While each reply was withheld, both an SDK access request and a native task-list request returned `unavailable`. Each retired profile scan in the final refresh and sign-out runs inspected 176 files for known canaries.

From `spikes/p0`, build with `node native/package.mjs --target windows --session --sign-out-http`. Run `node native/smoke.mjs windows-sdk-refresh-loopback native/src-tauri/target/sign-out-http/debug/windows_session.exe`, then repeat with mode `windows-sdk-signout-loopback`. Both passed with executable SHA-256 `569aba6599da0ae6456e37950913123c4ac008a15c625dce84f12cd133564f4c`. During integration the harness initially mistook an overlapping access denial for the resume reply. The corrected check verifies both denials before accepting the resume result. The portable suite passed 58/58. The locked offline Rust library suites passed 28 tests with `p0-session` and 29 with `p0-windows-sign-out-http`, each with one subprocess helper exercised by its parent test. [Native fixture commands](../spikes/p0/native/README.md#packaged-windows-cold-refresh-over-http)

Issuer outcomes and subsequent SDK traffic were simulated. Native hosted sign-in, refresh and authenticated reconnect remain open. Review identified a separate same-owner session replacement case, exercised below.

### Windows session replacement for the same owner

Tested source `ed7462674850e7e81f4bf7f01b6648a0dc5ea906`. The native regression kept two provider instances alive in the test process while child processes rotated the grant and later signed out and reseeded the same synthetic owner. The surviving instances could use the rotated session. After replacement, their next SDK and native task checks denied access, the native task subscription cleared, and the replacement ciphertext stayed intact. Explicit Resume restored access. These checks exercise native access boundaries; an open hosted subscription's response to issuer revocation still needs a provider-issued session.

The DPAPI record carries a randomly generated session identifier across rotations. A successful resume upgrades an older marker-only fixture record. A child terminated before publication left the original readable for retry. From the repository root, `cargo test --locked --offline --manifest-path spikes/p0/native/src-tauri/Cargo.toml --features p0-session --lib` passed 30 tests. The same command with `p0-windows-sign-out-http` passed 31. Each suite exercises its subprocess helper through its parent tests.

An already-open SDK panel can use a cached bearer for reads or receive subscription updates between native access checks. The fixture's per-WebView transport cannot establish when a real issuer stops those operations. Revoke the observed session while its subscription stays open. A separate login for the same owner remains a positive control. Record both an explicit read and the existing subscription before reconnect or forced token refresh. [Local provider acceptance procedure](../spikes/p0/README.md#local-provider-acceptance-for-an-open-subscription)

Packaged regressions on WebView2 158.0.4370.33 passed across 24 fresh hosts. From `spikes/p0`, build with `node native/package.mjs --target windows --session` and run `node native/smoke.mjs windows-session` (6 hosts) and `node native/smoke.mjs windows-sdk` (11). Add `--sign-out-http` to the build command and use the [HTTP fixture commands](../spikes/p0/native/README.md#packaged-windows-http-sign-out-fixture) for cold refresh (4) and sign-out (3). The session replacement case itself ran in the native process test above.

### Packaged Windows initial sign-in over loopback HTTP

At `98071ffd0be7f424b90ea2b13aed17add4ab5958`, the packaged Windows Start synthetic session action sent `auth:signInWithUsernamePassword` over IPv4 loopback with the pinned Convex argument shape. The previous executable sent zero requests and failed the new assertion. An HTTP 200 response carrying the simulated `USER_NOT_FOUND` result denied sign-in, left the DPAPI file absent and opened zero SDK sockets. The next response supplied a valid inert grant. Its refresh marker entered the protected record, and starting again preserved the ciphertext and sent no extra mutation. Three subsequent cold launches exercised outage, rotation and expiry using that record. The separate sign-out regression passed in three fresh hosts.

From `spikes/p0`, run `node native/package.mjs --target windows --session --sign-out-http` and `node native/smoke.mjs windows-sdk-refresh-loopback native/src-tauri/target/sign-out-http/debug/windows_session.exe`. Repeat the smoke with `windows-sdk-signout-loopback`. WebView2 158.0.4370.33 passed both runs. The executable SHA-256 was `827b444948797d8a74e08471bc2de7ef6a8c87a045d8e1bdd5a48b3e4a64a739`. The portable suite passed 60/60 and the two offline Windows Rust library suites passed 30 and 31 tests. [Fixture procedure](../spikes/p0/native/README.md#packaged-windows-cold-refresh-over-http)

Independent review matched the mutation and response shape to the pinned SDK sources. The fixture sends its own HTTP request and omits the SDK's client-identification header. A follow-up four-host run also checked that denial left no staging file before retry. The server returned scripted responses to fixed public inputs. The remaining issuer-level gate requires provider-issued sessions, authenticated subscriptions, and observation of an already-open client after revocation. The subsequently approved [local provider run](#packaged-windows-revocation-on-a-real-local-provider) exercised that case on Windows. Hosted acceptance remains a separate run.

### Task links on static and Tauri origins

Tested source `160ae616afd93b8df1cc42d24a8417bd02a2e929`. A browser created a synthetic task under the nested static mount `/klaxon/p0/`. Opening its fragment in a fresh page and reloading each requested the mount itself. The ID in the address matched the stored task row on both reads. Directly opening the equivalent history path returned 404 on this server, which had no rewrite. Packaged Windows WebView2 158.0.4370.33 reopened the same type of fragment after a native process restart. Its asset handler also served the fixture after navigation and reload at the history-style path.

From `spikes/p0`, `npm run build` and `npm run test:portable` passed, including all 48 tests. The focused command is `node --test --test-name-pattern="task fragment" portable.test.mjs`. The Windows command was `node native/smoke.mjs windows`. This exercised document loading and stable row identity. OS link dispatch, Android routing and the account-scoped detail view remain open. [Routing decision](adr/p0-architecture.md#shared-client-and-backend)

### Obsidian desktop note links

Tested source `c7aa7fffbaded239db1898a9da26661a0a2048cf` with the installed Windows Obsidian executable, product version 1.12.7.0. From the repository root, run `node spikes/p0/obsidian-desktop.mjs "<absolute path to Obsidian.exe>"` with the locked spike dependencies installed. Two consecutive runs passed in separate disposable profiles. Each verified the runtime vault root, switched between two notes using explicit app URIs, renamed the selected nested Unicode note with the vault API, and reopened it using its updated path. The active file matched and its synthetic contents survived. The fixture added no plugin and used no account.

An initial Electron automation launch timed out before attaching. Its verified test directory was removed. The final runner attaches through the port published by its own disposable profile. A missing executable also failed cleanly. After both successful runs and the missing-executable check, the fixture directory count and running Obsidian process count were both zero. The URI was passed to the installed app with the fixture profile. Windows OS-wide link dispatch, automatic rename tracking and per-device credentials remain open. [Android rehearsal](#obsidian-android-note-links)

Review follow-up `f97703e3f48a88160c0e9d2b68245ea57aed4515` normalizes the temporary parent and bounds the wait for the fixture process to exit. The desktop command passed with ordinary Windows paths and with forward slashes in both `TEMP` and `TMP`. An immediate combined cleanup check fired during process retirement. The later inventory confirmed zero remaining test directories and zero running Obsidian processes.

### Obsidian Android note links

Passed on November 25, 2026, from draft head `79fce3287989f8538026860a40009275fdad9104`. Obsidian 1.15.1 ran on the disposable API 36 x86_64 emulator with airplane mode on, Wi-Fi off and no default network. The official APK supported x86_64, verified under APK Signature Scheme v2, and matched the published SHA-256 `577cd2e1289c00a6c11b230b7bc562029a116382cb2b9dea2a24b5bb7495836e`. [Official release assets](https://github.com/obsidianmd/obsidian-releases/releases/expanded_assets/v1.15.1)

Two account-free, app-storage vaults contained `Planning/First café note.md` with distinct visible body markers and one control note each. Implicit Android `ACTION_VIEW` resolved to Obsidian. Fresh UI Automator dumps confirmed A, B and A again at the same path. After force-stopping Obsidian, a cold `ACTION_VIEW` opened B in a distinct process and displayed its marker. Renaming A through the app preserved its body. Its updated path opened after switching to a control note, and B's original link still opened B's body.

The initial launch stalled behind an Android System UI dialog and recovered after selecting **Wait**. A manually entered B selector omitted a trailing space from the actual vault name. Android returned `Status: ok` but the previous note stayed visible. **More options → Copy path → as Obsidian URL** exposed the exact encoded vault name, including that space. The copied selector passed. Preserve the exact device-local locator and encode it separately from the note path. Obsidian 1.15.1 returned `Unrecognized URI action: choose-vault`, so the operator used the app's vault switcher.

To reproduce, start with a disposable offline emulator that has no Obsidian install. Verify and install the pinned APK, choose **Continue without sync** and create both vaults in **App storage**. Start from a visible control note with distinct synthetic content in each vault. Use the app's copied URL when selecting a vault, and verify the note title and body after each dispatch with a fresh `uiautomator dump`. A successful intent status only verifies dispatch. A cold check also requires the original process to exit and a distinct new PID. [Obsidian URI reference](https://obsidian.md/help/uri)

```powershell
$uri = 'obsidian://open?vault=Klaxon%20P0%20Vault%20B%20&file=Planning%2FFirst%20caf%C3%A9%20note'
adb -H 127.0.0.1 -P 5037 -s emulator-5586 shell "am start -W -a android.intent.action.VIEW -d '$uri'"
adb -H 127.0.0.1 -P 5037 -s emulator-5586 shell uiautomator dump /data/local/tmp/klaxon-obsidian-ui.xml
```

The operator removed the fixture UI captures from the emulator, uninstalled Obsidian and verified package absence and empty ADB mappings. The emulator was stopped by 14:39:31 UTC. Klaxon's eventual launch path, physical Android, automatic rename tracking and plugin credential revocation remain open.

### Session fixture packaging boundary

Both unsigned draft checks passed at `1723242be745915156876b4803b936cc6da627fc`, including the Windows rehearsal with the process-identity fix and the native HTTP library test. [CI run](https://github.com/willherr72/Klaxon/actions/runs/45522045921)

The packager regression at `72a9bdbc6da19ce813095c2e89d9fb3fe8f33d3c` exercised three unsupported invocations: Windows and x86_64 Android session builds with a hosted origin, and an arm64 Android session build. All three stopped before writing a build artifact. Removing the guard in a temporary copy made the new test fail. From `spikes/p0`, `node --test native/package.test.mjs` passed 3/3 and `npm run test:portable` passed 49/49.

### Windows CI process identity

Unsigned Windows [job 138911905705](https://github.com/willherr72/Klaxon/actions/runs/45526651851/job/138911905705) on `5c63053` stopped during attachment in `node native/smoke.mjs windows`. The PowerShell process inventory exceeded its ten-second deadline. Its duration on that runner is unexplained. At `ec156ab77626aecda636aa738fc5eaa41fd54592`, the harness discards partial output and repeats the read once on timeout. A second timeout or any other error stops the operation. Both new regression cases failed before the change. `node --test spikes/p0/native/windows-process.test.mjs` passed 5/5, and a forced one-millisecond first PowerShell query recovered the current process identity on retry. The ordinary Windows smoke and all 60 portable tests passed locally.

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

On November 25, three browser regressions reproduced premature freshness at `4a8ce33433296fd919cb471f2499d44aca994280`. The old UI dropped its stale label as soon as the socket reopened or the browser returned online. The P0 portable client now preserves the last available rows and timestamp, pauses Create and Rename, and ignores a read that completes after its connection epoch ends. A fresh subscription result or an HTTP read started and completed on the current connection restores write eligibility under the existing authentication gate. The tests held a previous HTTP result through reconnect, withheld subscription results until recovery and exercised a browser offline/online event while the intercepted socket stayed open. They verified no write was sent while stale, even when the form received a submission event, and that recovery preserved the task ID.

From `spikes/p0`, run `node --test --test-name-pattern 'reopened transport|browser network recovery' account-session.test.mjs` for the targeted cases. The tests use the bundled Convex SDK in Edge with synthetic HTTP and WebSocket traffic. This establishes portable browser behavior with in-memory rows. Physical hosted network loss and native offline cache behavior remain open. [Portable procedure](../spikes/p0/portable.md#physical-desktop-off-acceptance)

From the repository root, `npm.cmd --prefix spikes/p0 run build` built the local fixture, `npm.cmd --prefix spikes/p0 run test:portable` passed 155/155, and `npm.cmd test` passed 65/65.

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

P0-07 cost follow-up at `5c6305315be86fa52e12e4969a1342f89fbb80c6`: anonymous GitHub metadata confirmed the repository is public. Workflow inspection confirmed both jobs run on standard Ubuntu and Windows hosts. Their compute falls under GitHub's public repository allowance. [Cost evidence](deployment.md#unsigned-validation-costs)

- P0-01. Baseline architecture and regression evidence belong in [testing](testing.md) and [migration](migration.md). Tested source `2eec1b406400010e8f5ccc6c45b1f32229d8bcfe` with `python spikes/migration/probe.py`. The original read-only check overlooked an extra orphaned step. The corrected probe detected both a missing parent and a parent that was an ordinary reminder in separate synthetic schema-17 databases. Both file hashes survived rejection.
- P0-02/03. Branch created from the production baseline. Hosted isolation, authenticated web/native sessions and desktop-off synchronization require separate evidence. See [spike](../spikes/p0/README.md).
- P0-04/05/06. Track provider support, actual identity/device observations and fallbacks in the [platform investigation](adr/platform-capabilities.md) and [Dot playbook](dot-playbook.md).
- P0-07. The owner confirmed Free for the spike. A read-only review on November 24, 2026 verified the allowances in the [cost record](deployment.md) against [Convex pricing](https://www.convex.dev/pricing) and [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/). The [two-device task-list estimate](deployment.md#p0-single-owner-task-list-estimate) projects 1,980 calls and 30 MB database I/O over 30 days under its stated assumptions. Deployment region, actual shared-team usage and remaining capacity are unverified. [Hosted native refresh and revocation](#hosted-packaged-native-acceptance) passed on Windows and the Android emulator. Physical native acceptance, background and closed-app delivery, and scoped Dot execution remain open. [Architecture ADR](adr/p0-architecture.md) · [Security](security.md) · [API boundary](api/README.md)

## Backlog register

| ID | Planned PR scope | Status | PR / verification |
|---|---|---|---|
| P0-01 | Baseline | Inventoried | [Test results and historic CI failures](testing.md) |
| P0-02 | Isolation | Complete | v2 branch and disposable hosted Development deployment in owner-confirmed Free team. Preflight returned zero tables and zero functions. Only synthetic fixtures enrolled. [PR 14](https://github.com/willherr72/Klaxon/pull/14) |
| P0-03 | Auth/realtime spike | Owner-reported desktop-off smoke passed | [Owner report and remaining tests](#remaining-p0-tests). The [Windows](#packaged-windows-dpapi-session-evidence) and [Android](#packaged-android-session-evidence) packaged synthetic resume/sign-out tests passed. Windows and Android both restored and revoked a hosted packaged session. [Platform evidence and remaining gates](#hosted-packaged-native-acceptance). |
| P0-04 | Dot spike | Scheduled browser read/write and browser create passed | [Scheduled Windows-off run](dot-playbook.md#scheduled-browser-fallback) · [Browser create evidence and limits](dot-playbook.md#browser-create-acceptance) |
| P0-05 | Integrations | Interfaces reviewed, desktop and emulator Obsidian note links exercised | [Scopes and unresolved tenant consent](adr/platform-capabilities.md). The [Windows runtime test](#obsidian-desktop-note-links) opened a nested Unicode note before and after manually reconciling its rename. The [Android emulator](#obsidian-android-note-links) selected both mapped vaults and reopened a renamed path. Credential revocation and Klaxon's launch path remain open. |
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
