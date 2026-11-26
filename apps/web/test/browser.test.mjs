import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { capture, interceptDevelopment, deployment, task } from './development-transport.mjs';

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

async function openDevelopment(t, { native = false, hash = '#/inbox', viewport, touch = false } = {}) {
  const output = await (developmentBuild ??= buildDevelopment());
  const entry = (await serveDist(t, output)) + mount;
  const browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block', viewport, isMobile: touch, hasTouch: touch });
  const transport = await interceptDevelopment(context, t, entry);
  if (native) await context.addInitScript(() => Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { value: {} }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'runtime errors'));
  page.setDefaultTimeout(5_000);
  await page.goto(entry + hash);
  return { page, transport };
}

async function signIn(page, password = 'inert-password', username = 'test-owner') {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('Settings issues only a bearer hash, retries the same issuance and clears one-time disclosure across sessions', async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/settings' });
  await signIn(page);
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Settings', exact: true }).getAttribute('aria-current'), 'page');
  await page.getByLabel('Credential label').fill('Task helper');
  await page.getByRole('button', { name: 'Issue credential' }).click();
  const issue = await transport.agentWrites.next();
  assert.equal(issue.name, 'agentCredentials:issue');
  assert.deepEqual(Object.keys(issue.args).sort(), ['expiresAt', 'label', 'scopes', 'tokenHash', 'workspaceId']);
  assert.deepEqual(issue.args.scopes, ['tasks:read']);
  assert.match(issue.args.tokenHash, /^[a-f0-9]{64}$/);
  issue.fail();
  const retry = page.getByRole('button', { name: 'Retry issuance' });
  await retry.click();
  const repeated = await transport.agentWrites.next();
  assert.deepEqual(repeated.args, issue.args);
  const principal = { issuer: 'https://issuer.test', subject: 'agent-account', clientId: 'client-1' };
  const row = { publicId: 'credential-1', label: issue.args.label, scopes: issue.args.scopes,
    expiresAt: issue.args.expiresAt, createdAt: Date.now(), oauthBindingAvailable: true, oauthCandidate: principal };
  repeated.succeed(row);
  const disclosure = page.getByLabel('Bearer token');
  await disclosure.waitFor();
  const bearer = await disclosure.inputValue();
  assert.match(bearer, /^klx_[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(bearer).digest('hex'), issue.args.tokenHash);
  const stored = await page.evaluate(() => [
    ...Object.values(globalThis.localStorage), ...Object.values(globalThis.sessionStorage), globalThis.history.state,
  ]);
  assert.ok(!JSON.stringify(stored).includes(bearer));
  await page.getByRole('button', { name: 'Hide token' }).click();
  await disclosure.waitFor({ state: 'detached' });
  await page.getByText('OAuth setup identifiers', { exact: true }).click();
  await page.getByText('personal-public', { exact: true }).waitFor();
  await page.getByText(row.publicId, { exact: true }).waitFor();
  assert.equal(await page.getByText(issue.args.tokenHash, { exact: true }).count(), 0);
  assert.equal(await page.getByText(issue.args.workspaceId, { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Enable OAuth for Task helper' }).click();
  const review = page.getByRole('region', { name: 'Credential access confirmation' });
  for (const value of Object.values(principal)) await review.getByText(value, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Confirm OAuth access' }).click();
  const grant = await transport.agentWrites.next();
  assert.equal(grant.name, 'agentCredentials:bindOAuth');
  assert.deepEqual(grant.args, { workspaceId: issue.args.workspaceId, publicId: row.publicId, expectedPrincipal: principal });
  grant.succeed({ ...row, oauthBound: true });
  await page.getByText('OAuth enabled', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Revoke Task helper' }).click();
  await page.getByRole('button', { name: 'Confirm revocation' }).click();
  const revoke = await transport.agentWrites.next();
  assert.equal(revoke.name, 'agentCredentials:revoke');
  assert.equal(revoke.args.publicId, row.publicId);
  revoke.succeed({ ...row, oauthBound: false, revokedAt: Date.now() });
  await page.getByText('Revoked', { exact: true }).waitFor();
  assert.equal(await page.getByText('OAuth enabled', { exact: true }).count(), 0);
  await page.getByLabel('Credential label').fill('Pending credential');
  await page.getByRole('checkbox', { name: 'Read planning' }).check();
  await page.getByLabel('Preview plans', { exact: true }).check();
  await page.getByLabel('Apply plans', { exact: true }).check();
  await page.getByRole('button', { name: 'Issue credential' }).click();
  const late = await transport.agentWrites.next();
  assert.deepEqual(late.args.scopes, ['tasks:read', 'planning:read', 'planning:preview', 'planning:apply']);
  transport.expire();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  await signIn(page, 'inert-password', 'test-other');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  late.succeed({ ...row, label: late.args.label, publicId: 'credential-2' });
  assert.equal(await disclosure.count(), 0);
  assert.equal(await page.getByText('Task helper', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Pending credential', { exact: true }).count(), 0);
});

test('Activity reviews an inverse and shows a stale revision without overwriting the task', {timeout:120_000}, async t => {
  const {page} = await openDevelopment(t,{hash:'#/activity'});
  await signIn(page);
  await page.getByRole('heading',{name:'Activity',exact:true}).waitFor();
  await page.getByRole('button',{name:'Review undo'}).click();
  await page.getByRole('button',{name:'Confirm undo'}).click();
  await page.getByRole('alert').filter({hasText:'A newer edit'}).waitFor();
});

test('Projects and Calendar open from planner navigation with the authenticated workspace', {timeout:120_000}, async t => {
  const {page,transport} = await openDevelopment(t,{hash:'#/projects'});
  transport.calendarTray = true;
  await signIn(page);
  await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
  await page.getByRole('link',{name:'Calendar',exact:true}).click();
  await page.getByRole('heading',{name:'Calendar',exact:true}).waitFor();
  await page.getByLabel('Calendar date').waitFor();
  assert.match(await page.getByLabel('Calendar date').inputValue(),/^\d{4}-\d\d-\d\d$/);
});

test('keyboard command search opens the matching task and quick capture from the planner', {timeout:120_000}, async t => {
  const {page,transport} = await openDevelopment(t);
  await signIn(page);
  await page.getByRole('heading',{name:'Inbox',exact:true}).waitFor();
  await page.getByRole('button',{name:'Search and commands'}).focus();
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog',{name:'Search and commands'});
  await dialog.getByLabel('Search workspace').fill('primer');
  await dialog.getByRole('button',{name:'Review primer'}).click();
  const request = await transport.taskRequested.next();
  assert.equal(request.args.publicId,'primer-id');
  const record = task('primer-id','Review primer');
  delete record.source;
  request.respond(record);
  await page.getByText('Source unavailable', {exact:true}).waitFor();
  await page.getByRole('button',{name:'Close task'}).click();
  await page.getByRole('button',{name:'Search and commands'}).click();
  await dialog.getByRole('button',{name:'Quick capture',exact:true}).click();
  await page.waitForURL('**/#/capture');
  await page.waitForFunction(() => globalThis.document.activeElement?.tagName === 'TEXTAREA');
});

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
  const { page, transport } = await openDevelopment(t, { native: true, hash: '' });
  await page.getByRole('heading', { name: 'Klaxon', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Username').count(), 0);
  assert.equal(transport.httpRequests, 0);
  assert.equal(transport.sockets.size, 0);
});

test('Capture saves a free-text thought and Inbox searches, edits, and promotes it with one operation', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/capture', viewport: { width: 390, height: 760 } });
  await signIn(page);
  const body = page.getByLabel('Capture text');
  await body.fill('Follow up with the crew');
  assert.equal(transport.activeQueries(), 0);
  await page.getByRole('button', { name: 'Save capture' }).click();
  const creation = await transport.captureWrites.next();
  assert.deepEqual(creation.args.command, {
    kind: 'capture.create', publicId: creation.args.command.publicId, body: 'Follow up with the crew',
  });
  creation.succeed();
  await page.getByText('Capture saved.').waitFor();
  assert.equal(await body.inputValue(), '');
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  const { args: list } = await transport.captureQueries.next();
  assert.deepEqual(list, { workspaceId: 'personal-workspace', paginationOpts: { cursor: null, numItems: 25 } });
  const created = capture(creation.args.command.publicId, creation.args.command.body);
  const thought = capture('old-thought', 'A thought from the old app', { kind: 'legacy', source: 'thoughts' });
  transport.publishCaptures([created, thought]);
  await page.getByText(thought.body, { exact: true }).waitFor();
  await page.getByText('Legacy thought', { exact: true }).waitFor();
  await page.getByLabel('Search captures').fill('follow up');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  assert.deepEqual((await transport.captureQueries.next()).args, { ...list, text: 'follow up' });
  transport.publishCaptures([created], 'search-next');
  await page.getByRole('button', { name: 'Next capture page' }).click();
  assert.deepEqual((await transport.captureQueries.next()).args, {
    ...list, paginationOpts: { cursor: 'search-next', numItems: 25 }, text: 'follow up',
  });
  transport.publishCaptures([]);
  await page.getByText('No matching captures.').waitFor();
  await page.getByRole('button', { name: 'Previous capture page' }).click();
  await transport.captureQueries.next();
  transport.publishCaptures([created]);

  await page.getByRole('button', { name: 'Edit capture' }).click();
  await page.getByLabel('Capture text').fill('Follow up with the west crew');
  await page.getByLabel('Tags').fill('crew\nfollow-up');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const edit = await transport.captureWrites.next();
  assert.deepEqual(edit.args.command, {
    kind: 'capture.update', publicId: created.publicId, expectedRevision: 1,
    body: 'Follow up with the west crew', tags: ['crew', 'follow-up'],
  });
  const edited = { ...created, body: edit.args.command.body, tags: edit.args.command.tags, revision: 2 };
  edit.succeed([edited]);
  await page.getByText(edited.body, { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Promote to task' }).click();
  await page.getByLabel('Promoted task title').fill('Confirm crew schedule');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const promotion = await transport.captureWrites.next();
  assert.equal(promotion.args.command.expectedRevision, 2);
  assert.equal(promotion.args.command.title, 'Confirm crew schedule');
  promotion.fail();
  await page.getByRole('button', { name: 'Retry capture change' }).click();
  const retry = await transport.captureWrites.next();
  assert.deepEqual(retry.args, promotion.args);
  retry.succeed([{ ...edited, revision: 3, promotedTaskId: 'internal-task-id' }]);
  const createdTask = await page.getByRole('link', { name: 'Open created task' }).getAttribute('href');
  assert.equal(createdTask, `#/tasks/${encodeURIComponent(promotion.args.command.taskPublicId)}`);
  transport.publishCaptures([thought]);
  await page.getByRole('button', { name: 'Archive capture' }).click();
  const archive = await transport.captureWrites.next();
  assert.deepEqual(archive.args.command, { kind: 'capture.archive', publicId: thought.publicId, expectedRevision: 1 });
  archive.succeed([{ ...thought, archivedAt: 2, revision: 2 }]);
  await page.getByText('Capture archived.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Archive capture' }).count(), 0);
});

test('Capture pauses writes offline and resumes an unconfirmed write only for its signed-in owner', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/capture' });
  await signIn(page);
  const body = page.getByLabel('Capture text');
  const save = page.getByRole('button', { name: 'Save capture' });
  await body.fill('Keep this in the owner’s session');
  await page.context().setOffline(true);
  await page.getByText('Offline. Task changes are paused.').waitFor();
  assert.ok(await save.isDisabled());
  assert.equal(await body.inputValue(), 'Keep this in the owner’s session');
  await page.context().setOffline(false);
  await save.click();
  const write = await transport.captureWrites.next();
  transport.expire();
  await page.getByText(/session expired/i).waitFor();

  await signIn(page, 'inert-password', 'test-other');
  assert.equal(await body.inputValue(), '');
  const retry = page.getByRole('button', { name: 'Retry capture change' });
  assert.equal(await retry.count(), 0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();

  await signIn(page);
  await retry.click();
  const resumed = await transport.captureWrites.next();
  assert.deepEqual(resumed.args, write.args);
  resumed.succeed();
  await page.getByText('Capture saved.').waitFor();
  assert.equal(await body.inputValue(), '');
});

test('hash navigation and browser Back keep drafts until resolved and restore task link focus', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/inbox' });
  await signIn(page);
  await transport.queryAdded.next();
  const original = task('crew/brief%', 'Crew brief');
  transport.publish([original]);
  const title = page.getByRole('link', { name: 'Crew brief' });
  await page.getByRole('button', { name: 'Edit Crew brief' }).press('Enter');
  await page.getByLabel('Task title').fill('Unsaved title');
  await page.evaluate(() => { globalThis.location.hash = '#/capture'; });
  await page.getByRole('alert').getByText(/save or discard/i).waitFor();
  assert.equal(new URL(page.url()).hash, '#/inbox');
  assert.equal(await page.getByLabel('Task title').inputValue(), 'Unsaved title');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await title.press('Enter');
  const detail = page.getByRole('region', { name: 'Task details' });
  const requested = await transport.taskRequested.next();
  assert.deepEqual(requested.args, { workspaceId: 'personal-workspace', publicId: 'crew/brief%' });
  requested.respond(original);
  const detailTitle = detail.getByLabel('Title', { exact: true });
  assert.equal(await detailTitle.inputValue(), 'Crew brief');
  assert.equal(new URL(page.url()).hash, '#/tasks/crew%2Fbrief%25');
  await detailTitle.fill('Unsaved detail title');
  await page.evaluate(() => globalThis.history.back());
  await page.getByRole('alert').getByText(/save or discard/i).waitFor();
  await page.waitForURL('**/#/tasks/crew%2Fbrief%25');
  assert.equal(await detailTitle.inputValue(), 'Unsaved detail title');
  await detail.getByRole('button', { name: /close task/i }).click();
  await page.getByRole('button', { name: 'Discard and close' }).click();
  await page.waitForFunction(() => globalThis.document.activeElement?.textContent === 'Crew brief');

  await page.getByRole('link', { name: 'Capture', exact: true }).click();
  await page.getByLabel('Capture text').fill('Keep this draft');
  await page.evaluate(() => globalThis.history.back());
  await page.getByRole('alert').getByText(/save or discard/i).waitFor();
  await page.waitForURL('**/#/capture');
  assert.equal(await page.getByLabel('Capture text').inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Discard capture draft' }).click();
  await page.evaluate(() => globalThis.history.back());
  await page.waitForURL('**/#/inbox');
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  await page.evaluate(() => globalThis.history.forward());
  await page.waitForURL('**/#/capture');
  assert.equal(await page.getByLabel('Capture text').inputValue(), '');
});

test('a direct task permalink survives sign-in at mobile width', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/tasks/from%2Flink', viewport: { width: 390, height: 760 } });
  await signIn(page);
  const requested = await transport.taskRequested.next();
  assert.equal(requested.args.publicId, 'from/link');
  requested.respond(task('from/link', 'Opened from link'));
  const detail = page.getByRole('region', { name: 'Task details' });
  assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), 'Opened from link');
  assert.ok(await page.getByRole('heading', { name: 'Inbox', exact: true }).isHidden());
  await detail.getByRole('button', { name: /close task/i }).click();
  await page.getByRole('heading', { name: 'Inbox', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/inbox');
});

test('Today opens by default, preserves its place around task details, and shows the mobile Schedule tab', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '', viewport: { width: 390, height: 760 } });
  await signIn(page);
  await page.getByRole('heading', { name: 'Today', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/today');
  const today = await transport.agendaRequested.next();
  assert.equal(today.args.workspaceId, 'personal-workspace');
  assert.equal(today.args.timezone, 'UTC');
  const planned = { ...task('planned/today', 'Review the planned checklist'), plannedDate: today.args.localDate };
  const due = { ...task('due-today', 'Submit today’s report'), deadline: { kind: 'date', date: today.args.localDate } };
  today.respond({ planned: [planned], dueToday: [due] });

  const detail = page.getByRole('region', { name: 'Task details' });
  for (const item of [planned, due]) {
    await page.getByText(item.title, { exact: true }).click();
    const requested = await transport.taskRequested.next();
    assert.equal(requested.args.publicId, item.publicId);
    requested.respond(item);
    assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), item.title);
    await detail.getByRole('button', { name: 'Close task' }).click();
    await page.waitForURL('**/#/today');
  }

  await page.getByRole('tab', { name: 'Schedule' }).click();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  assert.ok(await page.getByText(due.title, { exact: true }).isHidden());
  await page.getByRole('tab', { name: 'Tasks' }).click();
  await page.getByText(due.title, { exact: true }).waitFor();
});

test('Upcoming shows its selected week and opens planned task details from a direct route', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/upcoming' });
  await signIn(page);
  await page.getByRole('heading', { name: 'Upcoming', exact: true }).waitFor();
  const upcoming = await transport.upcomingRequested.next();
  const original = task('fleet/check', 'Check the fleet');
  upcoming.respond([{ kind: 'planned', publicId: original.publicId, title: original.title, date: upcoming.args.from }]);
  await page.getByRole('button', { name: original.title }).click();
  const requested = await transport.taskRequested.next();
  assert.equal(requested.args.publicId, original.publicId);
  requested.respond(original);
  const detail = page.getByRole('region', { name: 'Task details' });
  assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), original.title);
  await detail.getByRole('button', { name: 'Close task' }).click();
  await page.waitForURL('**/#/upcoming');
  assert.equal(await page.getByRole('button', { name: original.title }).count(), 1);

  await page.getByRole('button', { name: 'Next week' }).click();
  const next = await transport.upcomingRequested.next();
  assert.equal(Date.parse(next.args.from) - Date.parse(upcoming.args.from), 7 * 86_400_000);
  next.respond([]);
  await page.getByText('Nothing planned or due this week.').waitFor();
});

