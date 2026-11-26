import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const mount = '/klaxon/foundation/';

async function scratch(t) {
  const dir = await mkdtemp(join(root, '.verification-pwa-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function bakedApp(dir, mode) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', mode, '--outDir', dir], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, KLAXON_PUBLIC_DEV_ORIGIN: 'https://klaxon-pwa-test.convex.cloud' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const assets = new Map();
  for (const file of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    assets.set(relative(dir, path).split(sep).join('/'), await readFile(path));
  }
  return assets;
}

test('only the Development build emits a manifest and mount-relative install assets', { timeout: 120_000 }, async t => {
  const dir = await scratch(t);
  const [development, offline] = await Promise.all([
    bakedApp(join(dir, 'development'), 'development'),
    bakedApp(join(dir, 'offline'), 'production'),
  ]);
  const html = development.get('index.html').toString();
  assert.match(html, /rel="manifest" href="\.\/pwa-manifest\.webmanifest"/);
  const manifest = JSON.parse(development.get('pwa-manifest.webmanifest'));
  assert.equal(manifest.name, 'Klaxon');
  assert.equal(manifest.display, 'standalone');
  const url = 'https://example.test' + mount + 'pwa-manifest.webmanifest';
  assert.equal(new URL(manifest.scope, url).pathname, mount);
  assert.equal(new URL(manifest.start_url, url).pathname, mount);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(candidate => candidate.sizes === `${size}x${size}`);
    assert.ok(icon);
    const iconUrl = new URL(icon.src, url);
    assert.ok(iconUrl.pathname.startsWith(mount));
    const image = development.get(iconUrl.pathname.slice(mount.length));
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
  assert.ok(development.has('pwa-sw.js'));
  assert.ok(development.has('pwa-notifications.js'));
  assert.doesNotMatch(offline.get('index.html').toString(), /rel="manifest"/);
  assert.deepEqual([...offline.keys()].filter(file => file.startsWith('pwa-')), []);
});

async function bakedFixture(dir, version) {
  const { plannerPwa } = await import('../src/pwa/build.mjs');
  await Promise.all([
    writeFile(join(dir, 'index.html'), '<!doctype html><div id="app"></div><script type="module" src="./main.js"></script>'),
    writeFile(join(dir, 'main.js'), `import { mount } from 'svelte';
      import Fixture from './Fixture.svelte';
      import * as push from '../src/pwa/push-client';
      globalThis.push = push;
      mount(Fixture, { target: document.querySelector('#app') });`),
    writeFile(join(dir, 'Fixture.svelte'), `<script>
        import PwaControls from '../src/pwa/PwaControls.svelte';
        let draft = $state('');
      </script>
      <main><h1>${version}</h1><label>Draft <input bind:value={draft}/></label>
      <PwaControls blocked={Boolean(draft)} /></main>`),
  ]);
  const result = await build({ root: dir, base: './', configFile: false, plugins: [svelte(), plannerPwa()], logLevel: 'silent',
    build: { write: false, modulePreload: false } });
  return new Map(result.output.map(asset => [asset.fileName, asset.source ?? asset.code]));
}

async function serve(t, first) {
  let assets = first;
  const privateRequests = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === `${mount}api/private`) {
      privateRequests.push(request.headers.authorization);
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"private":"not a shell asset"}');
      return;
    }
    if (!path.startsWith(mount)) { response.writeHead(404).end(); return; }
    const file = path.slice(mount.length) || 'index.html';
    const contents = assets.get(file);
    if (!contents) { response.writeHead(404).end(); return; }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' }).end(contents);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}${mount}`, privateRequests, publish(next) { assets = next; } };
}

test('the built worker reloads the offline shell and never caches authenticated responses', { timeout: 120_000 }, async t => {
  const deployment = await serve(t, await bakedFixture(await scratch(t), 'Klaxon offline shell'));
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(deployment.url + '#/capture');
  await page.waitForFunction(() => globalThis.navigator.serviceWorker.controller !== null);
  const privateData = await page.evaluate(async () => {
    const response = await fetch('./api/private', { headers: { Authorization: 'Bearer inert-pwa' } });
    return response.json();
  });
  assert.deepEqual(privateData, { private: 'not a shell asset' });
  assert.deepEqual(deployment.privateRequests, ['Bearer inert-pwa']);
  assert.equal(await page.evaluate(async () => !!(await globalThis.caches.match('./api/private'))), false);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Klaxon offline shell' }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/capture');
  assert.equal(await page.evaluate(async () => fetch('./api/private').then(() => true, () => false)), false);
});

test('an explicit update reloads only the asking clean tab and preserves another tab’s draft', { timeout: 120_000 }, async t => {
  const dir = await scratch(t);
  const first = await bakedFixture(dir, 'Klaxon first build');
  const next = await bakedFixture(dir, 'Klaxon next build');
  const deployment = await serve(t, first);
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const [asking, peer] = [await context.newPage(), await context.newPage()];
  for (const page of [asking, peer]) {
    page.setDefaultTimeout(8_000);
    await page.goto(deployment.url);
    await page.waitForFunction(() => globalThis.navigator.serviceWorker.controller !== null);
    await page.getByRole('heading', { name: 'Klaxon first build' }).waitFor();
  }
  await asking.getByLabel('Draft').fill('Own draft');
  await peer.getByLabel('Draft').fill('Keep peer draft');
  deployment.publish(next);
  await asking.evaluate(async () => (await globalThis.navigator.serviceWorker.ready).update());
  const update = asking.getByRole('button', { name: 'Reload to update' });
  await update.waitFor();
  assert.ok(await update.isDisabled());
  await asking.getByLabel('Draft').fill('');
  await update.click();
  await asking.getByRole('heading', { name: 'Klaxon next build' }).waitFor();

  await peer.getByRole('heading', { name: 'Klaxon first build' }).waitFor();
  assert.equal(await peer.getByLabel('Draft').inputValue(), 'Keep peer draft');
  const peerUpdate = peer.getByRole('button', { name: 'Reload to update' });
  await peerUpdate.waitFor();
  assert.ok(await peerUpdate.isDisabled());
  await peer.getByLabel('Draft').fill('');
  await peerUpdate.click();
  await peer.getByRole('heading', { name: 'Klaxon next build' }).waitFor();
});

