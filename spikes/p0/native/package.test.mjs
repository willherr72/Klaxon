import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

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
]) {
  test(name, async t => {
    const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packager = join(root, "package.mjs");
    await copyFile(new URL("./package.mjs", import.meta.url), packager);
    for (const args of invalid) {
      const result = spawnSync(process.execPath, [packager, ...options, ...args], {
        cwd: root, encoding: "utf8", env: { PATH: root }, timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
      assert.match(result.stderr, message);
      assert.deepEqual(await readdir(root), ["package.mjs"]);
    }
  });
}

for (const stagedSource of ["p0native/SessionPlugin.kt", "p0session/FixtureStore.java"]) {
  test("Android packaging stops before the frontend when " + stagedSource + " is already staged", async t => {
    const root = await mkdtemp(join(tmpdir(), "klaxon-p0-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const native = join(root, "native");
    const packager = join(native, "package.mjs");
    const staged = join(native, "src-tauri/gen/android/app/src/debug/java/dev/klaxon", stagedSource);
    await mkdir(dirname(staged), { recursive: true });
    await copyFile(new URL("./package.mjs", import.meta.url), packager);
    await writeFile(join(root, "build-portable.mjs"), 'throw new Error("unexpected frontend build");\n');
    const marker = "// fixture source left by an interrupted build\n";
    await writeFile(staged, marker, { flag: "wx" });

    const targets = [["--target", "x86_64"], ["--target", "x86_64", "--session"], ["--target", "aarch64"]];
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