test('Waiting is reachable from mobile More and opens a task with its follow-up context', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/capture', viewport: { width: 390, height: 760 } });
  await signIn(page);
  await page.getByText('More', { exact: true }).click();
  await page.getByRole('link', { name: 'Waiting', exact: true }).click();
  await page.getByRole('heading', { name: 'Waiting', exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/waiting');
  assert.deepEqual((await transport.queryAdded.next()).args, {
    workspaceId: 'personal-workspace', filter: { kind: 'status', status: 'waiting' }, paginationOpts: { cursor: null, numItems: 25 },
  });
  const waiting = {
    ...task('waiting-task', 'Verify the delivery', 'waiting'), waitingPerson: 'Morgan',
    waitingReason: 'Awaiting tracking number', followUpDate: '2026-12-03',
  };
  transport.publish([waiting]);
  await page.getByText('Morgan · Awaiting tracking number').waitFor();
  await page.getByRole('button', { name: waiting.title }).click();
  const requested = await transport.taskRequested.next();
  assert.equal(requested.args.publicId, waiting.publicId);
  requested.respond(waiting);
  const detail = page.getByRole('region', { name: 'Task details' });
  assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), waiting.title);
  await detail.getByRole('button', { name: 'Close task' }).click();
  await page.waitForURL('**/#/waiting');
  await page.getByRole('button', { name: waiting.title }).waitFor();
  await page.getByRole('link', { name: 'Inbox', exact: true }).click();
  const inbox = await transport.queryAdded.next();
  assert.equal(inbox.args.filter.status, 'inbox');
  assert.equal(transport.activeQueries(), 1);
});

