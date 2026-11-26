import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const origin = 'https://reminders.test';
const root = '/klaxon/';
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(fileURLToPath(new URL('..', import.meta.url)), '.verification-reminders-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="manifest" data-klaxon-pwa href="manifest.webmanifest"><title>Reminders fixture</title></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>'),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import { getFunctionName } from 'convex/server';
        import { ConvexError } from 'convex/values';
        import RemindersView from '../src/reminders/RemindersView.svelte';
        import { clearReminderPushDevice, reconcileReminderPushBinding } from '../src/reminders/push-device';
        import { configurePushDevice } from '../src/pwa/push-client';
        const params = new URLSearchParams(location.search);
        const mode = params.get('mode');
        const at = Date.parse('2026-02-12T16:00:00Z');
        const occurrence = { publicId: 'occ-1', reminderPublicId: 'rem-1', reminderTitle: 'Check pressure',
          reminderRevision: 4, dueAt: at, triggerAt: at, timezone: 'America/Chicago', state: 'pending', deliveryState: 'not_requested' };
        let reminder = { publicId: 'rem-1', title: 'Check pressure', revision: 4, priority: 'normal', taskPublicId: 'pump',
          dueAt: at, timezone: 'America/Chicago', state: 'pending', dormant: true, overdue: true, occurrence };
        const registered = ['push-cold', 'push-mismatch', 'push-cleanup-error', 'push-hung'].includes(mode);
        let grant = { available: mode?.startsWith('push'), enabled: mode?.startsWith('push'), grantRevision: 3,
          publicKey: 'BA', device: registered ? { publicId: 'sub-1', revision: 1, active: true, permission: 'granted' } : null };
        let attempt = { publicId: 'attempt-1', deviceId: 'fixture-device', channel: 'web_push', occurrencePublicId: 'occ-1',
          status: 'accepted_by_provider', createdAt: at, acceptedAt: at };
        const reads = [], writes = [], opened = [], push = [], subscriptions = [];
        let expired = 0;
        let dirty = $state(false);
        let workspaceId = $state('ws-1');
        let disabled = $state(false);
        let showReminders = $state(!registered);
        let browserSubscription;
        let permission = registered ? 'granted' : 'default';
        const simulatedSubscription = { toJSON: () => ({ endpoint: 'https://push.fixture/device', keys: { p256dh: 'public', auth: 'test' } }),
          async unsubscribe() { push.push('unsubscribe'); browserSubscription = undefined; return true; } };
        if (registered) browserSubscription = simulatedSubscription;
        const receipt = { reminderPublicId: 'rem-1', occurrencePublicId: 'occ-1', reminderRevision: 4,
          attemptPublicId: 'attempt-1', receivedAt: at };
        const results = (name, args) => {
          if (args.workspaceId !== 'ws-1') return name === 'reminders:due' ? { items: [], partial: false } : { page: [], isDone: true };
          if (name === 'reminders:list') return { page: reminder ? [reminder] : [], isDone: true };
          if (name === 'reminders:due') return { items: reminder ? [reminder] : [], partial: false };
          if (name === 'reminders:get') return reminder;
          if (name === 'reminders:history') return { page: [occurrence], isDone: true };
          if (name === 'delivery:history') return { page: [attempt], isDone: true };
          if (name === 'delivery:status') return grant;
          if (name === 'tasks:get') return { title: 'Inspect pump', publicId: 'pump', status: 'ready' };
          if (name === 'organization:search') return { tasks: [{ title: 'Inspect pump', publicId: 'pump', status: 'ready' }] };
          throw new Error('Unexpected query ' + name);
        };
        const publish = () => subscriptions.slice().forEach(({ name, args, receive }) => receive(results(name, args)));
        let settle;
        let lateStatus;
        const client = {
          onUpdate(reference, args, receive) {
            const name = getFunctionName(reference);
            const entry = { name, args, receive };
            reads.push([name, args]);
            subscriptions.push(entry);
            receive(results(name, args));
            return () => subscriptions.splice(subscriptions.indexOf(entry), 1);
          },
          async query(reference, args) {
            const name = getFunctionName(reference);
            reads.push([name, args]);
            if (name === 'delivery:status' && mode === 'push-hung') {
              return new Promise(resolve => lateStatus = () => resolve(results(name, args)));
            }
            return results(name, args);
          },
          async mutation(reference, args) {
            const name = getFunctionName(reference);
            writes.push([name, args]);
            if (mode === 'workspace') return new Promise((_, reject) => settle = reject);
            if (mode === 'retry' && writes.length === 1) throw new Error('Lost commit response');
            if (mode === 'conflict' && writes.length === 1) {
              reminder = { ...reminder, revision: 5, description: 'Updated on another device' };
              publish();
              throw new ConvexError({ code: 'REVISION_CONFLICT', currentRevision: 5 });
            }
            if (name === 'reminders:remove') reminder = null;
            if (name === 'reminders:activate') reminder = { ...reminder, revision: 5, dormant: false };
            if (name === 'delivery:register') grant = { ...grant, device: { publicId: 'sub-1', revision: 1, active: true, permission } };
            if (name === 'delivery:revoke') grant = { ...grant, device: { ...grant.device, revision: 2, active: false } };
            if (name === 'delivery:acknowledge') {
              if (mode === 'push-retry' && writes.filter(([method]) => method === name).length === 1) throw Error('Unavailable');
              attempt = { ...attempt, status: 'acknowledged', acknowledgedAt: at };
              publish();
              return { acknowledgedAt: at };
            }
            publish();
            return { targetPublicId: name === 'delivery:register' ? 'sub-1' : 'rem-1', revision: 1 };
          },
        };
        if (mode?.startsWith('push')) {
          Object.defineProperty(window, 'Notification', { configurable: true, value: {
            get permission() { return permission; },
            async requestPermission() { push.push('prompt'); permission = mode === 'push-denied' ? 'denied' : 'granted'; return permission; },
          } });
          const registration = { scope: location.origin + '/klaxon/', active: { scriptURL: location.origin + '/klaxon/pwa-sw.js' }, pushManager: {
            async getSubscription() { return browserSubscription; },
            async subscribe(args) {
              push.push(['subscribe', args.userVisibleOnly, Array.from(new Uint8Array(args.applicationServerKey))]);
              browserSubscription = simulatedSubscription;
              return browserSubscription;
            },
          } };
          Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
            ready: Promise.resolve(registration), getRegistration: async () => registration,
            addEventListener() {}, removeEventListener() {},
          } });
        }
        globalThis.fixture = { reads, writes, opened, push, expired: () => expired,
          scope: () => workspaceId, switchWorkspace: () => workspaceId = 'ws-2', disable: () => disabled = true,
          rejectOldWrite: () => settle(new ConvexError('UNAUTHENTICATED')),
          signOut: (authenticated = true) => clearReminderPushDevice(client, workspaceId, 'personal', authenticated),
          resumeWorkspace: () => reconcileReminderPushBinding(client, workspaceId), showReminders: () => showReminders = true,
          statusWaiting: () => Boolean(lateStatus), releaseLateStatus: () => lateStatus(),
          renewWorkerBinding: () => configurePushDevice({ workspacePublicId: 'personal', subscriptionPublicId: 'sub-1' }),
          resetFailure: mode === 'push-cleanup-error', workerReceipts: [] };
        globalThis.fixture.injectReceipt = () => globalThis.fixture.workerReceipts.push(receipt);
        if (registered) void configurePushDevice({ workspacePublicId: 'personal', subscriptionPublicId: mode === 'push-mismatch' ? 'other-account' : 'sub-1' });
      </script>
      <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
      {#if showReminders}
        <RemindersView {client} {workspaceId} workspacePublicId={workspaceId === 'ws-1' ? 'personal' : 'other'} {disabled}
          onOpenTask={id => opened.push(id)} onDirtyChange={value => dirty = value} onUnauthenticated={() => expired++} />
      {/if}`),
    ]);
    const pushFixture = `let binding;
      export const configurePushDevice = async config => { binding = config; globalThis.fixture.push.push(['configure', config]); };
      export const readPushReceipts = async () => binding ? { ...binding, receipts: [...globalThis.fixture.workerReceipts] } : null;
      export const clearPushReceipts = async ids => {
        globalThis.fixture.push.push(['clear', ids]);
        globalThis.fixture.workerReceipts = globalThis.fixture.workerReceipts.filter(item => !ids.includes(item.attemptPublicId));
      };
      export const resetPushDevice = async () => {
        globalThis.fixture.push.push('reset');
        if (globalThis.fixture.resetFailure) throw Error('Worker reset failed');
        binding = undefined;
        globalThis.fixture.workerReceipts = [];
      };`;
    const result = await build({ root: scratch, base: './', configFile: false, logLevel: 'silent', plugins: [svelte(), {
      name: 'synthetic-push-transport',
      enforce: 'pre',
      resolveId: id => id.endsWith('/pwa/push-client') ? '\0push-fixture' : undefined,
      load: id => id === '\0push-fixture' ? pushFixture : undefined,
    }], build: { write: false, modulePreload: false } });
    assets = new Map(result.output.map(file => [posix.join(root, file.fileName), file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function open(t, mode = '') {
  const context = await browser.newContext({ viewport: { width: 320, height: 800 }, timezoneId: 'America/Los_Angeles' });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === root ? `${root}index.html` : url.pathname;
    const body = assets.get(path);
    if (url.origin !== origin || body === undefined) return route.abort();
    await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const page = await context.newPage();
  if (['push-cold', 'push-mismatch', 'push-cleanup-error', 'push-hung'].includes(mode)) {
    await page.addInitScript(() => globalThis.localStorage.setItem('klaxon:web-push-device:v1', 'fixture-device'));
  }
  page.setDefaultTimeout(3000);
  const now = new Date('2026-03-08T15:00:00Z');
  if (mode === 'push-hung') await page.clock.install({ time: now });
  else await page.clock.setFixedTime(now);
  await page.goto(`${origin}${root}?mode=${mode}`);
  return page;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const writes = page => page.evaluate(() => globalThis.fixture.writes);
const pushEvents = page => page.evaluate(() => globalThis.fixture.push);

test('creates a task-linked recurrence in the chosen zone and retries an identical write', async t => {
  const page = await open(t, 'retry');
  await button(page, 'New reminder').click();
  const form = page.getByRole('form', { name: 'New reminder' });
  await form.getByLabel('Title').fill('Weekly inspection');
  await form.getByLabel('Time zone').fill('America/Chicago');
  await form.getByLabel('Due date and time').fill('2026-03-08T02:30');
  await form.getByLabel('Repeat').selectOption('weekly');
  await form.getByLabel('Monday').check();
  await form.getByLabel('Find a task').fill('pump');
  await button(form, 'Inspect pump').click();
  await button(form, 'Save reminder').click();
  await page.getByRole('alert').filter({ hasText: /local time/i }).waitFor();
  assert.deepEqual(await writes(page), []);
  await form.getByLabel('Due date and time').fill('2026-03-08T10:30');
  await button(form, 'Save reminder').click();
  await button(page, 'Retry reminder change').click();
  await page.getByText('Reminder created.', { exact: true }).waitFor();
  const [first, retry] = await writes(page);
  assert.deepEqual(retry, first);
  assert.equal(first[0], 'reminders:create');
  assert.deepEqual(first[1].reminder, { title: 'Weekly inspection', dueAt: Date.parse('2026-03-08T15:30:00Z'),
    timezone: 'America/Chicago', taskPublicId: 'pump', recurrence: { kind: 'weekly', weekdays: [0] } });
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Clean');
});

test('distinguishes overdue dormant items and confirms a revision-scoped removal', async t => {
  const page = await open(t);
  await button(page, 'Due').click();
  await page.getByText('Dormant', { exact: true }).waitFor();
  await page.getByText('Overdue', { exact: true }).waitFor();
  await button(page, 'Open linked task').click();
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.opened), ['pump']);
  await button(page, 'Check pressure').click();
  await button(page, 'Remove reminder').click();
  assert.deepEqual(await writes(page), []);
  await button(page, 'Confirm removal').click();
  await page.getByText('Reminder removed.', { exact: true }).waitFor();
  const [[name, args]] = await writes(page);
  assert.equal(name, 'reminders:remove');
  assert.equal(args.publicId, 'rem-1');
  assert.equal(args.expectedRevision, 4);
});

test('an edit conflict requires review before sending a new operation at the latest revision', async t => {
  const page = await open(t, 'conflict');
  await button(page, 'Check pressure').click();
  await button(page, 'Edit reminder').click();
  const form = page.getByRole('form', { name: 'Edit reminder' });
  await form.getByLabel('Title').fill('Inspect system pressure');
  await button(form, 'Save reminder').click();
  await button(page, 'Review latest reminder').click();
  assert.equal(await form.getByLabel('Description').inputValue(), 'Updated on another device');
  await button(form, 'Save reminder').click();
  await page.getByText('Reminder updated.', { exact: true }).waitFor();
  const [first, second] = await writes(page);
  assert.notEqual(first[1].operationId, second[1].operationId);
  assert.equal(second[1].expectedRevision, 5);
  assert.deepEqual(second[1].patch, { title: 'Inspect system pressure' });
});

test('a late auth failure from a previous workspace cannot expire the active workspace', async t => {
  const page = await open(t, 'workspace');
  await button(page, 'Check pressure').click();
  await button(page, 'Remove reminder').click();
  await button(page, 'Confirm removal').click();
  await page.evaluate(() => globalThis.fixture.switchWorkspace());
  await page.getByText('No reminders yet.', { exact: true }).waitFor();
  await page.evaluate(() => globalThis.fixture.rejectOldWrite());
  assert.equal(await page.evaluate(() => globalThis.fixture.expired()), 0);
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Clean');
});

test('push registration requests permission on click, retries worker receipts, and revokes only this device at sign-out', async t => {
  const page = await open(t, 'push-retry');
  await button(page, 'Delivery settings').click();
  const enroll = button(page, 'Enable on this browser');
  await enroll.waitFor();
  await button(page, 'Delivery history').click();
  await page.getByText('Accepted by push provider', { exact: true }).waitFor();
  assert.equal(await page.getByText('Browser reported display', { exact: true }).count(), 0);
  assert.deepEqual(await pushEvents(page), []);
  await enroll.click();
  try { await page.getByText('This browser is enrolled.', { exact: true }).waitFor(); }
  catch (error) {
    t.diagnostic(await page.locator('body').innerText());
    t.diagnostic(JSON.stringify({ writes: await writes(page), push: await pushEvents(page) }));
    throw error;
  }
  assert.deepEqual(await pushEvents(page), ['prompt', ['subscribe', true, [4]], ['configure', { workspacePublicId: 'personal', subscriptionPublicId: 'sub-1' }]]);
  await page.evaluate(() => { globalThis.fixture.injectReceipt(); globalThis.dispatchEvent(new Event('focus')); });
  await page.waitForFunction(() => globalThis.fixture.writes.some(([name]) => name === 'delivery:acknowledge'));
  assert.ok(!(await pushEvents(page)).some(event => event[0] === 'clear'));
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => globalThis.fixture.push.some(event => event[0] === 'clear'));
  await page.getByText('Browser reported display', { exact: true }).waitFor();
  const [[register, enrolled], [acknowledge, receipt], [, retry]] = await writes(page);
  assert.equal(register, 'delivery:register');
  assert.equal(enrolled.expectedRevision, 0);
  assert.equal(acknowledge, 'delivery:acknowledge');
  assert.deepEqual(receipt, { workspaceId: 'ws-1', deviceId: enrolled.deviceId, attemptPublicId: 'attempt-1' });
  assert.deepEqual(retry, receipt);
  await page.evaluate(() => globalThis.fixture.signOut());
  const [revoke, revoked] = (await writes(page)).at(-1);
  assert.equal(revoke, 'delivery:revoke');
  assert.equal(revoked.deviceId, enrolled.deviceId);
  assert.equal(revoked.expectedRevision, 1);
  assert.deepEqual((await pushEvents(page)).slice(-2), ['reset', 'unsubscribe']);
});

test('records denied browser permission without creating a subscription', async t => {
  const page = await open(t, 'push-denied');
  await button(page, 'Delivery settings').click();
  await button(page, 'Enable on this browser').click();
  await page.getByText('Browser permission was not granted.', { exact: true }).waitFor();
  const [[name, args]] = await writes(page);
  assert.equal(name, 'delivery:setPermission');
  assert.equal(args.permission, 'denied');
  assert.equal(args.expectedRevision, 0);
  assert.deepEqual(await pushEvents(page), ['prompt']);
});

test('workspace startup records the device for expiry cleanup without opening Reminders', async t => {
  const page = await open(t, 'push-cold');
  assert.equal(await button(page, 'Delivery settings').count(), 0);
  await page.evaluate(() => globalThis.fixture.resumeWorkspace());
  assert.equal(await page.evaluate(() => globalThis.fixture.signOut(false)), true);
  assert.deepEqual((await pushEvents(page)).slice(-2), ['reset', 'unsubscribe']);
  assert.deepEqual(await writes(page), []);
});

test('sign-out preserves a worker binding for a different account in the same workspace', async t => {
  const page = await open(t, 'push-mismatch');
  await page.evaluate(() => globalThis.fixture.resumeWorkspace());
  assert.equal(await page.evaluate(() => globalThis.fixture.signOut()), true);
  assert.deepEqual(await pushEvents(page), [['configure', { workspacePublicId: 'personal', subscriptionPublicId: 'other-account' }]]);
  assert.equal((await writes(page)).at(-1)?.[0], 'delivery:revoke');
});

test('a failed worker reset is reported while browser unsubscribe and signed-in revocation still run', async t => {
  const page = await open(t, 'push-cleanup-error');
  await page.evaluate(() => globalThis.fixture.resumeWorkspace());
  assert.equal(await page.evaluate(() => globalThis.fixture.signOut()), false);
  assert.deepEqual((await pushEvents(page)).slice(-2), ['reset', 'unsubscribe']);
  assert.equal((await writes(page)).at(-1)?.[0], 'delivery:revoke');
});

test('sign-out cleanup times out a hung status query and fences its late result', async t => {
  const page = await open(t, 'push-hung');
  await page.evaluate(() => {
    void globalThis.fixture.signOut().then(result => { globalThis.fixture.cleanupResult = result; });
  });
  await page.waitForFunction(() => globalThis.fixture.statusWaiting());
  await page.clock.fastForward(10_000);
  await page.waitForFunction(() => globalThis.fixture.cleanupResult === false, undefined, { timeout: 4500 });
  await page.evaluate(() => globalThis.fixture.renewWorkerBinding());
  await page.evaluate(async () => {
    globalThis.fixture.releaseLateStatus();
    await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  });
  assert.equal((await pushEvents(page)).length, 2);
  assert.deepEqual(await writes(page), []);
});
