import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://projects.test';
const mount = '/klaxon/';
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(webRoot, '.verification-projects-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="./main.js"></script>'),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        import '../src/planner-shell/planner-shell.css';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import { getFunctionName } from 'convex/server';
        import { ConvexError } from 'convex/values';
        import ProjectsView from '../src/projects/ProjectsView.svelte';
        const workspaceId = 'workspace';
        let disabled = $state(false);
        let dirty = $state(false);
        const reads = [], writes = [], opened = [];
        const subscriptions = new Set();
        const operations = new Map();
        let projects = [
          { _id: 'maintenance-record', publicId: 'maintenance', workspaceId, name: 'Maintenance', area: 'Work', rank: 1, revision: 2 },
          { _id: 'home-record', publicId: 'home', workspaceId, name: 'Home upkeep', area: 'Personal', rank: 2, revision: 1 },
        ];
        let tasks = [
          { _id: 'gauge-record', publicId: 'gauge', projectId: 'maintenance-record', laneId: 'prep-lane', title: 'Read gauge', status: 'ready', revision: 4, rank: 1 },
          { _id: 'pump-record', publicId: 'pump', projectId: 'maintenance-record', title: 'Inspect pump', status: 'inbox', revision: 1, rank: 2 },
          { _id: 'garage-record', publicId: 'garage', projectId: 'home-record', title: 'Clean garage', status: 'inbox', revision: 1, rank: 1 },
        ];
        let lanes = [{ _id: 'prep-lane', publicId: 'prep', name: 'Preparation', rank: 0, projectId: 'maintenance-record' }];
        let loseNextResponse = false;
        function read(name, args) {
          if (args.workspaceId !== workspaceId) throw new Error('Incorrect workspace');
          if (name === 'organization:lanes') {
            return { lanes: lanes.filter(lane => lane.projectId === args.projectId), partial: false };
          }
          if (args.paginationOpts.numItems !== 25) throw new Error('Incorrect page limit');
          if (name === 'projects:list') {
            return { page: projects, isDone: true, continueCursor: '' };
          }
          if (name === 'tasks:list' && args.filter.kind === 'project') {
            const rows = tasks.filter(task => task.projectId === args.filter.projectId);
            const next = args.paginationOpts.cursor === 'next';
            return { page: next ? rows.slice(1) : rows.slice(0, 1), isDone: next || rows.length <= 1, continueCursor: 'next' };
          }
          throw new Error('Unexpected query ' + name);
        }
        function publish(name) {
          for (const sub of subscriptions) if (sub.name === name) sub.receive(read(name, sub.args));
        }
        const client = {
          onUpdate(reference, args, receive) {
            const name = getFunctionName(reference);
            const sub = { name, args, receive };
            reads.push([name, args]);
            subscriptions.add(sub);
            queueMicrotask(() => { if (subscriptions.has(sub)) receive(read(name, args)); });
            return () => subscriptions.delete(sub);
          },
          async mutation(reference, args) {
            const name = getFunctionName(reference);
            writes.push([name, args]);
            if (disabled || args.workspaceId !== workspaceId) throw new Error('Write outside the connected workspace');
            const previous = operations.get(args.operationId);
            if (previous) {
              if (JSON.stringify(previous.args) !== JSON.stringify(args)) throw new Error('Retry changed the request');
              return previous.result;
            }
            const { command } = args;
            let revision = 1;
            if (name === 'organization:createLane' && projects.some(project => project._id === args.projectId && project.archivedAt === undefined)) {
              lanes = [...lanes, { _id: 'created-lane', publicId: args.publicId, name: args.name, rank: 1, projectId: args.projectId }];
              publish('organization:lanes');
            } else if (name === 'tasks:apply' && command.kind === 'project.create') {
              projects = [...projects, { _id: 'created-project', workspaceId, publicId: command.publicId, name: command.name,
                area: command.area, rank: 0, revision }];
              publish('projects:list');
            } else if (name === 'tasks:apply' && command.kind === 'task.update') {
              const task = tasks.find(item => item.publicId === command.publicId);
              if (task.revision !== command.expectedRevision) throw new ConvexError({ code: 'REVISION_CONFLICT' });
              revision = command.expectedRevision + 1;
              tasks = tasks.map(item => item === task ? { ...item, laneId: command.patch.laneId ?? undefined, revision } : item);
              publish('tasks:list');
            } else if (name === 'tasks:apply' && ['project.update', 'project.archive', 'project.restore'].includes(command.kind)) {
              const project = projects.find(item => item.publicId === command.publicId);
              if (project.revision !== command.expectedRevision) throw new ConvexError({ code: 'REVISION_CONFLICT' });
              revision = command.expectedRevision + 1;
              const patch = command.kind === 'project.update' ? command.patch
                : { archivedAt: command.kind === 'project.archive' ? 10 : undefined };
              projects = projects.map(item => item === project ? { ...item, ...patch, revision } : item);
              publish('projects:list');
            } else {
              throw new Error('Unexpected mutation ' + name);
            }
            const result = { workspacePublicId: 'personal', targetPublicId: command?.publicId ?? args.publicId, revision, activityEventId: 'activity' };
            operations.set(args.operationId, { args, result });
            if (loseNextResponse) {
              loseNextResponse = false;
              throw new Error('Response lost after commit');
            }
            return result;
          },
        };
        globalThis.fixture = { reads, writes, opened, setDisabled: value => disabled = value,
          loseNextResponse: () => loseNextResponse = true,
          activeReads: () => [...subscriptions].map(sub => sub.name).sort() };
      </script>
      <main class="planner-shell">
        <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
        <ProjectsView {client} {workspaceId} {disabled} onOpenTask={id => opened.push(id)}
          onDirtyChange={value => dirty = value} />
      </main>`),
    ]);
    const result = await build({ root: scratch, base: './', configFile: false, plugins: [svelte()], logLevel: 'silent',
      build: { write: false, modulePreload: false } });
    assets = new Map(result.output.map(file => [posix.join(mount, file.fileName), file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function visit(t, viewport) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser errors'));
  page.setDefaultTimeout(4_000);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    const path = url.pathname === mount ? `${mount}index.html` : url.pathname;
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    return url.origin === origin && assets.has(path)
      ? route.fulfill({ contentType: types[posix.extname(path)], body: assets.get(path) })
      : route.abort();
  });
  await page.goto(origin + mount);
  return page;
}

test('projects are grouped by area and can be created, edited, archived and restored', async t => {
  const page = await visit(t);
  await page.getByRole('heading', { name: 'Work', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Personal', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Project name').fill('Launch review');
  await page.getByLabel('Area', { exact: true }).fill('Work');
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Dirty');
  assert.ok(await page.getByRole('button', { name: 'Home upkeep' }).isDisabled());
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByText('Project created.').waitFor();
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Clean');
  await page.getByRole('button', { name: 'Launch review' }).click();
  await page.getByRole('button', { name: 'Edit project' }).click();
  await page.getByLabel('Project name').fill('Release review');
  await page.getByLabel('Area', { exact: true }).fill('Personal');
  await page.getByRole('button', { name: 'Save project' }).click();
  await page.getByRole('heading', { name: 'Release review' }).waitFor();
  await page.getByRole('button', { name: 'Archive project' }).click();
  await page.getByText('Project archived.').waitFor();
  await page.getByRole('button', { name: 'Restore project' }).click();
  await page.getByText('Project restored.').waitFor();

  const writes = await page.evaluate(() => globalThis.fixture.writes);
  const publicId = writes[0][1].command.publicId;
  assert.deepEqual(writes.map(([endpoint, args]) => [endpoint, args.command]), [
    ['tasks:apply', { kind: 'project.create', publicId, name: 'Launch review', area: 'Work' }],
    ['tasks:apply', { kind: 'project.update', publicId, expectedRevision: 1, patch: { name: 'Release review', area: 'Personal' } }],
    ['tasks:apply', { kind: 'project.archive', publicId, expectedRevision: 2 }],
    ['tasks:apply', { kind: 'project.restore', publicId, expectedRevision: 3 }],
  ]);
});

test('an accessible project board creates a lane and retries a move with the original revision', async t => {
  const page = await visit(t, { width: 320, height: 750 });
  await page.getByRole('button', { name: 'Maintenance' }).click();
  await page.getByRole('button', { name: 'Read gauge' }).press('Enter');
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.opened), ['gauge']);
  await page.getByRole('button', { name: 'Next task page' }).click();
  await page.getByRole('button', { name: 'Inspect pump' }).waitFor();
  await page.getByRole('button', { name: 'Previous task page' }).click();
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  const prep = page.getByRole('region', { name: 'Preparation', exact: true });
  await prep.getByRole('button', { name: 'Read gauge' }).waitFor();
  await page.getByRole('button', { name: 'New lane', exact: true }).click();
  await page.getByLabel('Lane name').fill('Inspection');
  assert.equal(await page.getByLabel('Draft state').textContent(), 'Dirty');
  await page.getByRole('button', { name: 'Add lane' }).click();
  const inspection = page.getByRole('region', { name: 'Inspection', exact: true });
  await inspection.waitFor();
  const move = page.getByLabel('Move Read gauge to lane');
  await page.evaluate(() => globalThis.fixture.setDisabled(true));
  await move.waitFor();
  assert.ok(await move.isDisabled());
  await page.evaluate(() => { globalThis.fixture.setDisabled(false); globalThis.fixture.loseNextResponse(); });
  await move.selectOption('created-lane');
  await inspection.getByRole('button', { name: 'Read gauge' }).waitFor();
  await page.getByRole('button', { name: 'Retry project change' }).click();
  await page.getByText('Task moved.').waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('aria-label') === 'Move Read gauge to lane');
  const writes = await page.evaluate(() => globalThis.fixture.writes);
  assert.deepEqual([writes[0][0], writes[0][1].projectId, writes[0][1].name], ['organization:createLane', 'maintenance-record', 'Inspection']);
  assert.deepEqual(writes[1][1].command, {
    kind: 'task.update', publicId: 'gauge', expectedRevision: 4, patch: { laneId: 'created-lane' },
  });
  assert.deepEqual(writes[2], writes[1]);
  assert.deepEqual(await page.evaluate(() => globalThis.fixture.activeReads()), ['organization:lanes', 'projects:list', 'tasks:list']);
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth), 320);
});
