import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const vite = join(root, 'node_modules/vite/bin/vite.js');
const development = ['--mode', 'development'];

test('Vite excludes deploy keys from the public build environment', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveConfig } from 'vite';
    const config = await resolveConfig({}, 'build', 'production');
    if (Object.hasOwn(config.env, 'VITE_CONVEX_DEPLOY_KEY')) process.exitCode = 1;
  `], {
    cwd: root,
    env: { ...process.env, VITE_CONVEX_DEPLOY_KEY: 'inert-test-value' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'deploy keys must be excluded from the Vite client environment');
});

function build(output, options = [], environment = {}) {
  const env = { ...process.env };
  delete env.KLAXON_PUBLIC_DEV_ORIGIN;

  const result = spawnSync(process.execPath, [vite, 'build', '--outDir', output, ...options], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, ...environment },
    timeout: 30_000,
  });
  assert.ifError(result.error);
  return result;
}

async function scratch(t) {
  const path = await mkdtemp(join(root, '.verification-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('Development builds reject missing and invalid origins before writing output', async (t) => {
  const parent = await scratch(t);
  const output = join(parent, 'dist');

  for (const env of [{}, { KLAXON_PUBLIC_DEV_ORIGIN: 'https://invalid.example' }]) {
    const result = build(output, development, env);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /KLAXON_PUBLIC_DEV_ORIGIN must be a plain HTTPS Convex deployment origin/);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  }
});

test('Development build publishes the configured origin without bundling deploy keys', async (t) => {
  const output = join(await scratch(t), 'dist');
  const origin = 'https://klaxon-development-test.convex.cloud';
  const sentinel = 'KLAXON_P1_INERT_DEPLOY_KEY_SENTINEL_61e4729b';
  const result = build(output, [...development, '--sourcemap'], {
    KLAXON_PUBLIC_DEV_ORIGIN: origin,
    CONVEX_DEPLOY_KEY: sentinel,
    VITE_CONVEX_DEPLOY_KEY: sentinel,
  });
  assert.equal(result.status, 0, result.stderr);

  const files = await readdir(output, { recursive: true, withFileTypes: true });
  assert.ok(files.some(file => file.isFile() && file.name.endsWith('.map')), 'expected source maps to scan');
  for (const file of files.filter(file => file.isFile())) {
    const contents = await readFile(join(file.parentPath, file.name));
    assert.ok(!contents.includes(sentinel), `${file.name} leaked the deploy-key sentinel`);
  }

  const html = await readFile(join(output, 'index.html'), 'utf8');
  assert.ok(html.includes(`<meta name="klaxon-development-origin" content="${origin}">`));
});
