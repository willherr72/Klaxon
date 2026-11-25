import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withRefreshLoopback, withSignInLoopback, withSignOutLoopback } from "./auth-loopback.mjs";
import { checkProfileBytes, containsMarker, containsSdkAccess } from "./web-check.mjs";

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
  await expectAuthenticated(page, panel, owner);
}

async function expectAuthenticated(page, panel, owner) {
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

async function checkInitialGrant(page, panel, slot, failures) {
  for (const flag of failures) {
    await slot.signInFlag(flag, true);
    try {
      const denied = await page.evaluate(() => window.__TAURI__.core.invoke("fixture_session", { operation: "seed" })
        .then(() => false, status => status === "unavailable"));
      assert.ok(denied, "an invalid grant or failed first write must deny sign-in");
      await slot.assertEmpty();
      await nativeDenies(page);
    } finally {
      await slot.signInFlag(flag, false);
    }
  }
  await seed(page, panel);
  const firstRecord = await slot.read();
  await click(panel, "Start peer session");
  await statusIs(page, "unavailable");
  assert.ok((await slot.read()).equals(firstRecord), "a second sign-in replaced the first owner's record");
  await nativeDenies(page);
}

export async function exerciseSdkHandoff(launch, slot, { verifyAndroidKeystore = false, initialGrantFailures } = {}) {
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    if (initialGrantFailures) await checkInitialGrant(page, panel, slot, initialGrantFailures);
    else await seed(page, panel);
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
      // Sign-out must allow a fresh grant for a different session.
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
    signInFlag: (name, enabled) => enabled ? writeFile(join(root, name), "", { flag: "wx" }) : rm(join(root, name)),
    read: () => readFile(record),
    write: bytes => writeFile(record, bytes),
    outage: offline => offline ? writeFile(outage, "", { flag: "wx" }) : rm(outage),
    rotate: rotated => rotated ? writeFile(rotation, "", { flag: "wx" }) : rm(rotation),
    async assertEmpty() {
      await assert.rejects(access(record), { code: "ENOENT" });
      await assert.rejects(access(join(root, "packaged.staged")), { code: "ENOENT" });
    },
  }, { initialGrantFailures: ["p0-signin-denied", "p0-signin-owner-mismatch"] });
  await exerciseWindowsRefreshRecord(launch, root, record);
  await exerciseWindowsLostSignOutReply(launch, root, record);
  await checkProfile(join(root, "webview"));
}

async function exerciseWindowsRefreshRecord(launch, root, record) {
  const exchange = join(root, "p0-provider-refresh");
  const requireSuccessor = join(root, "p0-require-successor");
  let predecessor;
  let successor;
  await launch([async (page, panel) => {
    await seed(page, panel);
    predecessor = await readFile(record);
    await writeFile(exchange, "", { flag: "wx" });
    await resume(page, panel, "A");
    successor = await readFile(record);
    assert.ok(successor.length > 0 && !successor.equals(predecessor), "refresh must replace the sealed record");
    await readAndPush(page, panel, "A");
  }]);
  await rm(exchange);
  assert.ok((await readFile(record)).equals(successor), "the acknowledged replacement must survive host exit");
  for (const encoding of ["latin1", "utf16le"]) {
    assert.ok(!containsMarker(successor.toString(encoding)) && !containsSdkAccess(successor.toString(encoding)),
      "expected only protected bytes in the replacement record");
  }

  // Present the retired record to the same verifier before testing the saved successor.
  await writeFile(requireSuccessor, "", { flag: "wx" });
  await writeFile(record, predecessor);
  await launch([async (page, panel) => {
    await click(panel, "Resume session");
    await statusIs(page, "signed-out");
    await nativeDenies(page);
    assert.equal(await taskRows(panel).count(), 0);
    assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
  }]);
  await assert.rejects(access(record), { code: "ENOENT" });
  await writeFile(record, successor);
  await launch([async (page, panel) => {
    await nativeDenies(page);
    await resume(page, panel, "A");
    await readAndPush(page, panel, "A");
    await signOut(page, panel);
  }]);
  await assert.rejects(access(record), { code: "ENOENT" });
  await rm(requireSuccessor);
  assert.deepEqual(await readdir(root), ["webview"], "sign-out must retire any staged refresh material");
}

