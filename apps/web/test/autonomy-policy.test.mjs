import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

test('owner edits review, project scope, task exclusions and hours, then retries an unconfirmed save', async t => {
  const webRoot = fileURLToPath(new URL('..', import.meta.url));
  const scratch = await mkdtemp(join(webRoot, '.verification-autonomy-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(scratch, 'index.html'), '<!doctype html><title>Planning autonomy</title><div id="app"></div><script type="module" src="./main.js"></script>'),
    writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
      import Fixture from './Fixture.svelte';
      mount(Fixture, { target: document.querySelector('#app') });`),
    writeFile(join(scratch, 'Fixture.svelte'), `<script>
      import { getFunctionName } from 'convex/server';
      import AutonomyPolicy from '../src/settings/AutonomyPolicy.svelte';
      const snapshot = { revision: 2, timezone: 'America/Chicago', taskNames: [], projectNames: [],
        policy: { planApplication: 'automatic', scope: { kind: 'all' }, schedule: [],
          excludedTaskPublicIds: [], excludedProjectPublicIds: [] } };
      globalThis.writes = [];
      let publish;
      let dirty = $state(false);
      const client = {
        onUpdate(ref, args, callback) {
          const name = getFunctionName(ref);
          const values = {
            'autonomy:get': snapshot,
            'projects:list': { page: [{ publicId: 'test-project', name: 'Test project', area: 'Work' }], isDone: true },
            'autonomy:searchTasks': [{ publicId: 'test-task', name: args.title }],
          };
          if (name === 'autonomy:get') publish = callback;
          queueMicrotask(() => callback(values[name]));
          return () => {};
        },
        async mutation(ref, args) {
          globalThis.writes.push({ name: getFunctionName(ref), args });
          if (globalThis.writes.length === 1) {
            publish({ ...snapshot, revision: 3, policy: args.policy });
            throw new Error('Response lost');
          }
          return { revision: 3 };
        },
      };
    </script>
    <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
    <AutonomyPolicy {client} workspaceId="workspace" disabled={false}
      onDirtyChange={value => dirty = value} onUnauthenticated={() => {}} />`),
  ]);
  const result = await build({ root: scratch, base: './', configFile: false, plugins: [svelte()],
    logLevel: 'silent', build: { write: false, modulePreload: false } });
  const assets = new Map(result.output.map(file => [`/${file.fileName}`, file.source ?? file.code]));
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  const origin = 'https://autonomy.test';
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const body = assets.get(path);
    if (url.origin !== origin || body === undefined) return route.abort();
    await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.goto(origin);
  const button = name => page.getByRole('button', { name, exact: true });
  await button('Edit planning policy').click();
  await page.getByText('Dirty', { exact: true }).waitFor();
  await page.getByLabel('Plan application').selectOption('review');
  await page.getByLabel('Planning scope').selectOption('projects');
  await page.getByLabel('Include projects').selectOption('test-project');
  await page.getByLabel('Exclude individual tasks').fill('Skip weekly report');
  await button('Exclude Skip weekly report').click();
  await button('Add run window').click();
  await page.getByRole('combobox', { name: 'Day', exact: true }).selectOption('4');
  await page.getByLabel('Start', { exact: true }).fill('10:15');
  await page.getByLabel('End', { exact: true }).fill('00:00');
  await button('Save planning policy').click();
  await button('Retry save').click();
  await page.getByText('Planning policy saved.').waitFor();
  await page.getByText('Clean', { exact: true }).waitFor();
  const [first, retry] = await page.evaluate(() => globalThis.writes);
  assert.deepEqual(first, retry);
  assert.equal(first.name, 'autonomy:update');
  assert.equal(first.args.expectedRevision, 2);
  assert.deepEqual(first.args.policy, {
    planApplication: 'review',
    scope: { kind: 'projects', projectPublicIds: ['test-project'] },
    schedule: [{ weekday: 4, startMinute: 615, endMinute: 1440 }],
    excludedTaskPublicIds: ['test-task'],
    excludedProjectPublicIds: [],
  });
});
