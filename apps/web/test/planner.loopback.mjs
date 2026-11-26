import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { chromium } from 'playwright-core';
import { withLocalProvider } from '../../backend/test/provider.local.mjs';

// The browser sees a canonical Development origin. Redirect only its Convex API and
// socket to the disposable provider. The real browser SDK and backend handle every frame.
const deployment = 'https://p2-local-fixture.convex.cloud';
const entry = 'https://planner.klaxon.test/fixture/';
const root = fileURLToPath(new URL('..', import.meta.url));
async function assets(output) {
  const build = spawnSync(
    process.execPath,
    [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'development', '--outDir', output],
    {
      cwd: root,
      env: { ...process.env, KLAXON_PUBLIC_DEV_ORIGIN: deployment },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );
  assert.equal(build.status, 0, build.stderr);
  const result = new Map();
  for (const file of await readdir(output, { withFileTypes: true, recursive: true })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    result.set(entry + relative(output, path).split(sep).join('/'), await readFile(path));
  }
  result.set(entry, result.get(entry + 'index.html'));
  return result;
}

async function pageFor(browser, site, url) {
  const context = await browser.newContext({ serviceWorkers: 'block', locale: 'en-US' });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (site.has(target.href)) {
      const type = target.pathname.endsWith('.js')
        ? 'text/javascript'
        : target.pathname.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      return route.fulfill({ contentType: type, body: site.get(target.href) });
    }
    if (target.origin !== deployment || target.pathname !== '/api/mutation' || request.method() !== 'POST')
      return route.abort();
    const response = await fetch(url + '/api/mutation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: request.postData(),
      redirect: 'error',
    });
    return route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
  await context.routeWebSocket('**/*', (route) => {
    const target = new URL(route.url());
    if (
      target.origin !== deployment.replace('https:', 'wss:') ||
      !/^\/api\/[^/]+\/sync$/.test(target.pathname)
    ) {
      route.close();
      return;
    }
    const socket = new WebSocket(url.replace('http:', 'ws:') + target.pathname);
    const queue = [];
    socket.onopen = () => {
      for (const frame of queue.splice(0)) socket.send(frame);
    };
    socket.onmessage = (event) => route.send(event.data);
    socket.onerror = () => route.close();
    socket.onclose = () => route.close();
    route.onMessage((frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
      else if (socket.readyState === WebSocket.CONNECTING) queue.push(frame);
    });
    route.onClose(() => socket.close());
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return page;
}

async function checkWeeklyReminder(writer, observer) {
  const first = new Date();
  first.setUTCDate(first.getUTCDate() + 7 - ((first.getUTCDay() + 6) % 7));
  first.setUTCHours(12, 0, 0, 0);
  const followingMonday = new Date(first);
  followingMonday.setUTCDate(first.getUTCDate() + 7);
  const title = 'Weekly fixture check';
  for (const page of [writer, observer]) {
    await page.getByRole('link', { name: 'Reminders', exact: true }).click();
    await page.getByRole('heading', { name: 'Reminders', exact: true }).waitFor();
  }
  await writer.getByRole('button', { name: 'New reminder' }).click();
  const form = writer.getByRole('form', { name: 'New reminder' });
  await form.getByLabel('Title').fill(title);
  await form.getByLabel('Time zone').fill('UTC');
  await form.getByLabel('Due date and time').fill(first.toISOString().slice(0, 16));
  await form.getByLabel('Repeat').selectOption('weekly');
  await form.getByLabel('Monday').check();
  await form.getByRole('button', { name: 'Save reminder' }).click();
  await writer.getByText('Reminder created.', { exact: true }).waitFor();
  await observer.getByRole('button', { name: title, exact: true }).click();
  await observer.getByRole('button', { name: 'Dismiss occurrence', exact: true }).click();
  await observer.getByRole('button', { name: 'Confirm dismissal', exact: true }).click();
  const nextDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    followingMonday,
  );
  await writer.getByText(nextDate, { exact: false }).first().waitFor();
  await observer.getByRole('button', { name: 'Complete reminder', exact: true }).click();
  await observer.getByRole('button', { name: 'Confirm completion', exact: true }).click();
  await writer.getByText('Completed', { exact: true }).first().waitFor();
}

test(
  'two browser planners share task edits, undo and a weekly reminder lifecycle on local Convex',
  { timeout: 240_000 },
  async () => {
    const output = await mkdtemp(join(root, '.verification-browser-'));
    try {
      const site = await assets(output);
      await withLocalProvider(async ({ url, adminKey }) => {
        const admin = new ConvexHttpClient(url, { logger: false });
        admin.setAdminAuth(adminKey);
        const username = 'p2-' + randomUUID();
        const password = randomBytes(24).toString('base64url');
        await admin.function('auth:enrollWithUsernamePassword', undefined, { username, password });
        const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
        try {
          const [writer, observer] = await Promise.all([
            pageFor(browser, site, url),
            pageFor(browser, site, url),
          ]);
          for (const [page, hash] of [
            [writer, 'capture'],
            [observer, 'inbox'],
          ]) {
            await page.goto(entry + '#/' + hash);
            await page.getByLabel('Username').fill(username);
            await page.getByLabel('Password').fill(password);
            await page.getByRole('button', { name: 'Sign in', exact: true }).click();
            await page
              .getByRole('heading', { name: hash === 'capture' ? 'Capture' : 'Inbox', exact: true })
              .waitFor();
          }
          await writer.getByLabel('Capture text').fill('Inspect the synthetic quote');
          await writer.getByRole('button', { name: 'Save capture' }).click();
          await observer.getByText('Inspect the synthetic quote', { exact: true }).waitFor();
          await observer.getByRole('button', { name: 'Promote to task' }).click();
          await observer.getByLabel('Promoted task title').fill('Review fixture estimate');
          await observer.getByRole('button', { name: 'Create task', exact: true }).click();
          await writer.getByRole('link', { name: 'Inbox', exact: true }).click();
          await writer.getByRole('link', { name: 'Review fixture estimate', exact: true }).click();
          const detail = writer.getByRole('region', { name: 'Task details' });
          await detail.getByLabel('Title', { exact: true }).fill('Review revised estimate');
          await detail.getByRole('button', { name: 'Save task', exact: true }).click();
          await observer.getByRole('link', { name: 'Review revised estimate', exact: true }).waitFor();
          await observer.getByRole('link', { name: 'Activity', exact: true }).click();
          await observer.getByRole('button', { name: 'Review undo' }).first().click();
          await observer.getByRole('button', { name: 'Confirm undo' }).click();
          await observer.getByText(/Change undone at revision/).waitFor();
          await writer.waitForFunction(
            () =>
              globalThis.document.querySelector('input[aria-label="Title"]')?.value ===
                'Review fixture estimate' ||
              [...globalThis.document.querySelectorAll('input')].some(
                (el) => el.value === 'Review fixture estimate',
              ),
          );
          await checkWeeklyReminder(writer, observer);
          await writer.reload();
          await writer.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
        } finally {
          await browser.close();
        }
      });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
);