export async function exerciseWindowsLoopbackRefresh(launch, root, record) {
  const unrelated = join(root, "unrelated.txt");
  const control = "Unrelated fixture data";
  await writeFile(unrelated, control, { flag: "wx" });

  async function readProtectedRecord() {
    const bytes = await readFile(record);
    assert.ok(bytes.length > 0 && ["latin1", "utf16le"].every(encoding =>
      !containsMarker(bytes.toString(encoding)) && !containsSdkAccess(bytes.toString(encoding))),
    "expected only protected session bytes");
    return bytes;
  }

  await withRefreshLoopback(async loopback => {
    const env = { KLAXON_P0_REFRESH_PORT: String(loopback.port) };
    await withSignInLoopback(async signIn => {
      await launch([async (page, panel) => {
        const start = await page.evaluate(() => window.p0Replies.length);
        await click(panel, "Start synthetic session");
        await page.waitForFunction(start => window.p0Replies.length > start, start);
        signIn.assertAttempts(1);
        await statusIs(page, "unavailable");
        assert.deepEqual(await page.evaluate(start => window.p0Replies.slice(start), start), ["unavailable"]);
        await assert.rejects(access(record), { code: "ENOENT" });
        await expectColdDenial(page, panel);
        signIn.allowSuccess();
        await seed(page, panel);
        assert.equal(await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened), 0);
        const sealed = await readProtectedRecord();
        await click(panel, "Start synthetic session");
        await statusIs(page, "unavailable");
        signIn.assertAttempts(2);
        assert.ok((await readFile(record)).equals(sealed), "duplicate sign-in changed the protected record");
      }], { ...env, KLAXON_P0_SIGN_IN_PORT: String(signIn.port) });
    });
    loopback.assertAttempts(0);
    const predecessor = await readProtectedRecord();

    async function coldResume(attempt, before, expected, checkRecord) {
      await launch([async (page, panel) => {
        await expectColdDenial(page, panel);
        const start = await page.evaluate(() => window.p0Replies.length);
        const resumeReply = start + 2; // The two in-flight denial probes settle before HTTP responds.
        loopback.allowNext(async () => {
          assert.ok((await readFile(record)).equals(before), "protected record changed before the provider replied");
          assert.ok(await page.evaluate(start => window.p0Replies.length === start &&
            window.p0SdkFixture.accessRequests.length === 0 &&
            window.p0SdkFixture.evidence.socketsOpened === 0, start),
          "unexpected reply or SDK activity before the provider replied");
          for (const command of ["fixture_sdk_access", "fixture_task_list"]) {
            const denied = await page.evaluate(command => window.__TAURI__.core.invoke(command)
              .then(() => false, error => error === "unavailable"), command);
            assert.ok(denied, "native access must settle while the refresh response is withheld");
          }
          assert.deepEqual(await page.evaluate(start => window.p0Replies.slice(start), start),
            ["sdk-denial-unavailable", "unavailable"]);
        });

        await click(panel, "Resume session");
        await page.waitForFunction(index => window.p0Replies.length > index, resumeReply);
        loopback.assertAttempts(attempt);
        assert.ok(await page.evaluate(({ index, expected }) => window.p0Replies[index] === expected,
          { index: resumeReply, expected }), "cold resume must return " + expected + " through native IPC");
        // Check storage at the first observed native reply, before waiting for SDK authentication.
        await checkRecord();
        await statusIs(page, expected);
        if (expected === "authenticated") {
          await expectAuthenticated(page, panel, "A");
        } else {
          assert.equal(await page.evaluate(() => window.p0Replies.length), resumeReply + 1,
            "cold denial must return exactly one native status");
          await expectColdDenial(page, panel);
        }
      }], env);
      loopback.assertAttempts(attempt);
    }

    await coldResume(1, predecessor, "retry-required", async () => {
      assert.ok((await readFile(record)).equals(predecessor), "HTTP 503 changed the protected record");
    });
    assert.ok((await readFile(record)).equals(predecessor), "the predecessor changed after the denied host exited");

    let successor;
    await coldResume(2, predecessor, "authenticated", async () => {
      successor = await readProtectedRecord();
      assert.ok(!successor.equals(predecessor), "native authentication requires a new protected record");
    });
    assert.ok((await readFile(record)).equals(successor), "the protected successor must survive host exit");

    await coldResume(3, successor, "signed-out", async () => {
      await assert.rejects(access(record), { code: "ENOENT" });
    });
    assert.deepEqual((await readdir(root)).sort(), ["unrelated.txt", "webview"], "expected scoped session cleanup");
    assert.ok(await readFile(unrelated, "utf8") === control, "session cleanup changed unrelated data");
  });
  await checkProfile(join(root, "webview"));
}

