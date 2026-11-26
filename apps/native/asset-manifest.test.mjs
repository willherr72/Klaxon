import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordAssets, verifyAssets } from "./asset-manifest.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "klaxon-v2-assets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const manifest = join(dir, "asset-manifest.json");
  await mkdir(join(dist, "assets"), { recursive: true });
  await writeFile(join(dist, "index.html"), '<script src="./assets/app.js"></script>');
  await writeFile(join(dist, "assets", "app.js"), "document.title = 'Klaxon'");
  return { dist, manifest };
}

test("the tested bundle verifies after transfer to a new directory", async t => {
  const { dist, manifest } = await fixture(t);
  await recordAssets(dist, manifest);
  const moved = dist + "-received";
  await rename(dist, moved);
  await verifyAssets(moved, manifest);
});

for (const change of ["replaced", "missing", "extra"]) {
  test(`verification rejects a bundle when an asset is ${change}`, async t => {
    const { dist, manifest } = await fixture(t);
    await recordAssets(dist, manifest);
    const js = join(dist, "assets", "app.js");
    if (change === "replaced") await writeFile(js, "different bytes");
    if (change === "missing") await rm(js);
    if (change === "extra") await writeFile(join(dist, "unexpected.txt"), "extra");
    await assert.rejects(verifyAssets(dist, manifest), /asset manifest mismatch/i);
  });
}

test("a directory without the web entry point cannot become a baseline", async t => {
  const { dist, manifest } = await fixture(t);
  await rm(join(dist, "index.html"));
  await assert.rejects(recordAssets(dist, manifest), /index.html/);
});

test("both package commands stop on a changed web bundle before invoking Tauri", async t => {
  const root = await mkdtemp(join(tmpdir(), "klaxon-v2-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = join(root, "apps", "native");
  const web = join(root, "apps", "web");
  const dist = join(web, "dist");
  await mkdir(native, { recursive: true });
  await mkdir(dist, { recursive: true });
  for (const name of ["package.mjs", "asset-manifest.mjs"]) {
    await copyFile(new URL(name, import.meta.url), join(native, name));
  }
  const entry = join(dist, "index.html");
  await writeFile(entry, "browser-tested");
  await recordAssets(dist, join(web, "asset-manifest.json"));
  await writeFile(entry, "overwritten");
  for (const platform of ["windows", "android"]) {
    const run = spawnSync(process.execPath, [join(native, "package.mjs"), platform], {
      cwd: root, encoding: "utf8", timeout: 15000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /web asset manifest mismatch/i);
  }
});
