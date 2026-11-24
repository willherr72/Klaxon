import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { containsMarker, containsSdkAccess } from "./web-check.mjs";

const click = (panel, name) => panel.getByRole("button", { name, exact: true }).click();
const statusIs = (page, status) => page.waitForFunction(status =>
  document.querySelector('[aria-label="SDK session status"]').textContent === status, status);
const taskRows = panel => panel.getByRole("list", { name: "SDK tasks" }).getByRole("listitem");

async function expectRow(panel, owner, updated = false) {
  const rows = taskRows(panel);
  const title = "Owner " + owner + (updated ? " updated" : " task");
  await rows.filter({ hasText: title }).waitFor();
  assert.equal(await rows.count(), 1);
  assert.equal(await rows.getAttribute("data-task-id"), "task-" + owner.toLowerCase());
  assert.ok((await rows.textContent()) === title, "unexpected SDK task title");
}

async function nativeDenies(page) {
  assert.equal(await page.evaluate(() => window.__TAURI__.core.invoke("fixture_sdk_access")
    .then(() => false, error => error === "signed-out")), true);
}

async function resume(page, panel, owner) {
  await click(panel, "Resume session");
  await statusIs(page, "authenticated");
  await expectRow(panel, owner);
  const observed = await page.evaluate(owner => ({
    nativeAccess: window.p0Replies.includes("sdk-owner-" + owner.toLowerCase()),
    socket: window.p0SdkFixture.evidence.socketAuth.at(-1),
    subscription: window.p0SdkFixture.evidence.queryAdds.at(-1),
  }), owner);
  assert.deepEqual(observed, { nativeAccess: true, socket: owner, subscription: owner });
}

async function readAndPush(page, panel, owner) {
  const reads = await page.evaluate(() => window.p0SdkFixture.evidence.httpReads.length);
  const renders = await page.evaluate(() => window.p0SdkFixture.renders());
  await click(panel, "Read SDK tasks");
  await page.waitForFunction(() => document.querySelector('[aria-label="SDK operation"]').textContent === "read complete");
  assert.equal(await page.evaluate(() => window.p0SdkFixture.renders()), renders + 1, "HTTP read must render decoded rows");
  assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.httpReads.at(-1)), owner);
  await expectRow(panel, owner);
  assert.equal(await page.evaluate(owner => window.p0SdkFixture.update(owner), owner), 1);
  await expectRow(panel, owner, true);
  assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.httpReads.length), reads + 1);
}

async function signOut(page, panel) {
  await click(panel, "Sign out");
  await statusIs(page, "signed-out");
  assert.equal(await taskRows(panel).count(), 0);
  await nativeDenies(page);
}

export async function exerciseSdkHandoff(launch, root, record) {
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    await click(panel, "Start synthetic session");
    await statusIs(page, "fixture-ready");
    await nativeDenies(page);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  const sealed = await readFile(record);
  assert.ok(sealed.length > 0 && ["latin1", "utf16le"].every(encoding =>
    !containsMarker(sealed.toString(encoding)) && !containsSdkAccess(sealed.toString(encoding))), "expected protected record");
  const corrupt = Buffer.from(sealed);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(record, corrupt);
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "unavailable");
    await nativeDenies(page);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  assert.ok((await readFile(record)).equals(corrupt), "damaged record was modified");
  await writeFile(record, sealed);

  const outage = join(root, "p0-provider-offline");
  await launch([async (page, panel, checkPageState) => {
    await nativeDenies(page); // A valid record alone cannot authorize a new process.
    await resume(page, panel, "A");
    await readAndPush(page, panel, "A");
    await checkPageState();
    await writeFile(outage, "", { flag: "wx" });
    const start = await page.evaluate(() => window.p0Replies.length);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.expire()), 1);
    await statusIs(page, "retry-required");
    await page.waitForFunction(() => {
      const e = window.p0SdkFixture.evidence;
      return e.socketsClosed === e.socketsOpened && !document.querySelector('[aria-label="SDK tasks"] li');
    });
    assert.equal(await page.evaluate(start => {
      const replies = window.p0Replies.slice(start);
      return replies.includes("sdk-denial-retry-required") && !replies.some(value => String(value).startsWith("sdk-owner-"));
    }, start), true, "forced refresh should reach native IPC and deny token issuance");
    await nativeDenies(page);
  }]);
  assert.ok((await readFile(record)).equals(sealed), "outage changed the protected record");
  await rm(outage);

  await launch([async (page, panel, checkPageState) => {
    await resume(page, panel, "A");
    await page.evaluate(() => window.p0SdkFixture.hold());
    await click(panel, "Read SDK tasks");
    assert.equal(await page.evaluate(() => window.p0SdkFixture.update("A")), 1);
    await page.waitForFunction(() => window.p0SdkFixture.held("read") && window.p0SdkFixture.held("update"));
    await signOut(page, panel);
    await assert.rejects(access(record), { code: "ENOENT" });
    const deliverStale = kind => page.evaluate(kind => {
      const f = window.p0SdkFixture;
      const before = f.renders();
      f.release(kind);
      return f.held(kind) === 0 && f.renders() === before;
    }, kind);
    assert.equal(await deliverStale("read"), true, "old read rendered after logout");
    assert.equal(await taskRows(panel).count(), 0);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.update("A")), 0);

    await click(panel, "Start peer session");
    await statusIs(page, "fixture-ready");
    await nativeDenies(page);
    await resume(page, panel, "B");
    assert.equal(await deliverStale("update"), true, "old subscription rendered over peer");
    await expectRow(panel, "B");
    await readAndPush(page, panel, "B");
    await checkPageState();
    await signOut(page, panel);
  }]);
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    await nativeDenies(page);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  await assert.rejects(access(record), { code: "ENOENT" });
  await checkProfile(join(root, "webview"));
}

// Inspect only regular files in the retired, harness-owned WebView profile.
// Carry enough bytes across chunks for either canary in its longest encoded form.
async function checkProfile(directory) {
  let files = 0;
  const pending = [directory];
  while (pending.length) {
    const path = pending.pop();
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(child);
      if (!entry.isFile()) continue;
      files++;
      let tail = Buffer.alloc(0);
      for await (const chunk of createReadStream(child)) {
        const bytes = Buffer.concat([tail, chunk]);
        for (const text of [bytes.toString("latin1"), bytes.toString("utf16le"), bytes.subarray(1).toString("utf16le")]) {
          assert.ok(!containsMarker(text) && !containsSdkAccess(text), "session material in retired WebView profile");
        }
        tail = bytes.subarray(-256);
      }
    }
  }
  assert.ok(files > 0, "expected a populated WebView profile");
  console.log("Inspected", files, "retired WebView profile files for fixture canaries");
}
