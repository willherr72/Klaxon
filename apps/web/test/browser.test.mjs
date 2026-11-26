import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const mount = '/klaxon/foundation/';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
};

async function serveDist(t) {
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
