import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://task-detail.test';
const path = '/klaxon/';
const task = {
  _id: 'task-record', publicId: 'task-public', title: 'Inspect pump', status: 'ready', revision: 4,
  rank: 2, priority: 'none', plannedDate: '2026-12-01',
  deadline: { kind: 'instant', at: Date.parse('2026-12-04T18:30:45.123Z'), timezone: 'America/Chicago' },
  source: { kind: 'legacy', source: 'Old planner', externalId: 'PUMP-1' },
};
const project = { _id: 'project-record', name: 'Maintenance' };
const steps = [
  { publicId: 'step-1', title: 'Read gauge', rank: 0, completed: false, revision: 2 },
  { publicId: 'step-2', title: 'Check log', rank: 1, completed: false, revision: 3 },
];
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(webRoot, '.verification-task-detail-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task detail</title></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>'),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import { getFunctionName } from 'convex/server';
        import { ConvexError } from 'convex/values';
        import TaskDetail from '../src/task-detail/TaskDetail.svelte';
        let task = ${JSON.stringify(task)};
        let steps = ${JSON.stringify(steps)};
        let links = [
          { publicId: 'managed', revision: 2, relationship: 'managed_mirror', provider: 'github',
            canonicalUrl: 'https://github.example/issues/1', label: 'Managed issue' },
          { publicId: 'legacy', revision: 3, relationship: 'reference', provider: 'obsidian',
            canonicalUrl: 'obsidian://vault/note', label: 'Legacy note' },
        ];
        const project = ${JSON.stringify(project)};
        const mode = new URLSearchParams(location.search).get('mode');
        const writes = [];
        const reads = [];
        const watchers = new Set();
        let open = $state(true);
        let dirty = $state(false);
        function publish() {
          for (const callback of watchers) callback(task);
        }
        const client = {
          onUpdate(ref, args, callback) {
            reads.push([getFunctionName(ref), args]);
            watchers.add(callback);
            queueMicrotask(() => { if (watchers.has(callback)) callback(task); });
            return () => watchers.delete(callback);
          },
          async query(ref, args) {
            const name = getFunctionName(ref);
            reads.push([name, args]);
            if (name === 'tasks:get') return task;
            if (name === 'projects:list') return { page: [project], isDone: true, continueCursor: '' };
            if (name === 'links:list') {
              if (args.taskId !== task._id) throw new Error('Incorrect link task ID');
              return { page: links, isDone: true, continueCursor: '' };
            }
            if (name === 'steps:list') {
              const ordered = [...steps].sort((left, right) => left.rank - right.rank);
              if (mode === 'paged' && !args.paginationOpts.cursor) {
                return { page: ordered.slice(0, 1), isDone: false, continueCursor: 'steps-next' };
              }
              return { page: mode === 'paged' ? ordered.slice(1) : ordered, isDone: true, continueCursor: '' };
            }
            throw new Error('Unexpected query ' + name);
          },
          async mutation(ref, args) {
            const name = getFunctionName(ref);
            if (name !== 'tasks:apply' && name !== 'links:apply') throw new Error('Unexpected mutation');
            writes.push(args);
            const { command, operationId } = args;
            let revision;
            if (name === 'links:apply') {
              if (args.taskId !== task._id) throw new Error('Incorrect link task ID');
              const existing = links.find(link => link.publicId === command.publicId);
              if (command.kind === 'link.add' && !existing) {
                revision = 1;
                links = [...links, { publicId: command.publicId, revision, relationship: 'reference', provider: 'url', editable: true,
                  canonicalUrl: new URL(command.url).href, label: command.label }];
                if (mode === 'link-retry') throw new Error('Lost response after storing link');
              } else if (command.kind === 'link.add') {
                if (writes[0].operationId !== operationId) throw new Error('Link operation ID changed');
                revision = existing.revision;
              } else {
                if (command.expectedRevision !== existing.revision) throw new Error('Incorrect link revision');
                if (mode === 'link-conflict' && command.kind === 'link.edit' && existing.revision === 1) {
                  links = links.map(link => link === existing
                    ? { ...link, revision: 2, canonicalUrl: 'https://external.example/latest' }
                    : link);
                  throw new ConvexError({ code: 'REVISION_CONFLICT', currentRevision: 2 });
                }
                revision = existing.revision + 1;
                links = links.flatMap(link => link === existing
                  ? command.kind === 'link.remove' ? [] : [{ ...link, revision, canonicalUrl: new URL(command.url).href, label: command.label }]
                  : [link]);
              }
            } else if (command.kind === 'task.update') {
              if (mode === 'conflict' && writes.length === 1) {
                task = { ...task, title: 'Inspect repaired pump', priority: 'high', revision: 5 };
                publish();
                throw new ConvexError({ code: 'REVISION_CONFLICT', currentRevision: 5 });
              }
              if (mode === 'retry' && writes.length === 2) {
                if (operationId !== writes[0].operationId) throw new Error('Operation ID changed');
                revision = task.revision;
              } else {
                task = { ...task, ...command.patch, revision: task.revision + 1 };
                publish();
                revision = task.revision;
                if (mode === 'retry' && writes.length === 1) throw new Error('Lost response after commit');
              }
            } else if (command.kind.startsWith('task.')) {
              const status = command.kind === 'task.archive' ? 'archived'
                : command.kind === 'task.reopen' ? 'ready' : task.archivedFromStatus;
              task = { ...task, status, archivedFromStatus: task.status, revision: task.revision + 1 };
              publish();
              revision = task.revision;
            } else if (command.kind === 'step.create') {
              revision = 1;
              steps = [...steps, { publicId: command.publicId, title: command.title, revision,
                rank: Math.max(...steps.map(step => step.rank)) + 1, completed: false }];
            } else if (command.kind === 'step.update' || command.kind === 'step.delete') {
              steps = steps.flatMap(step => {
                if (step.publicId !== command.publicId) return [step];
                if (step.revision !== command.expectedRevision) throw new Error('Incorrect step revision');
                revision = step.revision + 1;
                return command.kind === 'step.delete' ? [] : [{ ...step, ...command.patch, revision }];
              });
            } else {
              throw new Error('Unexpected command ' + command.kind);
            }
            return { workspacePublicId: 'workspace-public', targetPublicId: command.publicId,
              revision, activityEventId: 'activity-event' };
          },
        };
        globalThis.fixture = { writes, reads };
      </script>
      <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
      {#if open}
        <TaskDetail {client} workspaceId="workspace-record" publicId="task-public"
          onClose={() => open = false} onDirtyChange={value => dirty = value} />
      {/if}`),
    ]);
    const result = await build({
      root: scratch, base: './', configFile: false, plugins: [svelte()], logLevel: 'silent',
      build: { write: false, modulePreload: false },
    });
    assets = new Map(result.output.map(file => [posix.join(path, file.fileName), file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function open(t, mode = '') {
  const context = await browser.newContext({ viewport: { width: 320, height: 720 }, timezoneId: 'America/Chicago' });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = url.pathname === path ? `${path}index.html` : url.pathname;
    const body = assets.get(asset);
    if (url.origin !== origin || body === undefined) return route.abort();
    const contentType = asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'text/html';
    await route.fulfill({ body, contentType });
  });
  const page = await context.newPage();
  await page.goto(`${origin}${path}?mode=${mode}`);
  await page.getByRole('textbox', { name: 'Title', exact: true }).waitFor();
  return page;
}

const writes = page => page.evaluate(() => globalThis.fixture.writes);

test('saves edited task fields and preserves the exact instant on unrelated edits', async t => {
  const page = await open(t);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 320);
  assert.match(await page.getByText('Old planner', { exact: false }).textContent(), /PUMP-1/);
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Check pump');
  await page.getByLabel('Description / notes').fill('Bring the calibration kit');
  await page.getByLabel('Priority').selectOption('urgent');
  await page.getByLabel('Rank', { exact: true }).fill('3.5');
  await page.getByLabel('Planned date').fill('2026-12-02');
  await page.getByLabel('Estimate (minutes)').fill('0');
  await page.getByText('Waiting details', { exact: true }).click();
  await page.getByLabel('Waiting for').fill('Casey');
  await page.getByLabel('Waiting reason').fill('Permit');
  await page.getByLabel('Follow-up date').fill('2026-12-03');
  await page.getByLabel('Project', { exact: true }).selectOption('project-record');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.getByText('Task saved.', { exact: true }).waitFor();
  const [first] = await writes(page);
  assert.deepEqual(first.command, {
    kind: 'task.update', publicId: 'task-public', expectedRevision: 4,
    patch: { title: 'Check pump', description: 'Bring the calibration kit', priority: 'urgent', rank: 3.5,
      plannedDate: '2026-12-02', estimateMinutes: 0, waitingPerson: 'Casey', waitingReason: 'Permit',
      followUpDate: '2026-12-03', projectId: 'project-record' },
  });
  await page.getByLabel('Deadline type').selectOption('date');
  await page.getByLabel('Deadline date').fill('2026-12-06');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.waitForFunction(() => globalThis.fixture.writes.length === 2);
  assert.deepEqual((await writes(page))[1].command, {
    kind: 'task.update', publicId: 'task-public', expectedRevision: 5,
    patch: { deadline: { kind: 'date', date: '2026-12-06' } },
  });
  await page.getByLabel('Deadline type').selectOption('instant');
  await page.getByLabel('Deadline time (UTC)').fill('2026-12-07T12:34:56.789');
  await page.getByLabel('Deadline time zone (optional)').fill('America/Chicago');
  await page.getByLabel('Planned date').fill('');
  await page.getByLabel('Estimate (minutes)').fill('');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.waitForFunction(() => globalThis.fixture.writes.length === 3);
  assert.deepEqual((await writes(page))[2].command, {
    kind: 'task.update', publicId: 'task-public', expectedRevision: 6,
    patch: { plannedDate: null, estimateMinutes: null,
      deadline: { kind: 'instant', at: Date.parse('2026-12-07T12:34:56.789Z'), timezone: 'America/Chicago' } },
  });
});

test('retries an ambiguous save with the exact operation while guarding the draft', async t => {
  const page = await open(t, 'retry');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('Check pump after calibration');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.getByText(/Could not confirm/).waitFor();
  assert.equal(await title.inputValue(), 'Check pump after calibration');
  assert.equal(await page.getByRole('status', { name: 'Draft state' }).textContent(), 'Dirty');
  await page.getByRole('button', { name: 'Retry change' }).press('Enter');
  await page.getByText('Task saved.', { exact: true }).waitFor();
  const [first, retry] = await writes(page);
  assert.deepEqual(retry, first);
  assert.equal(await page.getByRole('status', { name: 'Draft state' }).textContent(), 'Clean');
});

test('a conflicting edit retains the draft and requires review before an explicit save', async t => {
  const page = await open(t, 'conflict');
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await title.fill('My pump title');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.getByRole('button', { name: 'Review latest' }).click();
  await page.getByText('Inspect repaired pump', { exact: true }).waitFor();
  assert.equal(await title.inputValue(), 'My pump title');
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  assert.equal((await writes(page)).length, 1);
  assert.equal(await title.inputValue(), 'My pump title');
  assert.equal(await page.getByLabel('Priority').inputValue(), 'high');
  await page.getByRole('button', { name: 'Save task' }).click();
  await page.getByText('Task saved.', { exact: true }).waitFor();
  const [first, reviewed] = await writes(page);
  assert.notEqual(reviewed.operationId, first.operationId);
  assert.deepEqual(reviewed.command, {
    kind: 'task.update', publicId: 'task-public', expectedRevision: 5, patch: { title: 'My pump title' },
  });
});

test('step ordering and edits use provider IDs and revisions and permanent deletion requires confirmation', async t => {
  const page = await open(t, 'paged');
  await page.getByRole('button', { name: 'Load more steps' }).click();
  const row = title => page.getByRole('listitem').filter({ hasText: title });
  await row('Check log').getByRole('button', { name: 'Move up' }).click();
  await page.getByText('Step moved.', { exact: true }).waitFor();
  assert.match((await page.getByRole('list', { name: 'Task steps' }).getByRole('listitem').allTextContents())[0], /Check log/);
  await row('Check log').getByRole('button', { name: 'Edit step' }).click();
  await page.getByLabel('Step title', { exact: true }).fill('Review log');
  await page.getByRole('button', { name: 'Save step' }).click();
  await row('Review log').getByRole('checkbox').check();
  await page.getByText('Step completed.', { exact: true }).waitFor();
  await page.getByLabel('New step').fill('Sign report');
  await page.getByRole('button', { name: 'Add step' }).click();
  await row('Sign report').getByRole('button', { name: 'Delete step' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Delete step?' });
  assert.equal(await confirmation.getByRole('button', { name: 'Cancel' }).evaluate(el => el === globalThis.document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal((await writes(page)).length, 4);
  await row('Sign report').getByRole('button', { name: 'Delete step' }).click();
  await confirmation.getByRole('button', { name: 'Delete permanently' }).click();
  await page.getByText('Step deleted.', { exact: true }).waitFor();
  assert.equal(await row('Sign report').count(), 0);
  const [move, edit, complete, add, remove] = await writes(page);
  assert.ok(move.command.patch.rank < 0);
  assert.equal(move.command.expectedRevision, 3);
  assert.deepEqual(edit.command, { kind: 'step.update', publicId: 'step-2', expectedRevision: 4, patch: { title: 'Review log' } });
  assert.deepEqual(complete.command, { kind: 'step.update', publicId: 'step-2', expectedRevision: 5, patch: { completed: true } });
  assert.equal(add.command.taskId, 'task-record');
  assert.deepEqual(remove.command, { kind: 'step.delete', publicId: add.command.publicId, expectedRevision: 1 });
  const reads = await page.evaluate(() => globalThis.fixture.reads);
  assert.ok(reads.some(([name, args]) => name === 'steps:list' && args.paginationOpts.cursor === 'steps-next'));
  assert.ok(reads.filter(([, args]) => args.paginationOpts).every(([, args]) =>
    args.workspaceId === 'workspace-record' && args.paginationOpts.numItems <= 50));
});

test('complete, reopen, archive and restore use the provider lifecycle', async t => {
  const page = await open(t);
  await page.getByRole('button', { name: 'Complete task' }).click();
  await page.getByRole('button', { name: 'Reopen task' }).click();
  await page.getByRole('button', { name: 'Archive task' }).click();
  const title = page.getByRole('textbox', { name: 'Title', exact: true });
  await page.getByRole('button', { name: 'Restore task' }).waitFor();
  assert.equal(await title.isDisabled(), true);
  await page.getByRole('button', { name: 'Restore task' }).click();
  await page.getByRole('button', { name: 'Complete task' }).waitFor();
  assert.equal(await title.isEnabled(), true);
  assert.deepEqual((await writes(page)).map(({ command }) => command), [
    { kind: 'task.update', publicId: 'task-public', expectedRevision: 4, patch: { status: 'done' } },
    { kind: 'task.reopen', publicId: 'task-public', expectedRevision: 5 },
    { kind: 'task.archive', publicId: 'task-public', expectedRevision: 6 },
    { kind: 'task.restore', publicId: 'task-public', expectedRevision: 7 },
  ]);
});

test('renders external links safely and saves, retries, edits and removes a manual link', async t => {
  const page = await open(t, 'link-retry');
  const section = page.getByRole('region', { name: 'External links' });
  const managed = section.getByRole('link', { name: 'Managed issue' });
  await managed.waitFor();
  assert.equal(await managed.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await section.getByRole('link', { name: 'Legacy note' }).count(), 0);
  await section.getByText('obsidian://vault/note', { exact: true }).waitFor();
  assert.equal(await section.getByRole('button', { name: /Edit link/ }).count(), 0);
  const address = section.getByLabel('HTTPS URL');
  await address.fill('http://unsafe.example');
  await section.getByRole('button', { name: 'Add link' }).click();
  await section.getByRole('alert').waitFor();
  assert.equal((await writes(page)).length, 0);
  await address.fill('https://external.example/manual');
  await section.getByLabel('Label (optional)').fill('Manual');
  await section.getByRole('button', { name: 'Add link' }).click();
  await section.getByRole('button', { name: 'Retry link change' }).waitFor();
  await page.getByRole('button', { name: 'Close task' }).click();
  assert.match(await page.getByRole('dialog', { name: 'Close task details?' }).textContent(), /may already have been saved/);
  await page.keyboard.press('Escape');
  await section.getByRole('button', { name: 'Retry link change' }).click();
  assert.equal(await section.getByRole('link', { name: 'Manual', exact: true }).getAttribute('href'), 'https://external.example/manual');
  await section.getByRole('button', { name: 'Edit link Manual' }).click();
  await section.getByLabel('Label (optional)').fill('Service manual');
  await section.getByRole('button', { name: 'Save link' }).click();
  await section.getByRole('link', { name: 'Service manual' }).waitFor();
  page.once('dialog', dialog => dialog.accept());
  await section.getByRole('button', { name: 'Remove link Service manual' }).click();
  await section.getByRole('link', { name: 'Service manual' }).waitFor({ state: 'detached' });
  const [first, retry, edit, remove] = await writes(page);
  assert.deepEqual(retry, first);
  assert.equal(first.taskId, 'task-record');
  assert.deepEqual(edit.command, {
    kind: 'link.edit', publicId: first.command.publicId, expectedRevision: 1,
    url: 'https://external.example/manual', label: 'Service manual',
  });
  assert.deepEqual(remove.command, { kind: 'link.remove', publicId: first.command.publicId, expectedRevision: 2 });
});

test('reviewing a conflicting link edit preserves the latest URL and the draft label', async t => {
  const page = await open(t, 'link-conflict');
  const section = page.getByRole('region', { name: 'External links' });
  await section.getByLabel('HTTPS URL').fill('https://external.example/original');
  await section.getByLabel('Label (optional)').fill('Manual');
  await section.getByRole('button', { name: 'Add link' }).click();
  await section.getByRole('button', { name: 'Edit link Manual' }).click();
  await section.getByLabel('Label (optional)').fill('My label');
  await section.getByRole('button', { name: 'Save link' }).click();
  await section.getByRole('button', { name: 'Review latest link' }).click();
  await section.getByText('https://external.example/latest', { exact: true }).waitFor();
  await section.getByRole('button', { name: 'Keep my link edits' }).click();
  assert.equal((await writes(page)).length, 2);
  assert.equal(await section.getByLabel('Label (optional)').inputValue(), 'My label');
  assert.equal(await section.getByLabel('HTTPS URL').inputValue(), 'https://external.example/latest');
  await section.getByRole('button', { name: 'Save link' }).click();
  await section.getByRole('link', { name: 'My label' }).waitFor();
  assert.deepEqual((await writes(page))[2].command, {
    kind: 'link.edit', publicId: (await writes(page))[0].command.publicId, expectedRevision: 2,
    url: 'https://external.example/latest', label: 'My label',
  });
});