test('task detail retries the original revision and operation after forced reauthentication', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, { hash: '#/tasks/recover-detail' });
  const original = task('recover-detail', 'Original detail', 'inbox', 7);
  const detail = page.getByRole('region', { name: 'Task details' });
  await signIn(page);
  (await transport.taskRequested.next()).respond(original);
  await detail.getByLabel('Title', { exact: true }).fill('Private detail draft');
  await detail.getByRole('button', { name: 'Save task' }).click();
  const initial = await transport.writes.next();
  assert.equal(initial.args.command.expectedRevision, 7);
  transport.expire();
  await page.getByText(/session expired/i).waitFor();
  assert.equal(await detail.count(), 0);
  async function checkOtherScope(username, workspaceId) {
    await signIn(page, 'inert-password', username);
    const requested = await transport.taskRequested.next();
    assert.equal(requested.args.workspaceId, workspaceId);
    requested.respond({ ...original, title: 'Different workspace detail' });
    assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), 'Different workspace detail');
    assert.equal(await detail.getByRole('button', { name: 'Retry change' }).count(), 0);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  }
  await checkOtherScope('test-other', 'other-personal-workspace');
  transport.changeOwnerWorkspace();
  await checkOtherScope('test-owner', 'replacement-workspace');
  transport.restoreOwnerWorkspace();
  await signIn(page);
  (await transport.taskRequested.next()).respond({ ...original, revision: 8 });
  assert.equal(await detail.getByLabel('Title', { exact: true }).inputValue(), 'Private detail draft');
  await detail.getByRole('button', { name: 'Retry change' }).click();
  assert.deepEqual((await transport.writes.next()).args, initial.args);
});

