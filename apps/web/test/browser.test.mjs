import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { interceptDevelopment, deployment, task } from './development-transport.mjs';

const mount = '/klaxon/foundation/';
const root = fileURLToPath(new URL('../', import.meta.url));
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
};
let developmentOutput;
let developmentBuild;
after(() => developmentOutput && rm(developmentOutput, { recursive: true, force: true }));

async function serveDist(t, dist = join(root, 'dist')) {
  const files = await readdir(dist, { recursive: true, withFileTypes: true });
  const assets = new Map();

  for (const file of files.filter(file => file.isFile())) {
    const path = join(file.parentPath, file.name);
    const url = mount + relative(dist, path).split(sep).map(encodeURIComponent).join('/');
    assets.set(url, {
      contents: await readFile(path),
      type: contentTypes[extname(path)] ?? 'application/octet-stream',
    });
  }

  assert.ok(assets.has(`${mount}index.html`), 'Run npm run verify or npm run build first');
  assets.set(mount, assets.get(`${mount}index.html`));

  const server = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }).end(asset.contents);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('the built app loads and reloads below a static mount using only local assets', { timeout: 30_000 }, async (t) => {
  const origin = await serveDist(t);
  const entry = `${origin}${mount}`;
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());

  const context = await browser.newContext({ serviceWorkers: 'block' });
  const unexpectedRequests = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(entry)) return route.continue();
    unexpectedRequests.push(url);
    return route.abort();
  });
  await context.routeWebSocket('**/*', socket => {
    unexpectedRequests.push(socket.url());
    return socket.close();
  });

  const missing = await context.request.get(`${entry}missing-route`);
  assert.equal(missing.status(), 404);

  const page = await context.newPage();
  const responses = new Map();
  const pageErrors = [];
  const failedRequests = [];
  page.on('response', response => responses.set(response.url(), response.status()));
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(request.url()));
  const heading = page.getByRole('heading', { level: 1, name: 'Klaxon', exact: true });

  page.setDefaultTimeout(5_000);
  for (const navigate of [() => page.goto(entry), () => page.reload()]) {
    responses.clear();
    const response = await navigate();
    assert.equal(response?.status(), 200);
    assert.equal(page.url(), entry);
    await heading.waitFor();
    assert.equal(await page.locator('meta[name="klaxon-development-origin"]').count(), 0);

    const scripts = await page.locator('script[type="module"][src]').evaluateAll(elements => elements.map(element => element.src));
    const styles = await page.locator('link[rel="stylesheet"][href]').evaluateAll(elements => elements.map(element => element.href));
    assert.ok(scripts.length > 0, 'expected the compiled JavaScript module');
    assert.ok(styles.length > 0, 'expected the compiled stylesheet');
    for (const url of [...scripts, ...styles]) {
      assert.ok(url.startsWith(entry), `asset resolved outside the mount: ${url}`);
      assert.equal(responses.get(url), 200, `asset did not load: ${url}`);
    }

    assert.deepEqual([...responses.values()].filter(status => status !== 200), [], 'HTTP errors');
    assert.deepEqual(unexpectedRequests, [], 'requests outside the static mount');
    assert.deepEqual(failedRequests, [], 'failed requests');
    assert.deepEqual(pageErrors, [], 'runtime errors');
  }
});

async function buildDevelopment() {
  const output = developmentOutput = await mkdtemp(join(root, '.verification-browser-'));
  const build = spawnSync(process.execPath, [
    join(root, 'node_modules/vite/bin/vite.js'), 'build', '--mode', 'development', '--outDir', output,
  ], {
    cwd: root,
    env: { ...process.env, KLAXON_PUBLIC_DEV_ORIGIN: deployment },
    encoding: 'utf8',
    timeout: 90_000,
  });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr);
  return output;
}

async function openDevelopment(t, { native = false } = {}) {
  const output = await (developmentBuild ??= buildDevelopment());
  const entry = (await serveDist(t, output)) + mount;
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const transport = await interceptDevelopment(context, t, entry);
  if (native) await context.addInitScript(() => Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { value: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'runtime errors'));
  page.setDefaultTimeout(5_000);
  await page.goto(entry);
  return { page, transport };
}

