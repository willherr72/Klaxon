import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canaryOverlap, containsMarker, containsSdkAccess } from "./web-check.mjs";

const click = (panel, name) => panel.getByRole("button", { name, exact: true }).click();
const statusIs = (page, status) => page.waitForFunction(status =>
  document.querySelector('[aria-label="SDK session status"]').textContent === status, status);
const taskRows = panel => panel.getByRole("list", { name: "SDK tasks" }).getByRole("listitem");

async function seed(page, panel, button = "Start synthetic session") {
  await click(panel, button);
  await statusIs(page, "fixture-ready");
  await nativeDenies(page);
}

async function expectRow(panel, owner, revision = 0) {
  const rows = taskRows(panel);
  const title = "Owner " + owner + (revision ? " updated" : " task") + (revision > 1 ? " " + revision : "");
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
  const generation = owner.toLowerCase() + "1";
  const observed = await page.evaluate(generation => ({
    nativeAccess: window.p0Replies.includes("sdk-access-" + generation),
    socket: window.p0SdkFixture.evidence.socketAuthGenerations.at(-1),
    subscription: window.p0SdkFixture.evidence.queryAddGenerations.at(-1),
  }), generation);
  assert.deepEqual(observed, { nativeAccess: true, socket: generation, subscription: generation });
}

async function readAndPush(page, panel, owner, generation = owner.toLowerCase() + "1", revision = 0) {
  const before = await page.evaluate(() => ({
    reads: window.p0SdkFixture.evidence.httpReadGenerations.length,
    renders: window.p0SdkFixture.renders(),
  }));
  await click(panel, "Read SDK tasks");
  await page.waitForFunction(renders => window.p0SdkFixture.renders() > renders &&
    document.querySelector('[aria-label="SDK operation"]').textContent === "read complete", before.renders);
  assert.equal(await page.evaluate(() => window.p0SdkFixture.renders()), before.renders + 1, "HTTP read must render decoded rows");
  assert.deepEqual(await page.evaluate(start => window.p0SdkFixture.evidence.httpReadGenerations.slice(start), before.reads),
    [generation], "HTTP read must use the expected access generation");
  await expectRow(panel, owner, revision);
  assert.equal(await page.evaluate(owner => window.p0SdkFixture.update(owner), owner), 1);
  await expectRow(panel, owner, revision + 1);
  assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.httpReadGenerations.length), before.reads + 1);
}

async function expectAccessCutover(page, panel) {
  const before = await page.evaluate(() => {
    const { evidence, accessRequests } = window.p0SdkFixture;
    return {
      replies: window.p0Replies.length, accessRequests: accessRequests.length,
      socket: evidence.socketAuthGenerations.length, subscription: evidence.queryAddGenerations.length,
      opened: evidence.socketsOpened, closed: evidence.socketsClosed,
    };
  });
  assert.equal(await page.evaluate(() => window.p0SdkFixture.rotate()), 1);
  await page.waitForFunction(({ replies, subscription }) =>
    window.p0Replies.slice(replies).includes("sdk-access-a2") &&
    window.p0SdkFixture.evidence.queryAddGenerations.slice(subscription).includes("a2"), before);
  const observed = await page.evaluate(before => {
    const { evidence, accessRequests } = window.p0SdkFixture;
    return {
      replies: window.p0Replies.slice(before.replies),
      accessRequests: accessRequests.slice(before.accessRequests),
      socket: evidence.socketAuthGenerations.slice(before.socket),
      subscription: evidence.queryAddGenerations.slice(before.subscription),
      opened: evidence.socketsOpened - before.opened, closed: evidence.socketsClosed - before.closed,
    };
  }, before);
  assert.deepEqual(observed, {
    replies: ["sdk-access-a2"], accessRequests: [true], socket: ["a2"], subscription: ["a2"], opened: 1, closed: 1,
  }, "cutover must force a native refresh and replace the SDK socket and subscription");
  await statusIs(page, "authenticated");
  await readAndPush(page, panel, "A", "a2", 1);
}

async function signOut(page, panel) {
  await click(panel, "Sign out");
  await statusIs(page, "signed-out");
  assert.equal(await taskRows(panel).count(), 0);
  await nativeDenies(page);
}

async function expectRefreshDenial(page, expected) {
  const start = await page.evaluate(() => window.p0Replies.length);
  assert.equal(await page.evaluate(() => window.p0SdkFixture.expire()), 1);
  await statusIs(page, expected);
  await page.waitForFunction(() => {
    const e = window.p0SdkFixture.evidence;
    return e.socketsClosed === e.socketsOpened && !document.querySelector('[aria-label="SDK tasks"] li');
  });
  assert.equal(await page.evaluate(([start, expected]) => {
    const replies = window.p0Replies.slice(start);
    return replies.includes("sdk-denial-" + expected) && !replies.some(value => String(value).startsWith("sdk-access-"));
  }, [start, expected]), true, "forced refresh should reach native IPC and deny token issuance");
  await nativeDenies(page);
}