for (const view of [
  { route: 'calendar', edit: 'Scheduling preferences', field: 'Buffer (minutes)', value: '27',
    save: 'Save preferences', retry: 'Retry change', mutation: 'planning:updatePreferences' },
  { route: 'projects', edit: 'New project', field: 'Project name', value: 'Recovered project',
    save: 'Create project', retry: 'Retry project change', mutation: 'tasks:apply' },
  { route: 'reminders', edit: 'New reminder', field: 'Title', value: 'Recovered reminder',
    save: 'Save reminder', retry: 'Retry reminder change', mutation: 'reminders:create' },
]) {
  test(`${view.route} retries the original request after forced reauthentication`, { timeout: 120_000 }, async t => {
    const { page, transport } = await openDevelopment(t, { hash: `#/${view.route}` });
    transport.calendarTray = view.route === 'calendar';
    const field = page.getByLabel(view.field, { exact: true });
    await signIn(page);
    await page.getByRole('button', { name: view.edit, exact: true }).click();
    await field.fill(view.value);
    if (view.route === 'reminders') await page.getByLabel('Due date and time').fill('2099-03-08T10:30');
    await page.getByRole('button', { name: view.save, exact: true }).click();
    const initial = await transport.writes.next();
    assert.equal(initial.name, view.mutation);
    if (view.route === 'calendar') assert.equal(initial.args.expectedRevision, 0);
    transport.expire();
    await page.getByText(/session expired/i).waitFor();
    assert.equal(await field.count(), 0);
    await signIn(page);
    assert.equal(await field.inputValue(), view.value);
    await page.getByRole('button', { name: view.retry, exact: true }).click();
    const retry = await transport.writes.next();
    assert.equal(retry.name, view.mutation);
    assert.deepEqual(retry.args, initial.args);
  });
}

