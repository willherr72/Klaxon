import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { exerciseLocalProvider, verifyHostedPage } from "./check.mjs";

const hostedOrigin = "https://fixture.example";
const taskId = "fixture-task";

function fixturePage(origin, hostedProbeVersion) {
  let expected;
  const window = {
    __TAURI__: { core: { invoke: async () => origin } },
    p0LocalProvider: {
      origin, hostedProbeVersion,
      signIn() { this.signInResult = "fixture-ready"; },
      observe(args) {
        expected = args;
        this.result = { status: "inconclusive", stage: "test ends at observation" };
      },
    },
  };
  return {
    evaluate(fn, arg) {
      return runInNewContext(`(${fn})(arg)`, { window, location: { origin: "http://tauri.localhost" }, arg });
    },
    async waitForFunction(fn) { assert.ok(await this.evaluate(fn)); },
    async exposeFunction(name, fn) { window[name] = fn; },
    getByRole() { return { getByRole: () => ({ count: async () => 0 }) }; },
    locator() { return { getAttribute: async () => origin }; },
    get expected() { return expected; },
  };
}

test("passes a hosted rename title that retirement accepts and that differs from both control titles", async () => {
  const marker = "f7da15dc-bffe-436a-a99a-8f071e1d9fc0";
  const title = "Hosted control edit " + marker;
  const updatedTitle = "Hosted provider fixture " + marker;
  const control = {
    url: hostedOrigin,
    async query() { return this.initialRead++ === 0 ? true : [{ _id: taskId, title }]; },
    initialRead: 0,
  };
  const observationPage = fixturePage(hostedOrigin, 1);
  const pages = [fixturePage(hostedOrigin, 1), observationPage];
  const result = await exerciseLocalProvider({
    control, stranger: { url: hostedOrigin }, taskId, title, updatedTitle,
    origin: hostedOrigin, hostedReconnect: true,
    launch: action => action(pages.shift()),
  });
  assert.equal(result.stage, "test ends at observation");
  assert.match(observationPage.expected.hostedProbeTitle ?? "",
    /^Hosted (?:provider fixture|control edit) [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(observationPage.expected.hostedProbeTitle, title);
  assert.notEqual(observationPage.expected.hostedProbeTitle, updatedTitle);
});

test("requires an updated hosted probe only when requested", async () => {
  const oldPage = fixturePage(hostedOrigin);
  await verifyHostedPage(oldPage, hostedOrigin);
  await assert.rejects(verifyHostedPage(oldPage, hostedOrigin, { requireRetirableProbe: true }),
    /Expected a cleanup-compatible hosted rename probe/);
  await verifyHostedPage(fixturePage(hostedOrigin, 1), hostedOrigin, { requireRetirableProbe: true });
});
