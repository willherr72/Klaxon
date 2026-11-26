import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { withLocalProviderScenario } from "./provider-controls.mjs";
import { withWindowsHost } from "../smoke.mjs";
import { withLocalBackend } from "./backend.mjs";
import { buildLocalProvider, executable } from "./build.mjs";
import { exerciseLocalProvider } from "./check.mjs";
import { withSubscriptionRelay } from "./relay.mjs";

let stage = "build";

async function run(url, relay) {
  const tempParent = await realpath(tmpdir());
  const root = await mkdtemp(join(tempParent, "klaxon-p0-session-"));
  const profile = join(root, "webview");
  const slot = join(root, "packaged.bin");
  const capture = { hosts: new Set(), browsers: new Set(), runName: basename(root) };
  try {
    await mkdir(profile);
    stage = "local provider accounts, controls and packaged host";
    const result = await withLocalProviderScenario(url, async ({ input, ...controls }) => {
      let launches = 0;
      async function launch(action) {
        const first = launches++ === 0;
        const env = { TEMP: tempParent, TMP: tempParent, KLAXON_P0_LOCAL_OWNER_ID: input.owner };
        if (first) {
          env.KLAXON_P0_LOCAL_USER = input.username;
          env.KLAXON_P0_LOCAL_PASSWORD = input.password;
        }
        await withWindowsHost(executable, profile, action, capture, env);
        if (first) {
          const sealed = await readFile(slot);
          assert.ok(sealed.length > 0 && !sealed.includes(input.password),
            "Expected a protected session record from the first host");
        }
      }
      return exerciseLocalProvider({ launch, ...controls, relay,
        verifySlotCleared: () => assert.rejects(access(slot), { code: "ENOENT" }),
      });
    });
    if (result.status !== "passed") return result;
    assert.equal(capture.hosts.size, 2);
    assert.equal(capture.browsers.size, 2);
    await assert.rejects(access(slot), { code: "ENOENT" });
    return { ...result, nativeHosts: capture.hosts.size, webViews: capture.browsers.size, protectedSlotCleared: true };
  } finally {
    assert.equal(dirname(root), tempParent);
    assert.ok(/^klaxon-p0-session-[a-z0-9]{6}$/i.test(basename(root)));
    const entry = await lstat(root);
    assert.ok(entry.isDirectory() && !entry.isSymbolicLink() && await realpath(root) === root);
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 });
  }
}

try {
  const args = process.argv.slice(2);
  const reconnect = args.length === 1 && args[0] === "--reconnect";
  if (args.length && !reconnect) throw Error("Expected --reconnect or no argument");
  if (!reconnect) await buildLocalProvider();
  // The native child inherits only platform settings and its dedicated test inputs.
  const platformEnv = new Set([
    "systemroot", "windir", "systemdrive", "comspec", "pathext", "path", "temp", "tmp",
    "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata",
    "processor_architecture", "number_of_processors",
  ]);
  for (const key of Object.keys(process.env)) if (!platformEnv.has(key.toLowerCase())) delete process.env[key];
  stage = "isolated local backend startup or cleanup";
  const evidence = await withLocalBackend(async ({ url }) => {
    // The fixed upstream belongs to our isolated backend before the relay listens.
    const result = reconnect ? await withSubscriptionRelay(async relay => {
      stage = "packaged reconnect build";
      await buildLocalProvider(relay.port);
      return run(url, relay);
    }) : await run(url);
    stage = "isolated local backend cleanup";
    return result;
  });
  console.log("Packaged local provider evidence", evidence);
  if (evidence.status !== "passed") process.exitCode = 1;
} catch (error) {
  // SDK and Playwright failures can include live data. Emit only fixture source locations.
  const locations = (error.stack ?? "").split("\n").slice(1)
    .map(line => line.match(/[\\/](backend|check|run|smoke|client)\.m?js:(\d+):\d+\)?$/))
    .filter(Boolean).map(match => match[1] + ":" + match[2]);
  console.error("Local provider exercise failed during", stage, locations.join(", "));
  process.exitCode = 1;
}
