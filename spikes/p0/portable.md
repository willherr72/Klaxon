# Portable P0 device check

The build produces one self-contained Svelte page at `dist/index.html`. It can cold-start from device storage with Windows powered off. The default build exercises local fixture storage. The enrolled-account build adds HTTPS requests and a WebSocket subscription to the existing disposable Convex Development deployment.

## Build and exercise the local fixture

From `spikes/p0` with Node 24 and the locked dependencies installed, run the following in PowerShell.

```powershell
Remove-Item Env:P0_PUBLIC_DEV_ORIGIN -ErrorAction SilentlyContinue
npm ci
npm run build
npm run test:portable
```

On Windows the test uses installed Edge. Linux CI uses Chromium installed by `npx --no-install playwright-core install --with-deps chromium`. Set `P0_CHROMIUM_EXECUTABLE` to select an existing compatible browser. The tests load the prebuilt default artifact directly from disk. They also build a temporary account artifact with an invented origin and intercept its HTTP and WebSocket traffic before opening the page.

Copy the HTML file to a device or open the packaged P0 shell. For a browser file, use the same path and profile throughout. Browser support for JavaScript and storage in downloaded HTML varies. If the device's file viewer previews the source or blocks scripts or storage, use the P0 shell or serve the copied artifact from loopback on that same device.

1. Open the page and confirm **Local fixture**. Turn off the device's network. At **Browser network offline**, create a uniquely named synthetic task. Record its displayed ID and title.
2. Rename it and select **Read tasks**. Close the page or app, keep the network off, and reopen it. Check the same ID and new title.
3. Reconnect, read again, and compare the ID and title. The browser's network indicator reports local connectivity. These edits live in the device's browser or WebView storage. The fixture has no account or server subscription.

The browser test also fills real local storage to quota, attempts a rename, checks the previous value in a second page, frees space and retries the preserved draft. This is device-local recovery evidence.

## Prepare an enrolled-account copy

Use the owner-confirmed public HTTPS origin of the already provisioned synthetic **Development** deployment. A hostname alone cannot distinguish a production deployment. The build only reads `P0_PUBLIC_DEV_ORIGIN` for the endpoint and does not contact it. Provide the already enrolled username and password interactively after opening the page. An empty or unset origin selects fixture mode.

```powershell
$env:P0_PUBLIC_DEV_ORIGIN = 'https://<confirmed-dev-name>.convex.cloud'
npm run build -- --outdir dist/account
Remove-Item Env:P0_PUBLIC_DEV_ORIGIN
```

Copy `dist/account/index.html` to the test devices before shutdown. Static files do not require external hosting. On a physical Android device that needs a local HTTP origin, copy the account file to a dedicated empty directory on the phone and serve that directory from an already installed local terminal with `python -m http.server 8765 --bind 127.0.0.1`. Open `http://127.0.0.1:8765/index.html` in the phone's browser. Keep that local server running. Internet access on the phone is still required for Convex. Confirm the page displays **Convex account** and the intended origin.

## Physical desktop-off acceptance

Will reports that the one-task desktop-off smoke passed on physical Android and Windows. The [P0 register](../../docs/klaxon-v2-progress.md#remaining-p0-tests) records exactly what he observed. The extended procedure below can collect timing, IDs and interruption evidence on a future run.

Use a physical Android phone, the Windows PC and preferably a second independent device to witness live changes while Windows is off. ADB forwarding, USB tethering, a Windows-hosted page and an emulator cannot establish independence from the PC.

1. With Windows on, open the account copy independently on Windows and Android. Sign into the same enrolled synthetic account on both. Wait for **Subscription connected** and the first read time. From Windows create a uniquely named synthetic task. On Android record its ID, title and UTC read time.
2. Shut Windows down fully. Disconnect any USB cable. Use Android's independent internet connection. Close and reopen the account page on Android, sign in again, then select **Read tasks**. Capture the same ID/title and time. Select **Refresh session**.
3. Rename that task on Android and create a second uniquely named task. Record both IDs, titles and acknowledgments. If available, open the same account copy on an independent second device and observe the subscribed changes while Windows is still off. Close and reopen Android, sign in and read to verify the server values independently of its earlier page state.
4. Disconnect Android's network with the rows on screen. Confirm the UI labels them as last available, displays the earlier read time and disables writes. Reconnect, wait for the subscription, then select **Read tasks**. After an unconfirmed write, read before retrying to avoid creating a duplicate.
5. Restart Windows, reopen the local account copy, sign in and verify both IDs and titles. Sign out on each device. Record device/OS/browser versions, how each copy was served, network paths, Windows shutdown/start times, UTC read times and observed results. Exclude credentials and tokens from evidence.

Account rows and access/refresh tokens live in memory. A cold launch requires login. An explicit refresh rotates the session and confirms authentication. **Read tasks** makes a fresh owner-scoped query. After reconnect, the page keeps the old rows labeled **Last available rows** and pauses writes until it receives a current subscription snapshot or completes a fresh read while the new socket stays connected. A read interrupted by a lost connection is discarded. Results from a read started before the first socket opens can be displayed with the stale label. If the subscription is connected and the rows remain stale, select **Read tasks**. Only confirmed cloud writes satisfy the hosted gate. Packaged clients have a separate [native session rehearsal](native/README.md#hosted-packaged-native-acceptance).

**Refresh session** accepts a complete grant for the signed-in owner with a new refresh token. An unrecognized reply leaves the previous token available for retry or sign-out. If rotation succeeds but the subsequent authentication check cannot be confirmed, retry uses the successor. An exact `noSession` refresh result or a confirmed `false` authentication check clears the view. A failed automatic SDK refresh returns the user to sign-in.
