import assert from "node:assert/strict";

const task = (owner, updated = false) => ({
  id: "task-" + owner.toLowerCase(), title: "Owner " + owner + (updated ? " updated" : " task"),
});

async function visibleRows(panel) {
  return panel.getByRole("list", { name: "Native tasks" }).getByRole("listitem").evaluateAll(items =>
    items.map(item => ({ id: item.dataset.taskId, title: item.textContent })));
}

export async function checkTaskDenial(page, panel) {
  // Invoke the actual native commands even when the UI already knows it is signed out.
  const results = await page.evaluate(async () => {
    const { invoke, Channel } = window.__TAURI__.core;
    return Promise.all([
      invoke("fixture_task_list"),
      invoke("fixture_task_subscribe", { onRows: new Channel() }),
      invoke("fixture_task_publish"),
    ].map(reply => reply.then(() => "unexpected success", error => error)));
  });
  assert.deepEqual(results, ["signed-out", "signed-out", "signed-out"]);
  assert.deepEqual(await visibleRows(panel), []);
}

export async function checkTaskSwitch(page, panel) {
  const click = name => panel.getByRole("button", { name, exact: true }).click();
  const expectText = (label, text) => page.waitForFunction(([label, text]) =>
    document.querySelector(`output[aria-label="${label}"]`).textContent === text, [label, text]);
  const checkRow = async expected => {
    await panel.getByRole("listitem").filter({ hasText: expected.title }).waitFor();
    assert.deepEqual(await visibleRows(panel), [expected]);
  };

  // Delay only delivery to the WebView consumer. Rust must first produce a real list reply
  // and a real channel message. Keep the actual callback, even if its registration is retired.
  await page.evaluate(() => {
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    const set = callbacks.set.bind(callbacks);
    const gate = window.p0TaskGate = { armed: false, held: {}, ended: new Map() };
    callbacks.set = (id, callback) => set(id, data => {
      if (data?.end === true) gate.ended.set(id, data.index);
      const kind = Array.isArray(data) ? "read" : Array.isArray(data?.message) ? "update" : null;
      if (kind && gate.armed && !gate.held[kind]) {
        gate.held[kind] = { id, rows: kind === "read" ? data : data.message, deliver: () => callback(data) };
      } else {
        return callback(data);
      }
    });
  });
  async function deliver(kind) {
    const rows = await page.evaluate(async kind => {
      const held = window.p0TaskGate.held[kind];
      held.deliver();
      // Allow the real bridge promise, controller and Svelte render to settle.
      await new Promise(resolve => setTimeout(resolve, 0));
      return held.rows;
    }, kind);
    assert.deepEqual(rows, [task("A", true)]);
  }

  await click("Read native tasks");
  await checkRow(task("A"));
  await click("Subscribe to native tasks");
  await expectText("Task operation", "subscribe complete");
  const readCount = () => page.evaluate(() => window.p0Replies.filter(Array.isArray).length);
  const beforePublish = await readCount();
  assert.equal(beforePublish, 1);
  await click("Publish fixture update");
  await checkRow(task("A", true));
  assert.equal(await readCount(), beforePublish, "push must update the view without a list read");
  const firstPush = await page.evaluate(() => window.p0Replies.filter(reply => Array.isArray(reply?.message)));
  assert.deepEqual(firstPush, [{ index: 0, message: [task("A", true)] }]);

  await page.evaluate(() => { window.p0TaskGate.armed = true; });
  await click("Read native tasks");
  await click("Publish fixture update");
  await page.waitForFunction(() => window.p0TaskGate.held.read && window.p0TaskGate.held.update);
  await page.evaluate(() => { window.p0TaskGate.armed = false; });
  await click("Sign out");
  await expectText("Native session status", "signed-out");
  // Two messages were sent to A. Its specific channel must end before B subscribes.
  await page.waitForFunction(() => {
    const gate = window.p0TaskGate;
    return gate.ended.get(gate.held.update.id) === 2;
  });
  await deliver("read");
  await checkTaskDenial(page, panel);

  await click("Start peer session");
  await expectText("Native session status", "fixture-ready");
  await checkTaskDenial(page, panel);
  await click("Resume session");
  await expectText("Native session status", "authenticated");
  await click("Read native tasks");
  await checkRow(task("B"));
  await click("Subscribe to native tasks");
  await expectText("Task operation", "subscribe complete");
  await deliver("update");
  assert.deepEqual(await visibleRows(panel), [task("B")]);
  await click("Publish fixture update");
  await checkRow(task("B", true));
  await click("Sign out");
  await expectText("Native session status", "signed-out");
  await checkTaskDenial(page, panel);

  // Inspect the recorded native IPC payloads, including channel envelopes and teardown.
  const replies = await page.evaluate(() => window.p0Replies);
  const expected = ["A", "B"].flatMap(owner => [task(owner), task(owner, true)]);
  for (const reply of replies) {
    if (reply == null || ["signed-out", "fixture-ready", "authenticated"].includes(reply)) continue;
    if (Number.isInteger(reply.index) && Object.hasOwn(reply, "end")) {
      assert.deepEqual(Object.keys(reply).sort(), ["end", "index"]);
      assert.equal(reply.end, true);
      continue;
    }
    const rows = Array.isArray(reply) ? reply : reply.message;
    if (rows !== reply) assert.deepEqual(Object.keys(reply).sort(), ["index", "message"]);
    assert.equal(rows?.length, 1);
    assert.deepEqual(rows[0], expected.find(row => row.id === rows[0].id && row.title === rows[0].title));
  }
}
