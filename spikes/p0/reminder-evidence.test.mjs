import assert from "node:assert/strict";
import test from "node:test";

// Each synthetic trace follows one occurrence on one device, starting at revision 1.
// Events are in observation order. "visible" means an observer saw a new OS notification appear.
function replay(events) {
  let revision = 1;
  let canceled = false;
  let visible = false;
  let recovery = "none";
  let permissionDenied = false;
  let deniedReopen = null;

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
        assert.ok(!permissionDenied, "Web Push displayed with permission denied");
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
        if (deniedReopen) deniedReopen.historyRevision = observedRevision;
        break;
      case "permission denied":
      case "permission granted": {
        const denied = event === "permission denied";
        if (denied !== permissionDenied) deniedReopen = null;
        permissionDenied = denied;
        break;
      }
      case "app reopened":
        deniedReopen = permissionDenied ? { statusShown: false, historyRevision: null } : null;
        break;
      case "denied status shown":
        assert.ok(permissionDenied, "status reported denied without a matching permission observation");
        if (deniedReopen) deniedReopen.statusShown = true;
        break;
      default:
        assert.fail("unknown evidence event");
    }
  }
  const deniedFallbackObserved = !canceled && deniedReopen?.statusShown === true &&
    deniedReopen.historyRevision === revision;
  return { visible, overdueAfterReconnect: recovery === "observed", deniedFallbackObserved };
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
    { visible: false, overdueAfterReconnect: true, deniedFallbackObserved: false });
  assert.throws(() => replay([...offline, ["edited", 2], ["overdue in history", 1]]), /stale overdue/);
  assert.throws(() => replay([...offline, ["canceled", 1], ["overdue in history", 1]]), /stale overdue/);
});

test("denied Web Push needs visible permission status and current overdue history on reopen", () => {
  const denied = [["permission denied"], ["provider accepted", 1], ["worker received", 1]];
  const reopened = [...denied, ["app reopened"]];
  const status = ["denied status shown"];
  const history = ["overdue in history", 1];
  assert.equal(replay(reopened).visible, false);
  assert.throws(() => replay([...reopened, ["visible", 1]]), /permission denied/);
  assert.equal(replay([...denied, status, history, ["app reopened"]]).deniedFallbackObserved, false);
  assert.equal(replay([...reopened, status]).deniedFallbackObserved, false);
  assert.equal(replay([...reopened, history]).deniedFallbackObserved, false);
  const observed = [...reopened, history, status];
  assert.equal(replay(observed).deniedFallbackObserved, true);
  assert.equal(replay([...reopened, status, ["permission denied"], history]).deniedFallbackObserved, true);

  // Previous observations cannot be reused after an edit, another reopen, or revocation.
  assert.equal(replay([...observed, ["edited", 2]]).deniedFallbackObserved, false);
  assert.equal(replay([...observed, ["app reopened"], status]).deniedFallbackObserved, false);
  const revoked = [...observed, ["permission granted"], ["permission denied"]];
  assert.equal(replay([...revoked, status, history]).deniedFallbackObserved, false);
  assert.equal(replay([...revoked, ["app reopened"], history]).deniedFallbackObserved, false);
  assert.equal(replay([...revoked, ["app reopened"], status, history]).deniedFallbackObserved, true);
});
