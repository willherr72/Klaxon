import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";

const pageUrl = pathToFileURL(resolve("dist/index.html")).href;
const run = promisify(execFile);
let browser;
before(async () => {
  const executablePath = process.env.P0_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } :
    process.platform === "win32" ? { channel: "msedge" } : {});
});
after(async () => { await browser?.close(); });

async function buildForTest(t, origin, ...options) {
  const outdir = await mkdtemp(join(tmpdir(), "klaxon-portable-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await run(process.execPath, ["build-portable.mjs", "--outdir", outdir, ...options], {
    env: { ...process.env, P0_PUBLIC_DEV_ORIGIN: origin },
  });
  return pathToFileURL(join(outdir, "index.html")).href;
}

test("the Android SDK panel is confined to offline session assets and excludes native issuer values", async t => {
  const fixture = new URL(await buildForTest(t, "", "--session"));
  const html = await readFile(fixture, "utf8");
  assert.ok(html.includes("fixture_sdk_access") && html.includes("connect-src 'none'"));
  assert.ok(!html.includes("fixture_task_list"), "Windows task transport in Android assets");
  assert.ok(!/KLAXON-P0-INERT\/|p0-inert-access-[ab]/.test(html), "native fixture material in web assets");
  assert.ok(!(await readFile(new URL(pageUrl), "utf8")).includes("fixture_sdk_access"));
  await assert.rejects(buildForTest(t, "https://synthetic-portable-test.convex.cloud", "--session"), /runs offline/);
});

test("the build rejects local, insecure and credential-bearing account destinations", async t => {
  for (const invalid of ["http://127.0.0.1:3210", "http://unsafe.convex.cloud",
      "https://example.test", "https://key@synthetic.convex.cloud", "https://synthetic.convex.cloud/?token=TEST"]) {
    await assert.rejects(buildForTest(t, invalid), /must be a plain HTTPS Convex deployment origin/);
  }
});

