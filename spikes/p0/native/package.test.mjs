import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

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