export async function exerciseWindowsLoopbackSignOut(launch, root, record) {
  const exchange = join(root, "p0-provider-refresh");
  const pending = join(root, "packaged.signout-pending");
  let successor;
  let signingOutPage;
  async function checkPending() {
    assert.ok((await readFile(pending, "utf8")) === "pending", "expected durable sign-out intent");
  }
  async function checkPendingRecord() {
    await checkPending();
    assert.ok((await readFile(record)).equals(successor), "unacknowledged sign-out changed the protected record");
  }
  async function checkSlotEmpty() {
    assert.deepEqual(await readdir(root), ["webview"], "sign-out must remove all native slot files");
  }

  async function coldResume(page, panel, expected) {
    const start = await page.evaluate(() => window.p0Replies.length);
    await click(panel, "Resume session");
    await statusIs(page, expected);
    assert.ok(await page.evaluate(({ start, expected }) =>
      window.p0Replies.length === start + 1 && window.p0Replies[start] === expected,
    { start, expected }), "cold resume must return the expected status through native IPC");
    await expectColdDenial(page, panel);
  }

  await withSignOutLoopback(async () => {
    await checkPending();
    if (signingOutPage) await nativeDenies(signingOutPage);
  }, async loopback => {
    const env = { KLAXON_P0_SIGN_OUT_PORT: String(loopback.port) };
    await launch([async (page, panel) => {
      await seed(page, panel);
      const predecessor = await readFile(record);
      await writeFile(exchange, "", { flag: "wx" });
      try {
        await resume(page, panel, "A");
      } finally {
        await rm(exchange);
      }
      successor = await readFile(record);
      assert.ok(successor.length > 0 && !successor.equals(predecessor), "expected a rotated protected record");
      assert.ok(["latin1", "utf16le"].every(encoding =>
        !containsMarker(successor.toString(encoding)) && !containsSdkAccess(successor.toString(encoding))),
      "expected only protected bytes in the replacement record");
      await assert.rejects(access(pending), { code: "ENOENT" });
      loopback.assertAttempts(0);

      signingOutPage = page;
      await click(panel, "Sign out");
      await page.waitForFunction(() => ["retry-required", "signed-out", "unavailable"]
        .includes(document.querySelector('[aria-label="SDK session status"]').textContent));
      loopback.assertAttempts(1);
      signingOutPage = undefined;
      assert.equal(await panel.getByLabel("SDK session status").textContent(), "retry-required");
      await checkPendingRecord();
      await expectClearedSignOut(page, panel);
    }], env);

    await launch([async (page, panel) => {
      await nativeDenies(page);
      await coldResume(page, panel, "retry-required");
      await checkPendingRecord();
      loopback.allowRetry();
      await signOut(page, panel);
      loopback.assertAttempts(2);
      await checkSlotEmpty();
    }], env);

    await launch([async (page, panel) => {
      await coldResume(page, panel, "signed-out");
      await checkSlotEmpty();
    }], env);
    loopback.assertAttempts(2);
  });
  await checkProfile(join(root, "webview"));
}

async function expectColdDenial(page, panel) {
  assert.equal(await taskRows(panel).count(), 0);
  await nativeDenies(page);
  const opened = await page.evaluate(() => window.p0SdkFixture.evidence.socketsOpened);
  assert.equal(opened, 0, "a cold denial must not open an SDK socket");
  assert.ok(await page.evaluate(() => window.p0SdkFixture.accessRequests.length === 0 &&
    !window.p0Replies.some(reply => String(reply).startsWith("sdk-access-"))),
  "a cold denial must not request or receive SDK access");
}