test("an account build can retry a failed sign-in without storing credentials or contacting a deployment", async t => {
  const origin = "https://synthetic-portable-test.convex.cloud";
  const artifact = await buildForTest(t, origin);
  const context = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => context.close());
  const calls = [];
  const unexpected = [];
  // Install HTTP and socket interception before creating a page.
  await context.routeWebSocket(/.*/, socket => { unexpected.push(socket.url()); socket.close(); });
  await context.route(/^https?:/i, async route => {
    const req = route.request();
    if (req.url() === origin + "/api/mutation" && req.method() === "POST") {
      calls.push(req.postDataJSON().path);
      if (calls.length === 1) return route.abort("connectionfailed");
      return route.fulfill({ json: { status: "success", value: {
        status: "error", userError: { error: "INVALID_CREDENTIALS" },
      } } });
    }
    unexpected.push(req.url());
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  await page.goto(artifact);
  const password = "synthetic-only-test-password";
  await page.getByLabel("Username").fill("synthetic-user");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").getByText(/could not reach/i).waitFor();
  assert.equal(await page.getByLabel("Password").inputValue(), "");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("alert").getByText(/check the enrolled username/i).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create task" }).count(), 0);
  assert.deepEqual(calls, ["auth:signInWithUsernamePassword", "auth:signInWithUsernamePassword"]);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(await context.cookies(), []);
  await page.reload();
  assert.equal(await page.getByLabel("Username").inputValue(), "");
  assert.equal(await page.getByLabel("Password").inputValue(), "");
});

test("the copied fixture cold-starts offline, stores edits, and reopens without a server", async t => {
  const context = await browser.newContext({ offline: true, viewport: { width: 360, height: 760 } });
  t.after(() => context.close());
  const requests = [];
  const errors = [];
  context.on("request", req => { if (/^https?:/i.test(req.url())) requests.push(req.url()); });
  context.on("page", page => {
    page.on("pageerror", err => errors.push(err.message));
    page.on("websocket", ws => requests.push(ws.url()));
  });

  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.getByText("Local fixture", { exact: true }).waitFor();
  await page.getByText("Browser network offline", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Username").count(), 0);
  await page.getByLabel("Task title", { exact: true }).fill("Synthetic evening check");
  await page.getByRole("button", { name: "Create task" }).click();
  const row = page.getByRole("list", { name: "Synthetic tasks" }).getByRole("listitem");
  await row.getByText("Synthetic evening check").waitFor();
  const id = await row.getAttribute("data-task-id");
  assert.ok(id);
  await row.getByRole("button", { name: "Rename" }).click();
  await row.getByLabel("New title").fill("Renamed while offline");
  await row.getByRole("button", { name: "Save title" }).click();
  await row.getByText("Renamed while offline").waitFor();
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto(pageUrl);
  const sameRow = reopened.getByRole("list", { name: "Synthetic tasks" }).getByRole("listitem");
  await sameRow.getByText("Renamed while offline").waitFor();
  assert.equal(await sameRow.getAttribute("data-task-id"), id);
  await context.setOffline(false);
  await reopened.getByText("Browser network online", { exact: true }).waitFor();
  await sameRow.getByText("Renamed while offline").waitFor();
  assert.deepEqual(requests, []);
  assert.deepEqual(errors, []);
});

test("when device storage is full the draft can be retried without losing the saved title", async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.getByLabel("Task title", { exact: true }).fill("A");
  await page.getByRole("button", { name: "Create task" }).click();
  const row = page.getByRole("list", { name: "Synthetic tasks" }).getByRole("listitem");
  await row.getByRole("button", { name: "Rename" }).click();
  const draft = "Synthetic recovery " + "R".repeat(120);
  await row.getByLabel("New title").fill(draft);
  // Consume real Chromium storage quota to within a few characters of capacity.
  await page.evaluate(() => {
    let used = "";
    for (let step = 2 ** 20; step >= 1; step /= 2) {
      const pad = "x".repeat(step);
      for (;;) {
        try { localStorage.setItem("quota-test", used + pad); }
        catch (err) {
          if (err.name !== "QuotaExceededError") throw err;
          break;
        }
        used += pad;
      }
    }
  });
  await row.getByRole("button", { name: "Save title" }).click();
  await page.getByRole("alert").getByText(/device storage/i).waitFor();
  assert.equal(await row.getByLabel("New title").inputValue(), draft);
  const second = await context.newPage();
  await second.goto(pageUrl);
  await second.getByRole("list", { name: "Synthetic tasks" }).getByText("A", { exact: true }).waitFor();
  await second.evaluate(() => localStorage.removeItem("quota-test"));
  await row.getByRole("button", { name: "Save title" }).click();
  await row.getByText(draft, { exact: true }).waitFor();
  await page.reload();
  await row.getByText(draft, { exact: true }).waitFor();
});

test("a corrupt sibling prevents a hidden create and repair permits a single retry", async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(pageUrl);
  const draft = page.getByLabel("Task title");
  const create = page.getByRole("button", { name: "Create task" });
  const key = "klaxon.p0.fixture.v1.broken";
  await draft.fill("Recovered synthetic task");
  await page.evaluate(key => localStorage.setItem(key, "{"), key);
  await create.click();
  await page.getByRole("alert").waitFor();
  assert.equal(await draft.inputValue(), "Recovered synthetic task");
  assert.equal(await page.evaluate(() => localStorage.length), 1);
  const other = await context.newPage();
  await other.goto(pageUrl);
  await other.getByRole("alert").waitFor();
  await other.getByLabel("Task title").fill("Blocked while unreadable");
  assert.equal(await other.getByRole("button", { name: "Create task" }).isDisabled(), true);
  await other.evaluate(key => localStorage.removeItem(key), key);
  await create.click();
  const row = page.getByRole("listitem");
  await row.getByText("Recovered synthetic task").waitFor();
  assert.equal(await page.evaluate(() => localStorage.length), 1);
});
