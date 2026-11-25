import assert from "node:assert/strict";
import { anyApi as api } from "convex/server";

const localOrigin = "http://127.0.0.1:3210";
const deadline = { timeout: 30_000 };

async function verifiedPage(page) {
  await page.waitForFunction(() => window.p0LocalProvider !== undefined, undefined, deadline);
  assert.ok(await page.evaluate(() => location.origin === "http://tauri.localhost" &&
    typeof window.__TAURI__?.core?.invoke === "function"), "Expected the packaged Tauri WebView");
  assert.equal(await page.getByRole("list", { name: "Local provider tasks" }).getByRole("listitem").count(), 0);
}

export async function verifyHostedPage(page, origin) {
  await verifiedPage(page);
  assert.equal(await page.locator('meta[name="p0-hosted-provider"]').getAttribute("content"), origin);
  assert.equal(await page.evaluate(() => window.p0LocalProvider.origin), origin);
  assert.equal(await page.evaluate(() => window.__TAURI__.core.invoke("local_provider_origin")), origin);
}

export async function exerciseLocalProvider({
  launch, control, stranger, taskId, title, updatedTitle, relay, verifySlotCleared, waitForControlTitle,
  origin = localOrigin, hostedReconnect = false,
}) {
  let stage = "local clients and fixture input";
  try {
    const reconnect = relay || hostedReconnect;
    const verifyPage = hostedReconnect ? page => verifyHostedPage(page, origin) : verifiedPage;
    assert.ok(control.url === origin && stranger.url === origin);
    assert.ok(typeof taskId === "string" && taskId.length > 0);
    assert.ok(typeof title === "string" && typeof updatedTitle === "string" && title !== updatedTitle);
    const matches = (rows, expectedTitle) => rows.some(task => task._id === taskId && task.title === expectedTitle);
    const list = client => client.query(api.tasks.list, {});
    const authenticated = client => client.query(api.auth.isAuthenticated, {});

    stage = "initial control read";
    assert.ok(await authenticated(control) === true);
    const initialControl = await list(control);
    assert.ok(matches(initialControl, title));

    stage = "packaged sign-in";
    await launch(async page => {
      await verifyPage(page);
      await page.evaluate(() => window.p0LocalProvider.signIn());
      await page.waitForFunction(() => window.p0LocalProvider.signInResult !== undefined, undefined, deadline);
      assert.ok(await page.evaluate(() => window.p0LocalProvider.signInResult === "fixture-ready"));
    });

    stage = "packaged restart and observation";
    let observation;
    let controlEvidence;
    async function verifyControls() {
      stage = "same-owner control after revocation";
      assert.ok(await authenticated(control) === true);
      const survivingControl = await list(control);
      assert.ok(matches(survivingControl, title));

      stage = "authenticated cross-owner read and rename denial";
      assert.ok(await authenticated(stranger) === true);
      const strangerRows = await list(stranger);
      assert.ok(!strangerRows.some(task => task._id === taskId));
      await assert.rejects(stranger.mutation(api.tasks.rename, { id: taskId, title: updatedTitle }), error =>
        typeof error?.message === "string" && /(?:^|\n)(?:Uncaught )?Error: Task unavailable(?:\r?\n|$)/.test(error.message));
      assert.ok(await authenticated(stranger) === true);
      assert.ok(matches(await list(control), title));

      stage = "same-owner control rename";
      await control.mutation(api.tasks.rename, { id: taskId, title: updatedTitle });
      const renamedControl = await list(control);
      assert.equal(renamedControl.length, 1);
      assert.ok(matches(renamedControl, updatedTitle));

      await waitForControlTitle(updatedTitle);
      return {
        controlSubscriptionRenderedRename: true,
        initialControlRows: initialControl.length,
        survivingControlRows: survivingControl.length,
        renamedControlRows: renamedControl.length,
        strangerRows: strangerRows.length,
        strangerRenameDenied: true,
      };
    }

    await launch(async page => {
      await verifyPage(page);
      assert.ok(await page.evaluate(() => window.p0LocalProvider.signInResult === undefined));
      if (reconnect) {
        await page.exposeFunction("p0VerifyControlRename", async () => {
          try { controlEvidence = await verifyControls(); }
          catch { throw Error("Independent control verification failed"); }
        });
        if (relay) await page.exposeFunction("p0DisconnectTransport", async () => { await relay.disconnect(); });
        await page.exposeFunction("p0RestoreTransport", async () => {
          // Native deletes the record after the issuer acknowledges and rejects refresh.
          await verifySlotCleared();
          await relay?.restore();
        });
      }
      await page.evaluate(expected => { window.p0LocalProvider.observe(expected); },
        { taskId, title, reconnectPort: relay?.port, hostedReconnect });
      await page.waitForFunction(() => window.p0LocalProvider.result !== undefined, undefined, { timeout: 60_000 });
      observation = await page.evaluate(() => window.p0LocalProvider.result);
    });
    if (relay) {
      observation.relay = relay.evidence();
      if (observation.status === "passed") {
        assert.ok(observation.relay.connectionsBeforeCut > 0 && observation.relay.connectionsCut > 0 &&
          !observation.relay.cut && observation.relay.connectionsAfterRestore > 0,
          "The relay must observe a working upstream both before the cut and after restoration");
      }
    }
    if (observation.stage || (reconnect && observation.status !== "passed")) return observation;

    if (!reconnect) controlEvidence = await verifyControls();
    assert.ok(controlEvidence?.controlSubscriptionRenderedRename);
    return { ...observation, ...controlEvidence };
  } catch {
    // SDK and Playwright errors can embed private function arguments or network details.
    return { status: "failed", stage };
  }
}