async function signIn(page, password = 'inert-password', username = 'test-owner') {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('Development signs in and shows bounded, reactive task pages and session states', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page, 'wrong-password');
  await page.getByRole('alert').getByText(/check your username and password/i).waitFor();
  assert.equal(transport.sockets.size, 0);
  assert.equal(await page.getByLabel('Password').inputValue(), '');
  await signIn(page);
  await page.getByText('Loading tasks…').waitFor();
  assert.deepEqual((await transport.queryAdded.next()).args, {
    workspaceId: 'personal-workspace',
    filter: { kind: 'status', status: 'inbox' },
    paginationOpts: { cursor: null, numItems: 25 },
  });
  transport.failRead();
  await page.getByRole('alert').getByText('Could not load tasks.').waitFor();
  await page.getByRole('button', { name: 'Retry loading tasks' }).click();
  await transport.queryAdded.next();
  transport.publish([]);
  await page.getByText('No inbox tasks.').waitFor();
  transport.publish([task('first', 'Plan the week')], 'next-page');
  await page.getByText('Plan the week', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next page' }).click();
  assert.equal((await transport.queryAdded.next()).args.paginationOpts.cursor, 'next-page');
  await page.getByText('Loading tasks…').waitFor();
  transport.publish([task('second', 'Read the brief')]);
  await page.getByText('Read the brief', { exact: true }).waitFor();
  await page.getByLabel('Task status filter').selectOption('done');
  assert.deepEqual((await transport.queryAdded.next()).args, {
    workspaceId: 'personal-workspace',
    filter: { kind: 'status', status: 'done' },
    paginationOpts: { cursor: null, numItems: 25 },
  });
  assert.equal(transport.activeQueries(), 1);
  transport.publish([task('done', 'Finished task', 'done')]);
  await page.getByText('Finished task', { exact: true }).waitFor();
  await page.getByLabel('New task title').fill('Draft while connected');
  assert.ok(await page.getByRole('button', { name: 'Add task' }).isEnabled());

  await page.context().setOffline(true);
  await page.getByText('Offline. Task changes are paused.').waitFor();
  assert.ok(await page.getByRole('button', { name: 'Add task' }).isDisabled());
  await page.getByText('Finished task', { exact: true }).waitFor();
  await page.context().setOffline(false);
  await page.getByText('Offline. Task changes are paused.').waitFor({ state: 'hidden' });
  transport.rotate();
  assert.equal((await transport.queryAdded.next()).args.filter.status, 'done');
  transport.publish([task('done', 'Updated after renewal', 'done', 5)]);
  await page.getByText('Updated after renewal', { exact: true }).waitFor();
  transport.expire();
  await page.getByRole('alert').getByText(/session expired/i).waitFor();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByText('Updated after renewal', { exact: true }).count(), 0);
  assert.deepEqual(await page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    databases: (await globalThis.indexedDB.databases()).length,
    caches: (await globalThis.caches.keys()).length,
  })), { local: 0, session: 0, databases: 0, caches: 0 });
  assert.deepEqual(await page.context().cookies(), []);
});

