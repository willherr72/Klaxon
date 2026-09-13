import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkVersions, runSteps } from './verify.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'klaxon-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src-tauri'));
  const files = {
    'package.json': JSON.stringify({ version: '0.10.3' }),
    'package-lock.json': JSON.stringify({ version: '0.10.3', packages: { '': { version: '0.10.3' } } }),
    'src-tauri/Cargo.toml': '[package]\nname = "klaxon"\nversion = "0.10.3"\n[dependencies]\nother = "9.0.0"\n',
    'src-tauri/Cargo.lock': 'version = 4\n[[package]]\nname = "other"\nversion = "2.0.0"\n[[package]]\nname = "klaxon"\nversion = "0.10.3"\n',
    'src-tauri/tauri.conf.json': JSON.stringify({ version: '0.10.3' }),
    ...overrides,
  };
  for (const [file, content] of Object.entries(files)) await writeFile(join(root, file), content);
  return root;
}

test('aligned versions accept the exact release tag', async t => {
  const root = await fixture(t);
  assert.equal(await checkVersions(root, 'v0.10.3'), '0.10.3');
  await assert.rejects(checkVersions(root, 'v0.10.4'), /tag/i);
  await assert.rejects(checkVersions(root, '0.10.3'), /tag/i);
});

for (const [file, content] of Object.entries({
  'package-lock.json': '{"version":"0.10.2","packages":{"":{"version":"0.10.3"}}}',
  'src-tauri/Cargo.toml': '[package]\nname="klaxon"\nversion="0.10.2"',
  'src-tauri/Cargo.lock': 'version=4\n[[package]]\nname="klaxon"\nversion="0.10.2"',
  'src-tauri/tauri.conf.json': '{"version":"0.10.2"}',
})) {
  test(`rejects version drift in ${file}`, async t => {
    await assert.rejects(checkVersions(await fixture(t, { [file]: content })), /version/i);
  });
}

test('rejects drift in nested npm lock root and missing Cargo package', async t => {
  await assert.rejects(checkVersions(await fixture(t, {
    'package-lock.json': '{"version":"0.10.3","packages":{"":{"version":"0.10.2"}}}',
  })), /version/i);
  await assert.rejects(checkVersions(await fixture(t, {
    'src-tauri/Cargo.lock': 'version=4\n[[package]]\nname="other"\nversion="0.10.3"',
  })), /klaxon/i);
});

test('command execution stops before subsequent side effects on failure', async t => {
  const root = await fixture(t);
  const marker = join(root, 'should-not-exist');
  await assert.rejects(runSteps([
    [process.execPath, ['-e', 'process.exit(7)']],
    [process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`]],
  ], root), /7/);
  assert.equal(spawnSync(process.execPath, ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(marker)}) ? 1 : 0)`]).status, 0);
});
