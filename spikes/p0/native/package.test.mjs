import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const spike = fileURLToPath(new URL("../", import.meta.url));

test("provisioning accepts only the Development key scope matching the selected origin", async () => {
  const { devKeyMatchesOrigin } = await import("./local-provider/hosted-provision.mjs");
  const origin = "https://fixture.convex.cloud";
  assert.equal(devKeyMatchesOrigin("dev:fixture|inert-example", origin), true);
  for (const key of ["prod:fixture|inert-example", "dev:other|inert-example", "dev:fixture|", "inert-example"]) {
    assert.equal(devKeyMatchesOrigin(key, origin), false);
  }
  assert.equal(devKeyMatchesOrigin("dev:fixture|inert-example", origin + "/"), false);
});

test("hosted native entry rejects a noncanonical origin before reading credentials", () => {
  const result = spawnSync(process.execPath, [
    "native/local-provider/hosted-run.mjs", "--origin", "https://fixture.convex.cloud/",
    "--emulator", "emulator-5586", "--accounts-file", "missing-private-file",
  ], { cwd: spike, encoding: "utf8", env: { ...process.env, DEBUG: "pw:protocol", NODE_USE_ENV_PROXY: "1" } });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Invalid hosted native fixture configuration\./);
});

test("Android live admission starts a fresh process without proxy or protocol logging settings", async () => {
  const { androidAcceptanceEnv } = await import("./local-provider/android-acceptance-worker.mjs");
  assert.deepEqual(androidAcceptanceEnv({
    ADB: "adb", SystemRoot: "Windows", DEBUG: "pw:protocol", NODE_DEBUG: "http",
    NODE_OPTIONS: "--use-env-proxy", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://127.0.0.1:1",
    unrelated: "unused",
  }), { ADB: "adb", SystemRoot: "Windows" });
  const result = spawnSync(process.execPath, ["native/smoke.mjs", "android-provider-acceptance", "invalid"], {
    cwd: spike, encoding: "utf8", env: { ...process.env, DEBUG: "pw:protocol", NODE_USE_ENV_PROXY: "1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Pass a disposable AVD serial/);
});

async function copyPackager(root, native) {
  await mkdir(native, { recursive: true });
  await copyFile(new URL("./package.mjs", import.meta.url), join(native, "package.mjs"));
  await copyFile(new URL("../build-policy.mjs", import.meta.url), join(root, "build-policy.mjs"));
}

for (const { name, options, invalid, message } of [
  {
    name: "session packaging rejects hosted origins and Android arm64",
    options: ["--session"],
    invalid: [
      ["--target", "windows", "--origin", "https://fixture.convex.cloud"],
      ["--target", "x86_64", "--origin", "https://fixture.convex.cloud"],
      ["--target", "aarch64"],
    ],
    message: /session fixture requires offline Windows or Android x86_64/,
  },
  {
    name: "HTTP sign-out packaging requires an offline Windows session fixture",
    options: ["--sign-out-http"],
    invalid: [[], ["--session", "--target", "x86_64"], ["--session", "--origin", "https://fixture.convex.cloud"]],
    message: /HTTP sign-out requires the offline Windows session fixture/,
  },
  {
    name: "Android provider preflight packaging requires offline Android x86_64 session flags",
    options: ["--android-provider-preflight"],
    invalid: [
      [],
      ["--session"],
      ["--target", "x86_64"],
      ["--target", "aarch64", "--session"],
      ["--target", "x86_64", "--session", "--origin", "https://fixture.convex.cloud"],
      ["--target", "x86_64", "--session", "--sign-out-http"],
    ],
    message: /Android provider preflight requires --target x86_64 --session without --origin or --sign-out-http/,
  },
  {
    name: "Android hosted provider packaging requires a canonical origin and isolated session flags",
    options: ["--android-provider-hosted"],
    invalid: [
      ["--target", "x86_64", "--session"],
      ["--target", "x86_64", "--session", "--origin", "https://fixture.convex.cloud/"],
      ["--target", "x86_64", "--session", "--origin", "https://fixture.convex.cloud", "--android-provider-preflight"],
      ["--target", "aarch64", "--origin", "https://fixture.convex.cloud"],
      ["--target", "aarch64", "--session"],
      ["--target", "windows", "--session", "--origin", "https://fixture.convex.cloud"],
    ],
    message: /Android hosted provider requires/,
  },
]) {
  test(name, async t => {
    const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const native = join(root, "native");
    const packager = join(native, "package.mjs");
    await copyPackager(root, native);
    for (const args of invalid) {
      const result = spawnSync(process.execPath, [packager, ...options, ...args], {
        cwd: root, encoding: "utf8", env: { PATH: root }, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.deepEqual(await readdir(native), ["package.mjs"]);
    }
  });
}

for (const stagedSource of [
  "java/dev/klaxon/p0native/SessionPlugin.kt", "java/dev/klaxon/p0session/FixtureStore.java",
  "java/dev/klaxon/p0native/LocalProviderPlugin.kt", "AndroidManifest.xml",
]) {
  test("Android packaging stops before the frontend when " + stagedSource + " is already staged", async t => {
    const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const native = join(root, "native");
    const packager = join(native, "package.mjs");
    const staged = join(native, "src-tauri/gen/android/app/src/debug", stagedSource);
    await mkdir(dirname(staged), { recursive: true });
    await copyPackager(root, native);
    await writeFile(join(root, "build-portable.mjs"), 'throw new Error("unexpected frontend build");\n');
    const marker = "// fixture source left by an interrupted build\n";
    await writeFile(staged, marker, { flag: "wx" });

    const targets = [
      ["--target", "x86_64"], ["--target", "x86_64", "--session"], ["--target", "aarch64"],
      ["--target", "x86_64", "--session", "--android-provider-preflight"],
    ];
    for (const args of targets) {
      const result = spawnSync(process.execPath, [packager, ...args], {
        cwd: root, encoding: "utf8", env: { PATH: root }, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /unexpected frontend build/);
      assert.match(result.stderr, /Found staged Android fixture source/);
      assert.ok(result.stderr.includes(staged), "expected the conflicting source path in the error");
      assert.equal(await readFile(staged, "utf8"), marker);
      assert.deepEqual(await readdir(join(native, ".run")), [], "expected the lock to be released before any build output");
    }
  });
}

const preflightConnections = "connect-src ipc: http://ipc.localhost http://127.0.0.1:3210 ws://127.0.0.1:3210 ws://127.0.0.1:3212";
const preflightMarker = '<meta name="p0-android-provider-preflight" content="loopback-only">';

for (const { target, mode, origin, connect } of [
  { target: "x86_64", mode: "android-provider-preflight", connect: preflightConnections },
  { target: "aarch64", mode: "android-provider-hosted", origin: "https://fixture.convex.cloud",
    connect: "connect-src ipc: http://ipc.localhost https://fixture.convex.cloud wss://fixture.convex.cloud" },
]) test(`${mode} for ${target} writes a dedicated native policy and forwards the frontend flag`, async t => {
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "native");
  const run = join(native, ".run");
  await copyPackager(root, native);
  await mkdir(run);
  // Stop after the config write and before the first Android tool invocation.
  await writeFile(join(run, "android-user"), "");
  await writeFile(join(root, "build-portable.mjs"), [
    'import { writeFile } from "node:fs/promises";',
    'await writeFile("frontend-args.json", JSON.stringify(process.argv.slice(2)));',
  ].join("\n"));
  const result = spawnSync(process.execPath, [
    join(native, "package.mjs"), "--target", target, "--session", "--" + mode, ...(origin ? ["--origin", origin] : []),
  ], { cwd: root, encoding: "utf8", timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /(?:EEXIST|ENOTDIR).*android-user/);
  const overlay = JSON.parse(await readFile(join(run, mode + ".json"), "utf8"));
  assert.equal(overlay.app.withGlobalTauri, true);
  assert.equal(overlay.app.security.csp.split("; ").find(rule => rule.startsWith("connect-src ")), connect);
  assert.deepEqual(JSON.parse(await readFile(join(root, "frontend-args.json"), "utf8")), [
    "--outdir", "native/.run/" + mode + "-frontend", "--session", "--" + mode,
  ]);
  assert.equal(overlay.build.frontendDist, "../.run/" + mode + "-frontend");
});

test("portable builds isolate the Android provider preflight marker and loopback CSP", async t => {
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const { name, args, origin, connect, preflight } of [
    {
      name: "preflight", args: ["--session", "--android-provider-preflight"], origin: "",
      connect: preflightConnections, preflight: true,
    },
    { name: "session", args: ["--session"], origin: "", connect: "connect-src 'none'" },
    {
      name: "hosted", args: [], origin: "https://fixture.convex.cloud",
      connect: "connect-src https://fixture.convex.cloud wss://fixture.convex.cloud",
    },
    {
      name: "hosted-session", args: ["--session", "--android-provider-hosted"], origin: "https://fixture.convex.cloud",
      connect: "connect-src ipc: http://ipc.localhost https://fixture.convex.cloud wss://fixture.convex.cloud",
    },
  ]) {
    const outdir = join(root, name);
    const result = spawnSync(process.execPath, ["build-portable.mjs", "--outdir", outdir, ...args], {
      cwd: spike, encoding: "utf8", env: { ...process.env, P0_PUBLIC_DEV_ORIGIN: origin }, timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const html = await readFile(join(outdir, "index.html"), "utf8");
    assert.equal(html.includes(preflightMarker), !!preflight);
    const [, policy] = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert.equal(policy.split("; ").find(rule => rule.startsWith("connect-src ")), connect);
    if (preflight || name === "hosted-session") {
      assert.ok(html.includes("fixture_sdk_access"));
      const client = await readFile(join(outdir, "local-provider.js"), "utf8");
      assert.match(client, /\.p0LocalProvider=/);
      if (name === "hosted-session") {
        assert.ok(html.includes('<meta name="p0-hosted-provider" content="https://fixture.convex.cloud">'));
        assert.ok(client.includes(origin));
      }
      const integrity = "sha256-" + createHash("sha256").update(client).digest("base64");
      assert.ok(html.includes(`<script src="./local-provider.js" integrity="${integrity}"></script>`));
      assert.ok(policy.split("; ").find(rule => rule.startsWith("script-src ")).includes("'" + integrity + "'"));
    } else {
      assert.deepEqual(await readdir(outdir), ["index.html"]);
      assert.ok(!html.includes("local-provider.js"));
    }
  }
});

test("portable Android provider preflight rejects non-session, Windows and hosted builds", async t => {
  const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const { args, origin } of [
    { args: [], origin: "" },
    { args: ["--session", "--windows-tasks"], origin: "" },
    { args: ["--session"], origin: "https://fixture.convex.cloud" },
  ]) {
    const result = spawnSync(process.execPath, [
      "build-portable.mjs", "--outdir", root, "--android-provider-preflight", ...args,
    ], { cwd: spike, encoding: "utf8", env: { ...process.env, P0_PUBLIC_DEV_ORIGIN: origin }, timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Android provider preflight requires the offline session frontend without Windows tasks/);
    assert.deepEqual(await readdir(root), []);
  }
});
