import assert from "node:assert/strict";
import test from "node:test";

// Each synthetic trace follows one occurrence on one device, starting at revision 1.
// Events are in observation order. "visible" means someone saw the OS notification.
function replay(events) {
  let revision = 1;
  let canceled = false;
  let visible = false;
  let recovery = "none";

  for (const [event, observedRevision] of events) {
    switch (event) {
      case "edited":
        assert.ok(!canceled && observedRevision > revision, "invalid edit");
        revision = observedRevision;
        recovery = "none";
        break;
      case "canceled":
        assert.equal(observedRevision, revision, "cancel must identify the current revision");
        canceled = true;
        recovery = "none";
        break;
      case "provider accepted":
      case "worker received":
        // A retry or late receipt can arrive even after an edit or cancellation.
        break;
      case "visible":
        assert.ok(!canceled, "canceled occurrence displayed");
        assert.equal(observedRevision, revision, "superseded revision displayed");
        assert.ok(!visible, "duplicate display on the same device");
        visible = true;
        break;
      case "offline at due time":
        assert.ok(!canceled && observedRevision === revision, "expected current occurrence at due time");
        recovery = "offline";
        break;
      case "reconnected":
        if (recovery === "offline") recovery = "reconnected";
        break;
      case "overdue in history":
        assert.ok(!canceled && observedRevision === revision, "stale overdue entry");
        if (recovery === "reconnected") recovery = "observed";
        break;
      default:
        assert.fail("unknown evidence event");
    }
  }
  return { visible, overdueAfterReconnect: recovery === "observed" };
}

test("synthetic retries and service-worker receipts cannot establish visible delivery", () => {
  const receipts = [["provider accepted", 1], ["worker received", 1], ["provider accepted", 1]];
  assert.equal(replay(receipts).visible, false);
  const shown = [...receipts, ["visible", 1]];
  assert.equal(replay(shown).visible, true);
  assert.throws(() => replay([...shown, ["visible", 1]]), /duplicate display/);
});

test("a synthetic edit permits a late worker receipt but rejects display of the old revision", () => {
  const edited = [["provider accepted", 1], ["edited", 2], ["worker received", 1]];
  assert.equal(replay([...edited, ["visible", 2]]).visible, true);
  assert.throws(() => replay([...edited, ["visible", 1]]), /superseded revision/);
});

test("a synthetic cancellation permits late receipts and rejects a later notification", () => {
  const canceled = [["canceled", 1], ["worker received", 1]];
  assert.equal(replay(canceled).visible, false);
  assert.throws(() => replay([...canceled, ["visible", 1]]), /canceled occurrence/);
});

test("overdue recovery needs a current history observation after reconnect", () => {
  const offline = [["offline at due time", 1], ["overdue in history", 1], ["reconnected"]];
  assert.equal(replay(offline).overdueAfterReconnect, false);
  assert.deepEqual(replay([...offline, ["overdue in history", 1]]),
    { visible: false, overdueAfterReconnect: true });
  assert.throws(() => replay([...offline, ["edited", 2], ["overdue in history", 1]]), /stale overdue/);
  assert.throws(() => replay([...offline, ["canceled", 1], ["overdue in history", 1]]), /stale overdue/);
});