export async function exerciseSdkHandoff(launch, slot, { verifyAndroidKeystore = false } = {}) {
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    await seed(page, panel);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  const sealed = await slot.read();
  assert.ok(sealed.length > 0 && ["latin1", "utf16le"].every(encoding =>
    !containsMarker(sealed.toString(encoding)) && !containsSdkAccess(sealed.toString(encoding))), "expected protected record");
  const corrupt = Buffer.from(sealed);
  corrupt[corrupt.length - 1] ^= 1;
  await slot.write(corrupt);
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "unavailable");
    await nativeDenies(page);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  assert.ok((await slot.read()).equals(corrupt), "damaged record was modified");
  await slot.write(sealed);

  await launch([async (page, panel, checkPageState) => {
    await nativeDenies(page); // A valid record alone cannot authorize a new process.
    await resume(page, panel, "A");
    await readAndPush(page, panel, "A");
    await checkPageState();
    await slot.rotate(true);
    try {
      await expectAccessCutover(page, panel);
      await checkPageState();
      assert.ok((await slot.read()).equals(sealed), "access cutover changed the protected record");
    } finally {
      await slot.rotate(false);
    }
    await slot.outage(true);
    await expectRefreshDenial(page, "retry-required");
  }]);
  assert.ok((await slot.read()).equals(sealed), "outage changed the protected record");
  if (verifyAndroidKeystore) {
    await launch([async (page, panel) => {
      await nativeDenies(page);
      await click(panel, "Resume session");
      await statusIs(page, "retry-required");
      await nativeDenies(page);
      assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
    }]);
    assert.ok((await slot.read()).equals(sealed), "cold denial changed the protected record");
  }
  await slot.outage(false);

  await launch([async (page, panel, checkPageState) => {
    await nativeDenies(page);
    await resume(page, panel, "A");
    await page.evaluate(() => window.p0SdkFixture.hold());
    await click(panel, "Read SDK tasks");
    assert.equal(await page.evaluate(() => window.p0SdkFixture.update("A")), 1);
    await page.waitForFunction(() => window.p0SdkFixture.held("read") && window.p0SdkFixture.held("update"));
    await signOut(page, panel);
    await slot.assertEmpty();
    const deliverStale = kind => page.evaluate(kind => {
      const f = window.p0SdkFixture;
      const before = f.renders();
      f.release(kind);
      return f.held(kind) === 0 && f.renders() === before;
    }, kind);
    assert.equal(await deliverStale("read"), true, "old read rendered after logout");
    assert.equal(await taskRows(panel).count(), 0);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.update("A")), 0);

    await seed(page, panel, "Start peer session");
    await resume(page, panel, "B");
    assert.equal(await deliverStale("update"), true, "old subscription rendered over peer");
    await expectRow(panel, "B");
    await readAndPush(page, panel, "B");
    await checkPageState();
    if (!verifyAndroidKeystore) await signOut(page, panel);
  }]);
  if (verifyAndroidKeystore) {
    await launch([async (page, panel) => {
      await nativeDenies(page);
      await resume(page, panel, "B");
      await readAndPush(page, panel, "B");
      await signOut(page, panel);
    }]);
    await slot.assertEmpty();
  }
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    await nativeDenies(page);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
    if (verifyAndroidKeystore) {
      // The Keystore fixture refuses a seed if either its alias or its file exists.
      await seed(page, panel);
      await resume(page, panel, "A");
      await slot.expiry(true);
      await expectRefreshDenial(page, "signed-out");
      await slot.assertEmpty();
      await slot.expiry(false);
    }
  }]);
  if (verifyAndroidKeystore) {
    await launch([async (page, panel) => {
      await click(panel, "Resume session");
      await statusIs(page, "signed-out");
      await nativeDenies(page);
      await seed(page, panel);
      await signOut(page, panel);
    }]);
  }
  await slot.assertEmpty();
}

export async function exerciseWindowsSdkHandoff(launch, root, record) {
  const outage = join(root, "p0-provider-offline");
  const rotation = join(root, "p0-provider-rotated");
  await exerciseSdkHandoff(launch, {
    read: () => readFile(record),
    write: bytes => writeFile(record, bytes),
    outage: offline => offline ? writeFile(outage, "", { flag: "wx" }) : rm(outage),
    rotate: rotated => rotated ? writeFile(rotation, "", { flag: "wx" }) : rm(rotation),
    assertEmpty: () => assert.rejects(access(record), { code: "ENOENT" }),
  });
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
        tail = bytes.subarray(-canaryOverlap);
      }
    }
  }
  assert.ok(files > 0, "expected a populated WebView profile");
  console.log("Inspected", files, "retired WebView profile files for fixture canaries");
}