test('synthetic push validates the device, deduplicates delivery, clears receipts and opens only Reminders', { timeout: 120_000 }, async t => {
  const deployment = await serve(t, await bakedFixture(await scratch(t), 'Klaxon reminders'));
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(deployment.url);
  await page.waitForFunction(() => globalThis.navigator.serviceWorker.controller !== null);
  const [worker] = context.serviceWorkers();
  await worker.evaluate(() => {
    const notices = [], opened = [], posted = [];
    let offeredClients = [];
    Object.defineProperty(globalThis.registration.pushManager, 'getSubscription', {
      value: async () => ({ endpoint: 'https://push-fixture.example/current-device' }),
    });
    Object.defineProperty(globalThis.registration, 'showNotification', { value: async (title, options) => { notices.push({ title, options }); } });
    Object.defineProperty(globalThis.clients, 'matchAll', { value: async () => offeredClients });
    Object.defineProperty(globalThis.clients, 'openWindow', { value: async url => { opened.push(url); } });
    globalThis.fixture = { notices, opened, posted, offerWindow(url) {
      offeredClients = [{ url, postMessage: message => posted.push(message), focus: async () => posted.push('focused') }];
    } };
  });
  const send = data => worker.evaluate(async value => {
    const pending = [];
    const event = new globalThis.Event('push');
    Object.defineProperties(event, {
      data: { value: { text: () => JSON.stringify(value) } }, waitUntil: { value: promise => pending.push(promise) },
    });
    globalThis.dispatchEvent(event);
    await Promise.all(pending);
  }, data);
  const grant = { workspacePublicId: 'workspace', subscriptionPublicId: 'subscription' };
  const reminder = { version: 1, kind: 'klaxon.reminder', ...grant, reminderPublicId: 'reminder', occurrencePublicId: 'occurrence',
    reminderRevision: 2, attemptPublicId: 'try-one', dueAt: 1_800_000_000_000, title: 'Klaxon reminder' };
  await send(reminder);
  await page.evaluate(device => globalThis.push.configurePushDevice(device), grant);
  await send({ ...reminder, workspacePublicId: 'wrong-workspace' });
  await send({ ...reminder, url: 'https://unrelated.example' });
  await send({ ...reminder, title: 'Private title' });
  await Promise.all([send(reminder), send(reminder), send({ ...reminder, attemptPublicId: 'try-two' })]);
  const batch = await page.evaluate(() => globalThis.push.readPushReceipts());
  assert.equal(batch.workspacePublicId, grant.workspacePublicId);
  assert.equal(batch.subscriptionPublicId, grant.subscriptionPublicId);
  assert.deepEqual(batch.receipts.map(({ receivedAt, ...receipt }) => {
    assert.ok(Number.isSafeInteger(receivedAt));
    return receipt;
  }), ['try-one', 'try-two'].map(attemptPublicId => ({
    reminderPublicId: 'reminder', occurrencePublicId: 'occurrence', reminderRevision: 2, attemptPublicId,
  })));
  const notices = await worker.evaluate(() => globalThis.fixture.notices);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Klaxon reminder');
  assert.equal(notices[0].options.body, undefined);
  const click = () => worker.evaluate(async () => {
    const pending = [];
    const event = new globalThis.Event('notificationclick');
    Object.defineProperties(event, {
      notification: { value: { close() {}, data: { kind: 'klaxon.reminder', url: 'https://unrelated.example' } } },
      waitUntil: { value: promise => pending.push(promise) },
    });
    globalThis.dispatchEvent(event);
    await Promise.all(pending);
    return { opened: globalThis.fixture.opened, posted: globalThis.fixture.posted };
  });
  const firstClick = await click();
  assert.deepEqual(firstClick, { opened: [deployment.url + '#/reminders'], posted: [] });
  await worker.evaluate(url => globalThis.fixture.offerWindow(url), deployment.url + '#/inbox');
  assert.deepEqual(await click(), {
    opened: firstClick.opened,
    posted: [{ type: 'KLAXON_OPEN_REMINDERS', route: '#/reminders' }, 'focused'],
  });

  await page.evaluate(() => globalThis.push.clearPushReceipts(['try-one']));
  const remaining = await page.evaluate(() => globalThis.push.readPushReceipts());
  assert.deepEqual(remaining.receipts.map(receipt => receipt.attemptPublicId), ['try-two']);
  await send(reminder);
  assert.equal(await worker.evaluate(() => globalThis.fixture.notices.length), 1);
  await page.evaluate(() => globalThis.push.resetPushDevice());
  assert.equal(await page.evaluate(() => globalThis.push.readPushReceipts()), null);
});