test('edits roll back on failure and retry with the original operation and revision', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([task('first', 'Original')]);
  await page.getByRole('button', { name: 'Edit Original' }).click();
  await page.getByLabel('Task title').fill('Renamed');
  await page.getByRole('button', { name: 'Save' }).click();
  const edit = await transport.writes.next();
  assert.match(edit.args.operationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(edit.args.command, {
    kind: 'task.update', publicId: 'first', expectedRevision: 4, patch: { title: 'Renamed' },
  });
  await page.getByText('Renamed', { exact: true }).waitFor();
  edit.fail();
  await page.getByText('Original', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Retry change' }).click();
  const retry = await transport.writes.next();
  assert.deepEqual(retry.args, edit.args);
  retry.succeed([task('first', 'Renamed', 'inbox', 5)]);
  await page.getByText('Renamed', { exact: true }).waitFor();
  await page.getByText('Saving…').waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Edit Renamed' }).click();
  await page.getByLabel('Task status', { exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Save' }).click();
  const conflict = await transport.writes.next();
  assert.deepEqual(conflict.args.command, {
    kind: 'task.update', publicId: 'first', expectedRevision: 5, patch: { status: 'done' },
  });
  assert.notEqual(conflict.args.operationId, edit.args.operationId);
  await page.getByText('Renamed', { exact: true }).waitFor({ state: 'hidden' });
  transport.publish([task('first', 'Changed elsewhere', 'inbox', 6)]);
  conflict.fail({ code: 'REVISION_CONFLICT', currentRevision: 6 });
  await page.getByRole('alert').getByText(/changed elsewhere/i).waitFor();
  await page.getByText('Changed elsewhere', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry change' }).count(), 0);
  await page.getByRole('button', { name: 'Discard draft' }).click();

  await page.getByLabel('New task title').fill('Capture idea');
  await page.getByRole('button', { name: 'Add task' }).click();
  const create = await transport.writes.next();
  const publicId = create.args.command.publicId;
  assert.match(publicId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(create.args.command, { kind: 'task.create', publicId, title: 'Capture idea', status: 'inbox' });
  await page.getByText('Capture idea', { exact: true }).waitFor();
  create.succeed([task('first', 'Changed elsewhere', 'inbox', 6), task(publicId, 'Capture idea', 'inbox', 1)]);
  await page.getByText('Saving…').waitFor({ state: 'hidden' });
  assert.equal(await page.getByText('Capture idea', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(await page.getByText('Capture idea', { exact: true }).count(), 0);
  assert.equal(transport.signOuts, 1);
});

test('a lost create acknowledgment can be retried after reauth with the exact original request', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([]);
  await page.getByLabel('New task title').fill('Capture through expiry');
  await page.getByRole('button', { name: 'Add task' }).click();
  const create = await transport.writes.next();
  const created = task(create.args.command.publicId, 'Capture through expiry', 'inbox', 1);
  transport.publish([created]); // The server applied the write, but its acknowledgment never arrived.
  await page.getByText('Saving…').waitFor();
  transport.expire();
  await page.getByRole('alert').getByText(/session expired/i).waitFor();
  assert.equal(await page.getByText('Capture through expiry', { exact: true }).count(), 0);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([created]);
  await page.getByRole('button', { name: 'Retry change' }).click();
  const retry = await transport.writes.next();
  assert.deepEqual(retry.args, create.args);
  retry.succeed([created]);
  await page.getByText('Task added.').waitFor();
  assert.equal(await page.getByText('Capture through expiry', { exact: true }).count(), 1);
});

test('an ambiguous update is visible only after confirming the original account and workspace', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([task('first', 'Owner task')]);
  await page.getByRole('button', { name: 'Edit Owner task' }).click();
  await page.getByLabel('Task title').fill('Private draft title');
  await page.getByRole('button', { name: 'Save' }).click();
  const edit = await transport.writes.next();
  edit.fail();
  await page.getByRole('button', { name: 'Retry change' }).waitFor();
  transport.expire();
  await page.getByRole('alert').getByText(/session expired/i).waitFor();

  async function checkDifferentWorkspace(username, workspaceId) {
    await signIn(page, 'inert-password', username);
    assert.equal((await transport.queryAdded.next()).args.workspaceId, workspaceId);
    transport.publish([]);
    await page.getByText('No inbox tasks.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Retry change' }).count(), 0);
    assert.equal(await page.getByText('Private draft title', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  }

  await checkDifferentWorkspace('test-other', 'other-personal-workspace');
  transport.changeOwnerWorkspace();
  await checkDifferentWorkspace('test-owner', 'replacement-workspace');
  transport.restoreOwnerWorkspace();

  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([task('first', 'Owner task')]);
  await page.getByRole('button', { name: 'Retry change' }).click();
  const retry = await transport.writes.next();
  assert.deepEqual(retry.args, edit.args);
  assert.equal(retry.args.command.expectedRevision, 4);
  retry.succeed([task('first', 'Private draft title', 'inbox', 5)]);
  await page.getByText('Task updated.').waitFor();
});

test('an update conflict keeps the draft and requires explicit review of the latest revision', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([task('first', 'Original')]);
  await page.getByRole('button', { name: 'Edit Original' }).click();
  await page.getByLabel('Task title').fill('My revised title');
  await page.getByRole('button', { name: 'Save' }).click();
  const edit = await transport.writes.next();
  transport.publish([]);
  edit.fail({ code: 'REVISION_CONFLICT', currentRevision: 5 });
  const conflict = page.getByRole('alert');
  await conflict.getByText('My revised title', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  assert.ok(await page.getByRole('button', { name: 'Add task' }).isDisabled());
  await page.getByRole('button', { name: 'Review latest task' }).click();
  const lookup = await transport.taskRequested.next();
  assert.deepEqual(lookup.args, { workspaceId: 'personal-workspace', publicId: 'first' });
  lookup.respond(task('first', 'Their revised title', 'waiting', 6));
  await conflict.getByText('Their revised title', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue editing' }).click();
  assert.equal(await page.getByLabel('Task title').inputValue(), 'My revised title');
  assert.equal(await page.getByLabel('Task status', { exact: true }).inputValue(), 'waiting');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const retry = await transport.writes.next();
  assert.notEqual(retry.args.operationId, edit.args.operationId);
  assert.deepEqual(retry.args.command, {
    kind: 'task.update', publicId: 'first', expectedRevision: 6, patch: { title: 'My revised title' },
  });
  retry.succeed([]);
  await page.getByText('Task updated.').waitFor();
  const heading = page.getByRole('heading', { name: 'Tasks', exact: true });
  assert.ok(await heading.evaluate(element => element === element.ownerDocument.activeElement));
});

test('dirty edits guard row and page navigation and return keyboard focus on cancel and save', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([task('first', 'Original'), task('second', 'Another task')], 'next-page');
  const original = page.getByRole('button', { name: 'Edit Original' });
  const title = page.getByLabel('Task title');
  await original.press('Enter');
  await title.fill('Unsaved draft');
  assert.ok(await original.isDisabled());
  assert.ok(await page.getByRole('button', { name: 'Edit Another task' }).isDisabled());
  assert.ok(await page.getByRole('button', { name: 'Next page' }).isDisabled());
  assert.ok(await page.getByLabel('Task status filter').isDisabled());
  assert.equal(await title.inputValue(), 'Unsaved draft');
  await page.getByRole('button', { name: 'Cancel' }).press('Enter');
  assert.ok(await original.evaluate(element => element === element.ownerDocument.activeElement));
  await original.press('Enter');
  await title.fill('Saved title');
  await page.getByRole('button', { name: 'Save' }).press('Enter');
  const edit = await transport.writes.next();
  edit.succeed([task('first', 'Saved title', 'inbox', 5), task('second', 'Another task')]);
  await page.getByText('Task updated.').waitFor();
  const saved = page.getByRole('button', { name: 'Edit Saved title' });
  assert.ok(await saved.evaluate(element => element === element.ownerDocument.activeElement));
});

test('sign-out asks for explicit confirmation while a save outcome is unknown', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([]);
  await page.getByLabel('New task title').fill('Unconfirmed task');
  await page.getByRole('button', { name: 'Add task' }).click();
  const write = await transport.writes.next();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('alert').getByText(/may already have been applied/i).waitFor();
  assert.equal(transport.signOuts, 0);
  await page.getByRole('button', { name: 'Stay signed in' }).click();
  write.fail();
  await page.getByRole('button', { name: 'Retry change' }).waitFor();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out and discard' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.equal(transport.signOuts, 1);
  await signIn(page);
  await transport.queryAdded.next();
  transport.publish([]);
  await page.getByText('No inbox tasks.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry change' }).count(), 0);
});

test('a native webview keeps the offline headline even with a Development build', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { native: true });
  await page.getByRole('heading', { name: 'Klaxon', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Username').count(), 0);
  assert.equal(transport.httpRequests, 0);
  assert.equal(transport.sockets.size, 0);
});
