# One-time reminder check on Windows and Android

**Receiver provisioned, November 24, 2026.** The operator verified the temporary HTTPS link and supplied it directly to Will. The receiver uses a Cloudflare Quick Tunnel to a loopback server on the Windows test host. Keep the host awake and both processes running through cleanup. Restarting the tunnel changes the origin and makes the old link unusable. The owner-confirmed Free Convex Development deployment remains separate. [Provisioning record](klaxon-v2-progress.md#one-time-reminder-sender-and-receiver-rehearsal) · [Quick Tunnel lifetime](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## Before inviting Will

1. From the repository root, run the mock rehearsal with `node spikes/p0/reminder-push/rehearse.mjs`.
2. Obtain approval for a disposable $0 HTTPS origin, test-only VAPID keys, two enrollments, private subscription handoff, one send per target and cleanup. Install the locked sender with `npm ci --prefix spikes/p0/reminder-push --ignore-scripts --no-audit --no-fund`. Use its `generateVAPIDKeys()` locally to create a disposable P-256 pair. Write the return value directly to private operator storage. Keep secrets outside Git, chat, logs and the web root.
3. Put only the public VAPID key in a staged copy of `spikes/p0/reminder-push/receiver/public-key.mjs`. Serve that receiver directory alone on its dedicated HTTPS origin with JavaScript MIME type for `.mjs`. Give Will its `index.html` URL. [Edge push setup](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push) · [Chrome subscription setup](https://web.dev/articles/push-notifications-subscribing-a-user)

## Will’s two-device check

1. Open the URL in regular Windows Edge and Android Chrome tabs. Select **Windows Edge** or **Android Chrome** accordingly. Note OS/browser versions, notification, Do Not Disturb and power settings.
2. Select **Enable test reminders**, grant the site permission, then **Save private subscription**. Give the two downloaded files to the operator through the approved private channel. If either enrollment fails, skip the send and clean up partial enrollments using step 4.
3. Keep both tabs focused, screens unlocked and devices online. Tell the operator to send. Watch for **Klaxon P0 test** for five minutes, including Windows Notification Center and the Android notification shade. Record the target and ID from each OS notification, first-seen UTC time and copy count. Record “none seen” at cutoff and any later sighting separately.
4. Select **Read worker receipt**. Record the matching worker time or “none recorded.” Select **Remove test subscription** and delete the downloads. The operator deletes the private inputs and retires the test key and origin. Reset only the test site’s permission if approved.

## Operator send, once both devices are ready

In a new private directory outside the checkout, create `input.json` with a fresh lowercase UUID v4 in `occurrenceId`, `vapidDetails` containing `subject` (operator’s `mailto:` contact), `publicKey` and `privateKey`, and `subscriptions` containing the downloaded objects under `windows-edge` and `android-chrome`. The fixture supports HTTPS push subscriptions at `fcm.googleapis.com` and, for Windows, `*.notify.windows.com`. Stop if a browser selects an unsupported service.

At the agreed due time run `node spikes/p0/reminder-push/send-once.mjs <private-run-dir>` from the repository root. Record each transport result. Preserve `attempted.json` and stop after these attempts, including an uncertain result. The 300-second TTL bounds requested push-service retention. The five-minute observation window measures what Will sees.

| Target | Due / attempted UTC | Push service status | Worker receipt UTC or missing | First seen UTC, ID and copies | Owner acknowledgment |
|---|---|---|---|---|---|
| Windows Edge, focused | | | | | |
| Android Chrome, focused | | | | | |

Provider acceptance records transport. A worker receipt records browser processing. Count visible delivery only when Will sees the matching system notification. One matching copy per target passes the two focused cells. All other states remain pending. [Web Push delivery semantics](https://www.rfc-editor.org/rfc/rfc8030.html#section-5) · [Full device matrix](adr/platform-capabilities.md#ordinary-reminder-delivery)
