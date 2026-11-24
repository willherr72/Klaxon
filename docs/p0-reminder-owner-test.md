# One-time reminder check on Windows and Android

**Focused test passed on both devices, owner-reported November 24, 2026.** Will confirmed removal of both subscriptions. The operator stopped the Cloudflare Quick Tunnel and loopback server and verified that the listener, operator run directory, test key files and both matching exports in Windows Downloads were absent. Deletion of the original export in Android Downloads remains unconfirmed. The temporary receiver is retired. [Provisioning record](klaxon-v2-progress.md#one-time-reminder-sender-and-receiver-rehearsal) · [Quick Tunnel lifetime](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Before inviting Will

1. From the repository root, run the mock rehearsal with `node spikes/p0/reminder-push/rehearse.mjs`.
2. Obtain approval for a disposable $0 HTTPS origin, test-only VAPID keys, two enrollments, private subscription handoff, one send per target and cleanup. Install the locked sender with `npm ci --prefix spikes/p0/reminder-push --ignore-scripts --no-audit --no-fund`. Use its `generateVAPIDKeys()` locally to create a disposable P-256 pair. Write the return value directly to private operator storage. Keep secrets outside Git, chat, logs and the web root.
3. Put only the public VAPID key in a staged copy of `spikes/p0/reminder-push/receiver/public-key.mjs`. Serve that receiver directory alone on its dedicated HTTPS origin with JavaScript MIME type for `.mjs`. Give Will its `index.html` URL. [Edge push setup](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push) · [Chrome subscription setup](https://web.dev/articles/push-notifications-subscribing-a-user)

## Will’s focused two-device check (completed)

1. Open the URL in regular Windows Edge and Android Chrome tabs. Select **Windows Edge** or **Android Chrome** accordingly. Note OS/browser versions, notification, Do Not Disturb and power settings.
2. Select **Enable test reminders**, grant the site permission, then **Save private subscription**. Give the two downloaded files to the operator through the approved private channel. If either enrollment fails, skip the send and clean up partial enrollments using step 4.
3. Keep both tabs focused, screens unlocked and devices online. Tell the operator to send. Watch for **Klaxon P0 test** for five minutes, including Windows Notification Center and the Android notification shade. Record the target and ID from each OS notification, first-seen UTC time and copy count. Record “none seen” at cutoff and any later sighting separately.
4. Select **Read worker receipt**. Record the matching worker time or “none recorded.” Select **Remove test subscription** and delete the downloads. The operator deletes the private inputs and retires the test key and origin. Reset only the test site’s permission if approved.

## Current physical run: Windows Edge, screen locked

The owner approved one new synthetic reminder on Windows Edge. Android is outside this run. The operator staged a Windows-only receiver on a fresh disposable HTTPS origin, verified its five public resources and restricted file serving, and gave the setup link to the owner. The live URL and private exports stay outside the repository.

1. **Enroll.** Open the supplied link in regular Windows Edge. Click **Enable test reminders**, allow notifications for this site, then click **Save private subscription**. Leave `windows-edge-locked-test-subscription.json` in Downloads. Tell the operator enrollment is complete and keep the PC unlocked until a time is agreed.
2. **Agree on the window.** The operator privately validates the Windows export and sends the synthetic occurrence ID, proposed lock time, send time and earliest unlock time. Confirm the times before the operator arms the single attempt. Choose a window compatible with the PC’s existing sleep settings. Leave Edge running, minimize the window and lock Windows before the send time.
3. **Observe.** During the five-minute window, note the first-seen time and number of Windows lock-screen notifications matching **Klaxon P0 test**, `windows-edge` and the agreed occurrence ID. Record a hidden preview as uncertain. Record a first sighting after unlock separately.
4. **Read and clean up.** After unlocking, return to the same page and select **Read worker receipt**. Record the matching occurrence, worker timestamp, display-request result and any duplicate rows before clicking **Remove test subscription**. Confirm removal. The operator records the actual attempt and result, removes the scoped export and disposable private files, then retires the receiver. An uncertain send consumes the single attempt.

For this run, the operator must set `targetMode` to `windows-only` in the private sender input and include only `subscriptions["windows-edge"]`. The sender rejects any extra subscription before claiming the run. Use the same private run directory throughout so the one-shot ledger covers every attempt.

## Two-device background procedure (requires separate approval)

**Pending on both devices.** This is a new one-time run. The focused run’s origin, subscriptions and key were retired. Before provisioning, agree with Will on a five-minute observation window and approval for the fresh receiver, two enrollments, one send per device and cleanup. The existing fixture supports this row without code changes.

1. **Enroll and agree on the time.** Use the disposable browser contexts specified in the device matrix and follow the enrollment steps above. Set a UTC send time far enough ahead for Will to lock both devices. Share the synthetic occurrence ID for matching. The sender and HTTPS origin must remain reachable while Windows is locked. If Windows also hosts them, confirm the observation window fits its existing sleep settings. If either enrollment fails or the setup cannot stay ready, stop before sending.
2. **Will prepares both devices.** With both online, leave the test tab open in each browser. Minimize Edge, return Android to its home screen, and lock both screens before the agreed send time. Record the lock times, browser and OS versions, and existing lock-screen preview and power settings. Keep those settings as found. Agree on readiness before locking so neither device has to be unlocked to message the operator.
3. **Operator sends once.** Use the operator command below with a new private run directory. Retain the per-target attempt times and provider results. Observe for five minutes after each target’s attempt. Windows is attempted first, with a 15-second request timeout before Android. Agree on an unlock time with margin for the second attempt, then score each device from its recorded `attemptedAt`. If either device unlocks early, the browser closes or there is a gap in observation, record it for that target.
4. **Will records what was visible.** For each device, record the first-seen UTC time and number of matching notifications seen while locked. If a preview hides the identifying text, record what was visible and mark the match uncertain. Record an item first seen after unlocking separately. A matching receipt, a resolved display request or an item found in notification history cannot establish when the OS first displayed it.
5. **Compare and clean up.** After the observation window, unlock and read the worker receipts before removing subscriptions. Match target and occurrence ID, count receipt rows, and note each worker UTC time and `displayRequest` value. Record transport acceptance, worker receipt, visible locked-screen delivery, later sightings and cleanup separately for each device. Use “none seen by cutoff” or “unobserved” as appropriate. Follow the cleanup in step 4 of the focused check. An inconclusive target stays open; the one-shot sender is never retried for that occurrence.

## Operator send, once both devices are ready

In a new private directory outside the checkout, create `input.json` with a fresh lowercase UUID v4 in `occurrenceId`, `vapidDetails` containing `subject` (operator’s `mailto:` contact), `publicKey` and `privateKey`, and `subscriptions` containing the downloaded objects under `windows-edge` and `android-chrome`. The fixture supports HTTPS push subscriptions at `fcm.googleapis.com` and, for Windows, `*.notify.windows.com`. Stop if a browser selects an unsupported service.

At the agreed due time run `node spikes/p0/reminder-push/send-once.mjs <private-run-dir>` from the repository root. Record each transport result. Preserve `attempted.json` and stop after these attempts, including an uncertain result. The 300-second TTL bounds requested push-service retention. The five-minute observation window measures what Will sees.

| Target | Sender attempt | Push service status | Worker receipt | Visible OS notification | Subscription removal |
|---|---|---|---|---|---|
| Windows Edge, focused | 20:19:05 UTC, Nov 24 | HTTP 201 | Will saw the matching receipt | Will saw one copy | Will confirmed removal |
| Android Chrome, focused | 20:19:05 UTC, Nov 24 | HTTP 201 | Will saw the matching receipt | Will saw one copy | Will confirmed removal |

The sender recorded both provider responses. Will verified the worker receipts on the test pages and visible delivery on the devices. Worker receipt and first-seen timestamps remain unrecorded. These two focused cells are complete. The other ten device cells remain pending. [Web Push delivery semantics](https://www.rfc-editor.org/rfc/rfc8030.html#section-5) · [Full device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery)
