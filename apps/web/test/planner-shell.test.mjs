import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://planner-shell.test';
const appPath = '/klaxon/';
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(webRoot, '.verification-planner-shell-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), `<!doctype html><html lang="en"><head>
        <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Planner shell</title><style>body { margin: 0 }</style></head>
        <body><div id="app"></div><script type="module" src="./main.js"></script></body></html>`),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import PlannerShell from '../src/planner-shell/PlannerShell.svelte';
        const destinations = ['settings', 'calendar', 'waiting', 'inbox', 'today', 'capture'].map(id => ({
          id, href: '?route=' + id,
        }));
        const params = new URLSearchParams(location.search);
        let active = $state(params.get('route') ?? 'today');
        let showDetail = $state(false);
        let allowNavigation = $state(true);
        function navigate(destination) {
          if (!allowNavigation || active === destination.id) return;
          history.pushState(null, '', destination.href);
          active = destination.id;
          showDetail = false;
        }
      </script>
      <PlannerShell {destinations} {active} routeKey={showDetail ? active + '/detail' : active}
        onNavigate={params.has('native') ? undefined : navigate} detail={showDetail ? detail : undefined}>
        {#snippet status()}<output aria-label="Sync">Offline</output>{/snippet}
        <h1>{active}</h1>
        <button onclick={() => showDetail = true}>Open task</button>
        <label><input type="checkbox" bind:checked={allowNavigation}> Allow navigation</label>
        <div style="height: 130vh"></div>
        <button>End of view</button>
      </PlannerShell>
      {#snippet detail()}<button onclick={() => showDetail = false}>Close task</button>{/snippet}`),
    ]);
    const result = await build({
      root: scratch, base: './', configFile: false, plugins: [svelte()], logLevel: 'silent',
      build: { write: false, modulePreload: false },
    });
    assets = new Map(result.output.map(file => [posix.join(appPath, file.fileName), file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function open(t, { width = 1200, colorScheme = 'light', query = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 720 }, colorScheme });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === appPath ? `${appPath}index.html` : url.pathname;
    const body = assets.get(path);
    if (url.origin !== origin || body === undefined) return route.abort();
    const contentType = path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html';
    await route.fulfill({ body, contentType });
  });
  const page = await context.newPage();
  await page.goto(`${origin}${appPath}${query}`);
  return page;
}

