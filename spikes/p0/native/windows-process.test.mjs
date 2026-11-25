import assert from "node:assert/strict";
import test from "node:test";
import { observeWindowsBrowsers, windowsProcessIdentity } from "./windows-process.mjs";

const creation = offset => "63899742000000000" + offset;
const processRecord = (offset, matchesProfile = false) => ({ created: creation(offset), matchesProfile });

test("Windows process identities distinguish recycled PIDs at full timestamp precision", () => {
  const recorded = new Set([windowsProcessIdentity(7296, creation(1))]);
  assert.ok(recorded.has(windowsProcessIdentity(7296, creation(1))));
  assert.ok(!recorded.has(windowsProcessIdentity(7296, creation(2))));
});

test("Windows attachment requires the current host lifetime and an exact profile match", () => {
  const host = { pid: 110, created: creation(2) };
  const inventory = new Map([
    [110, processRecord(2)],
    [7296, processRecord(3, true)],
    [7300, processRecord(1, true)],
    [7440, processRecord(4)],
  ]);
  const owned = new Map();
  assert.deepEqual(observeWindowsBrowsers(inventory, host, owned), new Map([[7296, creation(3)]]));
  assert.deepEqual(owned, new Map([[7296, creation(3)]]));

  inventory.set(7296, processRecord(3));
  assert.equal(observeWindowsBrowsers(inventory, host, owned).size, 0);
});

test("Windows retirement follows verified late children through loss of command lines and ignores reused PIDs", () => {
  const host = { pid: 110, created: creation(2) };
  const owned = new Map([[7296, creation(3)]]);
  const shutdown = new Map([
    [110, processRecord(2)],
    [7296, processRecord(3, true)],
    [7440, processRecord(4, true)],
  ]);
  assert.deepEqual(observeWindowsBrowsers(shutdown, host, owned, true), new Map([
    [7296, creation(3)],
    [7440, creation(4)],
  ]));

  const afterExit = new Map([
    [110, processRecord(5)],
    [7296, processRecord(6)],
    [7440, processRecord(4)],
    [7550, processRecord(7, true)],
  ]);
  assert.deepEqual(observeWindowsBrowsers(afterExit, host, owned, true), new Map([[7440, creation(4)]]));
  afterExit.delete(7440);
  assert.equal(observeWindowsBrowsers(afterExit, host, owned, true).size, 0);
});