test('touch users can navigate Today, complete a daily task, and return to the planner', { timeout: 120_000 }, async t => {
  const { page, transport } = await openDevelopment(t, {
    hash: '#/capture', touch: true, viewport: { width: 320, height: 760 },
  });
  assert.equal(await page.evaluate(() => globalThis.document.documentElement.clientWidth), 320);
  async function checkAction(action) {
    await action.waitFor();
    await action.scrollIntoViewIfNeeded();
    const bounds = await action.boundingBox();
    const width = await page.evaluate(() => globalThis.document.documentElement.clientWidth);
    assert.ok(bounds && bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
      `Action exceeds the ${width}px viewport: ${JSON.stringify(bounds)}`);
    assert.ok(await action.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(globalThis.document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    }), 'Action center should be reachable');
    assert.ok(await page.evaluate(() => {
      const rootElement = globalThis.document.documentElement;
      return rootElement.scrollWidth <= rootElement.clientWidth;
    }));
  }

  await page.getByLabel('Username').fill('test-owner');
  await page.getByLabel('Password').fill('inert-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).tap();

  const more = page.getByText('More', { exact: true });
  await checkAction(more);
  await more.tap();
  const waiting = page.getByRole('link', { name: 'Waiting', exact: true });
  await checkAction(waiting);
  await waiting.focus();
  await page.keyboard.press('Escape');
  assert.ok(await more.evaluate(element => element === globalThis.document.activeElement));
  await more.tap();
  await waiting.tap();
  await page.getByRole('heading', { name: 'Waiting', exact: true }).waitFor();
  await transport.queryAdded.next();
  transport.publish([]);

  const todayLink = page.getByRole('link', { name: 'Today', exact: true });
  await checkAction(todayLink);
  await todayLink.tap();
  const agenda = await transport.agendaRequested.next();
  const item = { ...task('touch-today', 'Review the daily checklist'), plannedDate: agenda.args.localDate };
  agenda.respond({ planned: [item] });

  const schedule = page.getByRole('tab', { name: 'Schedule', exact: true });
  const tasks = page.getByRole('tab', { name: 'Tasks', exact: true });
  await checkAction(schedule);
  await schedule.tap();
  await page.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  await checkAction(tasks);
  await tasks.tap();

  const opener = page.getByRole('button', { name: item.title, exact: true });
  const detail = page.getByRole('region', { name: 'Task details' });
  const complete = detail.getByRole('button', { name: 'Complete task', exact: true });
  const close = detail.getByRole('button', { name: 'Close task', exact: true });
  await checkAction(opener);
  await opener.tap();
  const request = await transport.taskRequested.next();
  assert.equal(request.args.publicId, item.publicId);
  request.respond(item);
  await checkAction(complete);
  await checkAction(close);
  await page.setViewportSize({ width: 1280, height: 800 });
  await checkAction(complete);
  await checkAction(close);
  await page.setViewportSize({ width: 320, height: 760 });

  await close.press('Enter');
  await page.waitForURL('**/#/today');
  await opener.and(page.locator(':focus')).waitFor();
  await opener.tap();
  const reopened = await transport.taskRequested.next();
  reopened.respond(item);
  await complete.tap();

  const write = await transport.writes.next();
  assert.equal(write.name, 'tasks:apply');
  assert.equal(write.args.command.kind, 'task.update');
  assert.equal(write.args.command.publicId, item.publicId);
  assert.equal(write.args.command.expectedRevision, item.revision);
  assert.deepEqual(write.args.command.patch, { status: 'done' });
  const completed = { ...item, status: 'done', revision: item.revision + 1 };
  write.succeed([completed]);
  reopened.respond(completed);
  await detail.getByText('Task completed.', { exact: true }).waitFor();
  await detail.getByRole('button', { name: 'Reopen task', exact: true }).waitFor();
  agenda.respond({});
  await close.tap();
  await page.waitForURL('**/#/today');
  await tasks.waitFor();
  await page.getByText('No tasks for today.', { exact: true }).waitFor();
});