test('desktop links show supplied routes in planner order and hand focus to accepted content', async t => {
  const page = await open(t);
  const main = page.getByRole('main');
  const navigation = page.getByRole('navigation', { name: 'Planner', exact: true });
  assert.deepEqual(await navigation.getByRole('link').allTextContents(), ['Today', 'Inbox', 'Calendar', 'Waiting']);
  assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).count(), 1);
  assert.equal(await page.getByRole('link', { name: 'Projects', exact: true }).count(), 0);
  assert.equal(await page.getByRole('status', { name: 'Sync' }).textContent(), 'Offline');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'Skip to content');
  await page.keyboard.press('Enter');
  assert.equal(await main.evaluate(element => globalThis.document.activeElement === element), true);
  const inbox = navigation.getByRole('link', { name: 'Inbox', exact: true });
  await page.getByRole('checkbox', { name: 'Allow navigation' }).uncheck();
  await inbox.press('Enter');
  assert.equal(await inbox.evaluate(element => globalThis.document.activeElement === element), true);
  assert.equal(await navigation.getByRole('link', { name: 'Today', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByRole('checkbox', { name: 'Allow navigation' }).check();
  await inbox.press('Enter');
  assert.match(page.url(), /\?route=inbox$/);
  assert.equal(await inbox.getAttribute('aria-current'), 'page');
  assert.equal(await main.evaluate(element => globalThis.document.activeElement === element), true);
  await page.getByRole('button', { name: 'Open task' }).click();
  const detail = page.getByRole('region', { name: 'Task details' });
  assert.equal(await detail.evaluate(element => globalThis.document.activeElement === element), true);
  const [headingBox, detailBox] = await Promise.all([main.getByRole('heading').boundingBox(), detail.boundingBox()]);
  assert.ok(detailBox.x >= headingBox.x + headingBox.width - 1);
  await detail.getByRole('button', { name: 'Close task' }).click();
  assert.equal(await main.evaluate(element => globalThis.document.activeElement === element), true);
});

test('mobile keeps supplied bottom links in reach and exposes remaining routes through More', async t => {
  const page = await open(t, { width: 320 });
  const navigation = page.getByRole('navigation', { name: 'Planner', exact: true });
  assert.deepEqual(await navigation.getByRole('link').allTextContents(), ['Today', 'Inbox', 'Calendar', 'Capture']);
  for (const link of await navigation.getByRole('link').all()) {
    const box = await link.boundingBox();
    assert.ok(box.height >= 44 && box.y + box.height <= 720);
  }
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 320);
  await page.getByRole('checkbox', { name: 'Allow navigation' }).press('Tab');
  const end = page.getByRole('button', { name: 'End of view' });
  assert.equal(await end.evaluate(element => globalThis.document.activeElement === element), true);
  const [endBox, navBox] = await Promise.all([end.boundingBox(), navigation.boundingBox()]);
  assert.ok(endBox.y + endBox.height <= navBox.y);
  const more = page.getByText('More', { exact: true });
  const waiting = page.getByRole('link', { name: 'Waiting', exact: true });
  assert.equal(await waiting.count(), 0);
  await more.press('Enter');
  assert.equal(await waiting.count(), 1);
  await waiting.press('Escape');
  assert.equal(await waiting.count(), 0);
  assert.equal(await more.evaluate(element => globalThis.document.activeElement === element), true);
  await more.press('Enter');
  await waiting.press('Enter');
  const main = page.getByRole('main');
  assert.match(page.url(), /\?route=waiting$/);
  assert.equal(await waiting.count(), 0);
  assert.equal(await main.evaluate(element => globalThis.document.activeElement === element), true);
  await more.press('Enter');
  assert.equal(await waiting.getAttribute('aria-current'), 'page');
  await more.press('Escape');
  await page.getByRole('button', { name: 'Open task' }).click();
  const detail = page.getByRole('region', { name: 'Task details' });
  assert.equal(await detail.isVisible(), true);
  assert.equal(await main.getByRole('heading').count(), 0);
  assert.equal(await detail.evaluate(element => globalThis.document.activeElement === element), true);
});

test('native links keep their supplied URL when the parent does not intercept navigation', async t => {
  const page = await open(t, { query: '?native' });
  await page.getByRole('link', { name: 'Calendar', exact: true }).click();
  assert.match(page.url(), /\/klaxon\/\?route=calendar$/);
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), 'calendar');
});

test('theme tracks system colors, persists the selected override, and can return to system', async t => {
  const page = await open(t, { colorScheme: 'dark' });
  const theme = page.getByRole('combobox', { name: 'Theme' });
  const scheme = () => theme.evaluate(element => globalThis.getComputedStyle(element).colorScheme);
  const background = () => theme.evaluate(element => globalThis.getComputedStyle(element).backgroundColor);
  assert.equal(await theme.inputValue(), 'system');
  assert.equal(await scheme(), 'dark');
  const darkBackground = await background();
  await theme.selectOption('light');
  assert.equal(await scheme(), 'light');
  const lightBackground = await background();
  assert.notEqual(lightBackground, darkBackground);
  await page.reload();
  assert.equal(await theme.inputValue(), 'light');
  assert.equal(await scheme(), 'light');
  assert.equal(await background(), lightBackground);
  await theme.selectOption('system');
  assert.equal(await scheme(), 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  assert.equal(await scheme(), 'light');
  await theme.selectOption('dark');
  assert.equal(await scheme(), 'dark');
  assert.equal(await background(), darkBackground);
});
