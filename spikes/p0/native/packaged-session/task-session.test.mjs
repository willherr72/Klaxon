import assert from "node:assert/strict";
import test from "node:test";
import { createTaskSession } from "./task-session.mjs";

// Intercept only the native boundary. Each read snapshots rows when it starts,
// and each push captures its original callback before the runner delivers it.
function interceptedCore() {
  let owner;
  let record;
  let subscription;
  let rows;
  const reads = [];
  const updates = [];
  return {
    Channel: class {},
    async invoke(command, args) {
      if (command === "fixture_session") {
        owner = undefined;
        subscription = undefined;
        switch (args.operation) {
          case "seed":
          case "seed-peer":
            record = args.operation === "seed" ? "A" : "B";
            return "fixture-ready";
          case "resume":
            owner = record;
            if (!owner) return "signed-out";
            rows = [{ id: "task-" + owner.toLowerCase(), title: "Owner " + owner + " task" }];
            return "authenticated";
          case "sign-out":
            record = undefined;
            return "signed-out";
          default:
            throw new Error("Unexpected session operation");
        }
      }
      if (!owner) throw "signed-out";
      switch (command) {
        case "fixture_task_list": {
          const snapshot = rows;
          return new Promise(resolve => reads.push(() => resolve(snapshot)));
        }
        case "fixture_task_subscribe":
          subscription = args.onRows;
          return;
        case "fixture_task_publish": {
          rows = [{ ...rows[0], title: "Owner " + owner + " updated" }];
          const snapshot = rows;
          const deliver = subscription.onmessage;
          updates.push(() => deliver(snapshot));
          return;
        }
        default:
          throw new Error("Unexpected task command");
      }
    },
    takeRead() { return reads.shift(); },
    takeUpdate() { return updates.shift(); },
  };
}

function client() {
  const core = interceptedCore();
  let view;
  const tasks = createTaskSession(core, state => { view = state; });
  return { core, tasks, get view() { return view; } };
}

async function readNow({ core, tasks }) {
  const read = tasks.read();
  const deliver = core.takeRead();
  deliver();
  await read;
}

test("resume permits a task read and a later pushed snapshot", async () => {
  const c = client();
  assert.deepEqual(c.view, { status: "unchecked", rows: [] });
  assert.equal(await c.tasks.change("seed"), "fixture-ready");
  assert.equal(await c.tasks.change("resume"), "authenticated");
  await readNow(c);
  assert.deepEqual(c.view.rows, [{ id: "task-a", title: "Owner A task" }]);
  await c.tasks.subscribe();
  await c.tasks.publish();
  const deliver = c.core.takeUpdate();
  deliver();
  assert.deepEqual(c.view.rows, [{ id: "task-a", title: "Owner A updated" }]);
});

test("signed-out requests propagate native denial and show no rows", async () => {
  const c = client();
  assert.equal(await c.tasks.change("resume"), "signed-out");
  for (const operation of ["read", "subscribe", "publish"]) {
    await assert.rejects(c.tasks[operation](), reason => reason === "signed-out");
  }
  assert.deepEqual(c.view, { status: "signed-out", rows: [] });
});

for (const delivery of ["read", "subscription update"]) {
  for (const destination of ["sign-out", "owner B's resume"]) {
    test(`owner A's queued ${delivery} is ignored after ${destination}`, async () => {
      const c = client();
      await c.tasks.change("seed");
      await c.tasks.change("resume");
      await c.tasks.subscribe();
      await readNow(c);
      assert.deepEqual(c.view.rows, [{ id: "task-a", title: "Owner A task" }]);

      let deliver;
      let pending;
      if (delivery === "read") {
        pending = c.tasks.read();
        deliver = c.core.takeRead();
      } else {
        await c.tasks.publish();
        deliver = c.core.takeUpdate();
      }
      const signOut = c.tasks.change("sign-out");
      assert.deepEqual(c.view.rows, [], "clear sensitive rows as soon as sign-out starts");
      await signOut;
      let expected = { status: "signed-out", rows: [] };
      if (destination === "owner B's resume") {
        await c.tasks.change("seed-peer");
        await c.tasks.change("resume");
        await readNow(c);
        expected = { status: "authenticated", rows: [{ id: "task-b", title: "Owner B task" }] };
      }
      assert.deepEqual(c.view, expected);
      deliver(); // The callback really runs, even though native has dropped its old channel.
      await pending;
      assert.deepEqual(c.view, expected);
    });
  }
}