async function expectClearedSignOut(page, panel) {
  assert.equal(await taskRows(panel).count(), 0);
  assert.ok(await page.evaluate(() => {
    const { socketsOpened, socketsClosed } = window.p0SdkFixture.evidence;
    return socketsOpened > 0 && socketsOpened === socketsClosed;
  }), "unacknowledged sign-out must close the SDK socket");
  await nativeDenies(page);
}

async function exerciseWindowsLostSignOutReply(launch, root, record) {
  const exchange = join(root, "p0-provider-refresh");
  const dropReply = join(root, "p0-signout-drop-reply");
  const expectSuccessor = join(root, "p0-signout-expect-successor");
  const issuerReceipt = join(root, "p0-issuer-revoked-successor");
  const issuerAck = join(root, "p0-issuer-acknowledged-successor");
  const unrelated = join(root, "p0-unrelated");
  const unrelatedContents = "keep this fixture file";
  let successor;

  await writeFile(unrelated, unrelatedContents, { flag: "wx" });
  try {
    await launch([async (page, panel) => {
      await seed(page, panel);
      const predecessor = await readFile(record);
      await writeFile(exchange, "", { flag: "wx" });
      await resume(page, panel, "A");
      await rm(exchange);
      successor = await readFile(record);
      assert.ok(successor.length > 0 && !successor.equals(predecessor), "expected a rotated protected record");

      await assert.rejects(access(issuerReceipt), { code: "ENOENT" });
      await writeFile(expectSuccessor, "", { flag: "wx" });
      await writeFile(dropReply, "", { flag: "wx" });
      await click(panel, "Sign out");
      await page.waitForFunction(() => {
        const status = document.querySelector('[aria-label="SDK session status"]').textContent;
        return ["retry-required", "signed-out", "unavailable"].includes(status);
      });
      assert.equal(await panel.getByLabel("SDK session status").textContent(), "retry-required",
        "sign-out must require retry when the issuer commits and drops its reply");
      await access(issuerReceipt);
      await expectClearedSignOut(page, panel);
      assert.ok((await readFile(record)).equals(successor), "lost reply changed the protected record");
    }]);

    await launch([async (page, panel) => {
      await click(panel, "Resume session");
      await statusIs(page, "retry-required");
      await expectColdDenial(page, panel);
      assert.ok((await readFile(record)).equals(successor), "cold resume changed the unacknowledged protected record");

      const previousReplies = await page.evaluate(() => window.p0Replies.length);
      await click(panel, "Sign out");
      await page.waitForFunction(start => window.p0Replies.slice(start).includes("retry-required"), previousReplies);
      await statusIs(page, "retry-required");
      await expectColdDenial(page, panel);
      assert.ok((await readFile(record)).equals(successor), "repeated reply loss changed the protected record");
      await assert.rejects(access(issuerAck), { code: "ENOENT" });
      await rm(dropReply);
      await signOut(page, panel);
      assert.equal((await readFile(issuerAck)).length, 0, "the issuer never returned the retry acknowledgment");
      await assert.rejects(access(record), { code: "ENOENT" });
    }]);

    await launch([async (page, panel) => {
      await click(panel, "Resume session");
      await statusIs(page, "signed-out");
      await expectColdDenial(page, panel);
      await assert.rejects(access(record), { code: "ENOENT" });
    }]);
    assert.equal(await readFile(unrelated, "utf8"), unrelatedContents, "sign-out changed an unrelated file");
  } finally {
    await Promise.all([exchange, dropReply, expectSuccessor, issuerReceipt, issuerAck, unrelated].map(path => rm(path, { force: true })));
  }
}

// Inspect only regular files in the retired, harness-owned WebView profile.
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
      await checkProfileBytes(createReadStream(child));
    }
  }
  assert.ok(files > 0, "expected a populated WebView profile");
  console.log("Inspected", files, "retired WebView profile files for fixture canaries");
}
