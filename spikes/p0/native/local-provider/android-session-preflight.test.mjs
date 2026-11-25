import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { withAndroidTarget } from "./android-session-preflight.mjs";

const appId = "dev.klaxon.p0native";
const origin = "https://fixture.example";
const input = { owner: "fixture-owner", username: "fixture-user", password: "fixture-password" };
const inputPath = "cache/p0-local-input.json";

for (const failure of ["lost staging acknowledgment", "mismatched readback", "sign-in", "observation",
  "lost removal acknowledgment"]) {
  test(`removes the one-use input before hosted retirement after ${failure}`, async () => {
    let stagedInput;
    let stagingBuffer;
    let readbackBuffer;
    let inputAtRetirement;
    let activities = 0;
    let forceStop;
    let removals = 0;
    const platform = {
      appId, primaryUser: true,
      async withActivity(action) {
        const window = {
          __TAURI__: { core: { invoke: async () => origin } },
          p0LocalProvider: { origin, hostedProbeVersion: 1 },
        };
        const page = {
          async waitForFunction(fn) { assert.ok(await this.evaluate(fn)); },
          evaluate(fn) { return runInNewContext(`(${fn})()`, { window, location: { origin: "http://tauri.localhost" } }); },
          getByRole() { return { getByRole: () => ({ count: async () => 0 }) }; },
          locator() { return { getAttribute: async () => origin }; },
        };
        await action(page, ++activities);
      },
      adb(...args) {
        if (args[1] === "am") {
          forceStop = args;
        } else if (args[1] === "sh") {
          assert.deepEqual(args, ["shell", "sh", "-c", "'pidof " + appId + " || true'"]);
        } else {
          assert.deepEqual(args, ["shell", "run-as", appId, "rm", "-f", inputPath]);
          stagedInput = undefined;
          removals++;
          if (failure === "lost removal acknowledgment" && removals === 1) throw Error("removal acknowledgment lost");
        }
        return "";
      },
      adbBytes(args, bytes) {
        if (bytes) {
          assert.deepEqual(args, ["shell", "-T", "run-as", appId, "sh", "-c", "'umask 077; cat > " + inputPath + "'"]);
          stagingBuffer = bytes;
          stagedInput = Buffer.from(bytes);
          if (failure === "lost staging acknowledgment") throw Error("staging acknowledgment lost");
          return Buffer.alloc(0);
        }
        assert.deepEqual(args, ["shell", "-T", "run-as", appId, "base64", "'" + inputPath + "'"]);
        const readback = failure === "mismatched readback" ? Buffer.from("partial input") : stagedInput;
        readbackBuffer = Buffer.from(readback.toString("base64"));
        return readbackBuffer;
      },
    };

    async function runHostedScope() {
      try {
        await withAndroidTarget(platform, input, async launch => {
          if (failure === "sign-in") await launch(() => { throw Error("sign-in failed"); });
          return { status: "failed", stage: "observation" };
        }, origin);
      } finally {
        inputAtRetirement = stagedInput !== undefined;
      }
    }

    const expectedError = {
      "lost staging acknowledgment": /staging acknowledgment lost/,
      "mismatched readback": /One-use input was not staged intact/,
      "sign-in": /sign-in failed/,
      "observation": /SDK lifecycle failed at observation/,
      "lost removal acknowledgment": /SDK lifecycle failed at observation/,
    }[failure];
    await assert.rejects(runHostedScope(), expectedError);
    assert.equal(inputAtRetirement, false, "Android still held a copy of the input at retirement");
    assert.ok(stagingBuffer.every(byte => byte === 0), "The input buffer was not cleared");
    if (readbackBuffer) assert.ok(readbackBuffer.every(byte => byte === 0), "The input readback was not cleared");
    if (failure === "sign-in") assert.deepEqual(forceStop, ["shell", "am", "force-stop", "--user", "0", appId]);
    if (failure === "lost removal acknowledgment") assert.equal(removals, 2);
  });
}
