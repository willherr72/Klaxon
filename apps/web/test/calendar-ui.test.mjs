import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://calendar.test';
const root = '/klaxon/';
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(webRoot, '.verification-calendar-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar fixture</title></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>'),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        import '../src/planner-shell/planner-shell.css';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import { getFunctionName } from 'convex/server';
        import { ConvexError } from 'convex/values';
        import CalendarView from '../src/calendar/CalendarView.svelte';
        const mode = new URLSearchParams(location.search).get('mode');
        const at = Date.parse;
        const block = { publicId: 'block-1', revision: 4, localDate: '2026-03-08', timezone: 'America/Chicago',
          startAt: at('2026-03-08T14:00:00Z'), endAt: at('2026-03-08T15:00:00Z'), origin: 'manual', locked: false,
          taskId: 'task-record', taskPublicId: 'pump', taskTitle: 'Inspect pump', taskStatus: 'ready' };
        const meeting = { publicId: 'meeting', revision: 1, localDate: '2026-03-08', timezone: 'America/Chicago',
          startAt: at('2026-03-08T16:00:00Z'), endAt: at('2026-03-08T17:00:00Z'), title: 'Operations call',
          provider: 'outlook', availability: 'busy', allDay: false, connectionState: 'active', lastSeenAt: 1 };
        const task = { publicId: 'pump', title: 'Inspect pump', status: 'ready', revision: 2 };
        const otherTask = { publicId: 'report', title: 'Write report', status: 'inbox', revision: 1 };
        let preferences = { publicId: 'settings', revision: 3, timezone: 'America/Chicago', workHours: [
          { weekday: 6, startMinute: 540, endMinute: 1020 },
        ], breaks: [], bufferMinutes: 10, discretionaryMinutes: 60, lockManuallyMovedBlocks: true };
        let blocks = [block];
        let dayPlan = null;
        let previewNumber = 0;
        const reads = [], writes = [], opened = [];
        let expired = 0;
        let release;
        const subscriptions = new Set();
        let workspaceId = $state('workspace');
        let dirty = $state(false);
        function read(name, args) {
          if (name === 'planning:getPreferences') return preferences;
          if (name === 'planning:getDayPlan') return dayPlan;
          if (name === 'calendar:list') {
            const { localDate, view, timezone } = args;
            const startAt = localDate === '2026-03-08' && timezone === 'America/Chicago' ? at('2026-03-08T06:00:00Z')
              : localDate === '2026-11-01' && timezone === 'America/Chicago' ? at('2026-11-01T05:00:00Z') : at(localDate + 'T00:00:00Z');
            const endAt = localDate === '2026-03-08' && timezone === 'America/Chicago' && view === 'day'
              ? at('2026-03-09T05:00:00Z') : localDate === '2026-11-01' && timezone === 'America/Chicago' && view === 'day'
                ? at('2026-11-02T06:00:00Z') : startAt + (view === 'day' ? 1 : 7) * 86400000;
            return { localDate, timezone, startAt, endAt,
              blocks: args.workspaceId === 'workspace' ? blocks.filter(item => item.startAt < endAt && startAt < item.endAt) : [],
              events: args.workspaceId === 'workspace' && meeting.startAt < endAt && startAt < meeting.endAt ? [meeting] : [] };
          }
          if (name === 'tasks:list') return { page: args.filter.status === 'ready' ? [task]
            : args.filter.status === 'inbox' ? [otherTask] : [], isDone: true, continueCursor: '' };
          if (name === 'calendar:checkPlacement') {
            return { conflicts: args.startAt < meeting.endAt && meeting.startAt < args.endAt
              ? [{ kind: 'event', publicId: meeting.publicId, title: meeting.title, startAt: meeting.startAt, endAt: meeting.endAt }] : [] };
          }
          throw new Error('Unexpected query ' + name);
        }
        function publish(name) {
          for (const sub of subscriptions) if (sub.name === name) sub.callback(read(name, sub.args));
        }
        const client = {
          onUpdate(ref, args, callback) {
            const name = getFunctionName(ref);
            const sub = { name, args, callback };
            reads.push([name, args]);
            subscriptions.add(sub);
            queueMicrotask(() => { if (subscriptions.has(sub)) callback(read(name, args)); });
            return () => subscriptions.delete(sub);
          },
          async query(ref, args) {
            const name = getFunctionName(ref);
            reads.push([name, args]);
            return read(name, args);
          },
          async mutation(ref, args) {
            const name = getFunctionName(ref);
            writes.push([name, args]);
            if (name === 'calendar:apply') {
              const { command } = args;
              if (mode === 'workspace') {
                await new Promise((_, reject) => { release = reject; });
              }
              if (mode === 'retry' && writes.length === 2) {
                if (JSON.stringify(writes[0][1]) !== JSON.stringify(args)) throw new Error('Retry changed');
              } else if (command.kind === 'block.move') {
                blocks = blocks.map(item => item.publicId === command.publicId ? { ...item, startAt: command.startAt,
                  endAt: command.startAt + item.endAt - item.startAt, revision: item.revision + 1, locked: true } : item);
              } else if (command.kind === 'block.create') {
                blocks = [...blocks, { ...command, revision: 1, origin: 'manual', locked: false,
                  localDate: command.startAt > at('2026-11-01T00:00:00Z') ? '2026-11-01' : '2026-03-08',
                  taskTitle: command.taskPublicId === 'report' ? otherTask.title : undefined }];
              } else if (command.kind === 'block.resize') {
                blocks = blocks.map(item => item.publicId === command.publicId ? { ...item, ...command, revision: item.revision + 1 } : item);
              } else if (['block.lock', 'block.unlock', 'block.update', 'block.remove'].includes(command.kind)) {
                const current = blocks.find(item => item.publicId === command.publicId);
                if (!current || current.revision !== command.expectedRevision) throw new Error('Wrong block revision');
                blocks = blocks.flatMap(item => {
                  if (item !== current) return [item];
                  if (command.kind === 'block.remove') return [];
                  return [{ ...item, revision: item.revision + 1, ...(command.kind === 'block.update'
                    ? { title: command.title ?? undefined } : { locked: command.kind === 'block.lock' }) }];
                });
              } else throw new Error('Unexpected command ' + command.kind);
              publish('calendar:list');
              if (mode === 'retry' && writes.length === 1) throw new Error('Lost commit response');
            } else if (name === 'planning:updatePreferences') {
              preferences = { ...preferences, ...args.preferences, revision: preferences.revision + 1 };
              publish('planning:getPreferences');
            } else if (name === 'planning:preview') {
              previewNumber++;
              return { publicId: 'preview-' + previewNumber, revision: 1, localDate: args.localDate,
                timezone: preferences.timezone, expiresAt: Date.now() + 600000, baseDayPlanRevision: dayPlan?.revision ?? null,
                placements: [{ taskPublicId: 'pump', action: 'add', startAt: at('2026-03-08T17:00:00Z'), endAt: at('2026-03-08T18:00:00Z') }],
                unscheduled: [{ taskPublicId: 'report', reason: 'capacity', remainingMinutes: 30 }] };
            } else if (name === 'planning:apply') {
              if (mode === 'stale' && args.publicId === 'preview-1') {
                dayPlan = { publicId: 'plan-1', revision: 8, needsReplan: true };
                publish('planning:getDayPlan');
                throw new ConvexError({ code: 'PLAN_CONTEXT_CHANGED', currentRevision: 8 });
              }
              dayPlan = { publicId: 'plan-1', revision: 9, needsReplan: false };
              publish('planning:getDayPlan');
            } else throw new Error('Unexpected mutation ' + name);
            return { workspacePublicId: 'personal', targetPublicId: 'result', activityEventId: 'activity', revision: 5 };
          },
        };
        globalThis.fixture = { reads, writes, opened, expired: () => expired,
          switchWorkspace: () => workspaceId = 'other-workspace',
          rejectOldWrite: () => release(new ConvexError('UNAUTHENTICATED')) };
      </script>
      <main class="planner-shell">
        <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
        <CalendarView {client} {workspaceId} onDirtyChange={value => dirty = value}
          onOpenTask={(event, id) => { event.preventDefault(); opened.push(id); }} onUnauthenticated={() => expired++} />
      </main>`),
    ]);
    const result = await build({ root: scratch, base: './', configFile: false, plugins: [svelte()], logLevel: 'silent',
      build: { write: false, modulePreload: false } });
    assets = new Map(result.output.map(file => [posix.join(root, file.fileName), file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function open(t, mode = '', viewport = { width: 1100, height: 900 }) {
  const context = await browser.newContext({ viewport, timezoneId: 'America/Los_Angeles' });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === root ? `${root}index.html` : url.pathname;
    const body = assets.get(path);
    if (url.origin !== origin || body === undefined) return route.abort();
    await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  await page.clock.setFixedTime(new Date(mode === 'fold' ? '2026-11-01T06:00:00Z' : '2026-03-08T07:00:00Z'));
  await page.goto(`${origin}${root}?mode=${mode}`);
  return page;
}

const writes = page => page.evaluate(() => globalThis.fixture.writes);
const reads = page => page.evaluate(() => globalThis.fixture.reads);
const button = (page, name) => page.getByRole('button', { name, exact: true });

test('opens the local day and navigates a Monday-based week without viewport overflow', async t => {
  const page = await open(t, '', { width: 320, height: 720 });
  await page.getByText('Operations call', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Calendar date').inputValue(), '2026-03-08');
  await page.getByRole('link', { name: 'Inspect pump', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.opened), ['pump']);
  await button(page, 'Week').click();
  await page.getByRole('heading', { name: 'Monday, March 2' }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 320);
  await button(page, 'Next period').click();
  await page.getByRole('heading', { name: 'Monday, March 9' }).waitFor();
  assert.ok((await reads(page)).some(([name, args]) => name === 'calendar:list' && args.view === 'week'
    && args.localDate === '2026-03-02' && args.timezone === 'America/Chicago'));
});

test('keyboard move rejects a busy slot and retries an ambiguous write with the same operation and revision', async t => {
  const page = await open(t, 'retry');
  await button(page, 'Edit block: Inspect pump').press('Enter');
  const start = page.getByLabel('Start');
  const panel = page.getByRole('form', { name: 'Edit time block' });
  await start.fill('2026-03-08T02:30');
  await panel.getByLabel('End').fill('2026-03-08T03:30');
  await button(page, 'Review placement').press('Enter');
  await page.getByRole('alert').filter({ hasText: 'Local times can be skipped' }).waitFor();
  assert.deepEqual(await writes(page), []);
  await start.fill('2026-03-08T11:00');
  await panel.getByLabel('End').fill('2026-03-08T12:00');
  await button(page, 'Review placement').press('Enter');
  await panel.getByText('Operations call', { exact: true }).waitFor();
  assert.deepEqual(await writes(page), []);
  await start.fill('2026-03-08T12:00');
  await panel.getByLabel('End').fill('2026-03-08T13:00');
  await button(page, 'Review placement').press('Enter');
  await button(page, 'Save placement').press('Enter');
  await page.getByText(/Could not confirm/).waitFor();
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Dirty');
  await button(page, 'Retry change').press('Enter');
  await page.getByText('Time block saved.', { exact: true }).waitFor();
  const [first, retry] = await writes(page);
  assert.deepEqual(retry, first);
  assert.deepEqual(first[1].command, { kind: 'block.move', publicId: 'block-1', expectedRevision: 4,
    startAt: Date.parse('2026-03-08T17:00:00Z'), timezone: 'America/Chicago' });
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Clean');
});

test('a task drop and a resize both require placement review', async t => {
  const page = await open(t);
  const timeline = page.getByLabel('Timeline for Sunday, March 8');
  const task = page.getByText('Write report', { exact: true });
  await task.dragTo(timeline, { targetPosition: { x: 110, y: 144 } });
  const form = page.getByRole('form', { name: 'New time block' });
  await form.getByText('Write report', { exact: true }).waitFor();
  assert.equal(await form.getByLabel('Start').inputValue(), '2026-03-08T04:00');
  assert.deepEqual(await writes(page), []);
  await button(page, 'Review placement').click();
  await button(page, 'Save placement').click();
  await page.getByText('Time block saved.', { exact: true }).waitFor();
  await page.getByLabel('Drag to resize Inspect pump').dragTo(timeline, { targetPosition: { x: 110, y: 444 } });
  await page.getByRole('form', { name: 'Edit time block' }).waitFor();
  assert.equal((await writes(page)).length, 1);
  await button(page, 'Review placement').click();
  await button(page, 'Save placement').click();
  await page.waitForFunction(() => globalThis.fixture.writes.length === 2);
  const [create, resize] = await writes(page);
  assert.equal(create[1].command.taskPublicId, 'report');
  assert.deepEqual(resize[1].command, { kind: 'block.resize', publicId: 'block-1', expectedRevision: 4,
    startAt: Date.parse('2026-03-08T14:00:00Z'), endAt: Date.parse('2026-03-08T15:15:00Z'), timezone: 'America/Chicago' });
});

test('saves scheduling preferences with the read revision and reloads the calendar in the saved zone', async t => {
  const page = await open(t);
  await button(page, 'Scheduling preferences').click();
  await page.getByLabel('Time zone').fill('America/New_York');
  await page.getByLabel('Buffer (minutes)').fill('15');
  await page.getByLabel('Lock manually moved blocks').uncheck();
  await button(page, 'Add break').click();
  const breakRow = page.getByRole('group', { name: 'Break 1', exact: true });
  await breakRow.getByLabel('Day').selectOption('6');
  await breakRow.getByLabel('Start').fill('23:30');
  await breakRow.getByLabel('End').fill('24:00');
  await button(page, 'Save preferences').click();
  await page.getByText('Scheduling preferences saved.', { exact: true }).waitFor();
  const [[name, args]] = await writes(page);
  assert.equal(name, 'planning:updatePreferences');
  assert.equal(args.expectedRevision, 3);
  assert.deepEqual(args.preferences, { timezone: 'America/New_York', workHours: [{ weekday: 6, startMinute: 540, endMinute: 1020 }],
    breaks: [{ weekday: 6, startMinute: 1410, endMinute: 1440 }], bufferMinutes: 15, discretionaryMinutes: 60, lockManuallyMovedBlocks: false });
  await page.waitForFunction(() => globalThis.fixture.reads.some(([name, args]) => name === 'calendar:list' && args.timezone === 'America/New_York'));
});

test('reviews proposed and unscheduled work, then requires a fresh preview after a context conflict', async t => {
  const page = await open(t, 'stale');
  await page.getByRole('checkbox', { name: 'Include Inspect pump in plan' }).check();
  await page.getByRole('checkbox', { name: 'Include Write report in plan' }).check();
  await button(page, 'Preview day plan').click();
  const review = page.getByRole('region', { name: 'Review day plan' });
  await review.getByText(/Add.*Inspect pump/).waitFor();
  await review.getByText(/Write report.*capacity.*30 min/).waitFor();
  assert.deepEqual((await writes(page)).map(([name]) => name), ['planning:preview']);
  await button(page, 'Apply plan').press('Enter');
  await page.getByText(/Calendar or task context changed/).waitFor();
  assert.equal(await button(page, 'Apply plan').count(), 0);
  await button(page, 'Preview day plan').click();
  await review.getByText(/Add.*Inspect pump/).waitFor();
  await button(page, 'Apply plan').click();
  await page.getByText('Day plan applied.', { exact: true }).waitFor();
  const [first, stale, second, applied] = await writes(page);
  assert.equal(first[1].expectedDayPlanRevision, null);
  assert.equal(second[1].expectedDayPlanRevision, 8);
  assert.notEqual(second[1].operationId, first[1].operationId);
  assert.equal(stale[1].publicId, 'preview-1');
  assert.equal(applied[1].publicId, 'preview-2');
  assert.equal(applied[1].expectedRevision, 1);
});

test('a late rejected mutation from a prior workspace cannot expire or dirty the current one', async t => {
  const page = await open(t, 'workspace');
  await button(page, 'Edit block: Inspect pump').click();
  await page.getByLabel('Start', { exact: true }).fill('2026-03-08T12:00');
  await page.getByLabel('End', { exact: true }).fill('2026-03-08T13:00');
  await button(page, 'Review placement').click();
  await button(page, 'Save placement').click();
  await page.waitForFunction(() => globalThis.fixture.writes.length === 1);
  await page.evaluate(() => globalThis.fixture.switchWorkspace());
  await page.getByText('No blocks or events.', { exact: true }).waitFor();
  await page.evaluate(() => globalThis.fixture.rejectOldWrite());
  assert.equal(await page.evaluate(() => globalThis.fixture.expired()), 0);
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Clean');
  assert.equal(await button(page, 'Retry change').count(), 0);
});

test('keyboard scheduling can choose the second occurrence when clocks turn back', async t => {
  const page = await open(t, 'fold');
  await button(page, 'New time block').click();
  const form = page.getByRole('form', { name: 'New time block' });
  await form.getByLabel('Block title').fill('Second Sunday round');
  await form.getByLabel('Start', { exact: true }).fill('2026-11-01T01:15');
  await form.getByLabel('End', { exact: true }).fill('2026-11-01T01:45');
  await form.getByLabel('Start occurrence').selectOption({ label: 'Second · 1:15 AM CST' });
  await form.getByLabel('End occurrence').selectOption({ label: 'Second · 1:45 AM CST' });
  await button(page, 'Review placement').press('Enter');
  await button(page, 'Save placement').press('Enter');
  await page.getByText('Time block saved.', { exact: true }).waitFor();
  const [[, { command }]] = await writes(page);
  assert.equal(command.title, 'Second Sunday round');
  assert.equal(command.startAt, Date.parse('2026-11-01T07:15:00Z'));
  assert.equal(command.endAt, Date.parse('2026-11-01T07:45:00Z'));
});

test('a locked block cannot be repositioned and removal requires confirmation', async t => {
  const page = await open(t);
  await button(page, 'Edit block: Inspect pump').click();
  await button(page, 'Lock block').press('Enter');
  await page.getByText('Locked', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Drag to resize Inspect pump').count(), 0);
  await button(page, 'Edit block: Inspect pump').press('Enter');
  assert.equal(await page.getByLabel('Start', { exact: true }).isDisabled(), true);
  await button(page, 'Unlock block').press('Enter');
  await button(page, 'Edit block: Inspect pump').press('Enter');
  await page.getByLabel('Block title').fill('Weekly inspection');
  await button(page, 'Save title').press('Enter');
  await button(page, 'Edit block: Weekly inspection').press('Enter');
  await button(page, 'Remove block').press('Enter');
  assert.equal((await writes(page)).length, 3);
  await button(page, 'Confirm removal').press('Enter');
  await page.getByText('Time block removed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Weekly inspection' }).count(), 0);
  assert.deepEqual((await writes(page)).map(([, { command }]) => [command.kind, command.expectedRevision]),
    [['block.lock', 4], ['block.unlock', 5], ['block.update', 6], ['block.remove', 7]]);
});
