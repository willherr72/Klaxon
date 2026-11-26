import assert from "node:assert/strict";
import test from "node:test";
import { withWebViewForward } from "./smoke.mjs";

const serial = "emulator-5554";
const target = "localabstract:webview_devtools_remote_2468";

function fakeForward({ acknowledge = true, remote = target } = {}) {
  const routes = new Map();
  function adb(...args) {
    if (args[1] === "--list") {
      return Array.from(routes, ([port, remote]) => `${serial} tcp:${port} ${remote}`).join("\n");
    }
    if (args[1] === "tcp:0") {
      assert.deepEqual(args, ["forward", "tcp:0", target]);
      routes.set("41001", remote);
      if (!acknowledge) throw Error("setup acknowledgment lost");
      return "41001";
    }
    assert.deepEqual(args.slice(0, 2), ["forward", "--remove"]);
    routes.delete(args[2].slice(4));
    return "";
  }
  return { routes, run: action => withWebViewForward(adb, serial, target, action) };
}

test("removes only the allocated forward when a second route targets the same socket", async () => {
  const fixture = fakeForward();
  await assert.rejects(fixture.run(port => {
    assert.equal(port, "41001");
    fixture.routes.set("41002", target);
    throw Error("WebView check failed");
  }), /WebView check failed/);
  assert.deepEqual([...fixture.routes], [["41002", target]]);
});

test("leaves a replacement route at the allocated port intact", async () => {
  const fixture = fakeForward();
  assert.equal(await fixture.run(port => {
    fixture.routes.set(port, "localabstract:other_process");
    return "WebView evidence";
  }), "WebView evidence");
  assert.deepEqual([...fixture.routes], [["41001", "localabstract:other_process"]]);
});

test("leaves a same-socket route intact when ADB never identifies the allocated port", async () => {
  const fixture = fakeForward({ acknowledge: false });
  await assert.rejects(fixture.run(() => assert.fail("WebView check should not run")),
    /setup acknowledgment lost/);
  assert.deepEqual([...fixture.routes], [["41001", target]]);
});

test("refuses to attach when the returned port points at a different socket", async () => {
  const fixture = fakeForward({ remote: "localabstract:other_process" });
  await assert.rejects(fixture.run(() => assert.fail("WebView check should not run")), /forward ownership unconfirmed/);
  assert.deepEqual([...fixture.routes], [["41001", "localabstract:other_process"]]);
});
