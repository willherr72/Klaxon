import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { chromium } from 'playwright-core';
import { build } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const origin = 'https://agent-review.test';
let browser;
let assets;

before(async () => {
  const scratch = await mkdtemp(join(webRoot, '.verification-agent-review-'));
  try {
    await Promise.all([
      writeFile(join(scratch, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Plan review</title></head><body><div id="app"></div><script type="module" src="./main.js"></script></body></html>'),
      writeFile(join(scratch, 'main.js'), `import { mount } from 'svelte';
        import Fixture from './Fixture.svelte';
        mount(Fixture, { target: document.querySelector('#app') });`),
      writeFile(join(scratch, 'Fixture.svelte'), `<script>
        import { getFunctionName } from 'convex/server';
        import { ConvexError } from 'convex/values';
        import AgentPlanReview from '../src/settings/AgentPlanReview.svelte';
        const mode = new URLSearchParams(location.search).get('mode');
        let workspaceId = $state('original');
        let dirty = $state(false);
        const subscriptions = new Map();
        const writes = [];
        let expired = 0;
        let release;
        const at = Date.parse;
        let plans = [{ publicId: 'proposal-1', revision: 3, localDate: '2026-11-26', timezone: 'America/Chicago',
          expiresAt: at('2026-11-26T16:30:00Z'), baseDayPlanRevision: 2, agentLabel: 'Operations agent',
          briefing: 'Inspect the pump before testing.', previousBriefing: 'Prepare for maintenance.',
          carryForwards: [{ taskPublicId:'carry', taskTitle:'Service log', expectedRevision:2, fromDate:'2026-11-25', toDate:'2026-11-26' }],
          reason: 'Reserve uninterrupted time for maintenance', focusTasks: [{ taskPublicId: 'pump', taskTitle: 'Inspect pump' }],
          placements: [{ taskPublicId: 'pump', taskTitle: 'Inspect pump', action: 'move', blockPublicId: 'block-1',
            previousStartAt: at('2026-11-26T17:00:00Z'), previousEndAt: at('2026-11-26T18:00:00Z'),
            startAt: at('2026-11-26T19:00:00Z'), endAt: at('2026-11-26T20:00:00Z') }],
          unscheduled: [{ taskPublicId: 'report', taskTitle: 'Write report', reason: 'capacity', remainingMinutes: 30 }] }];
        const publish = () => subscriptions.get('original')?.(plans);
        const client = {
          onUpdate(ref, { workspaceId }, callback) {
            if (getFunctionName(ref) !== 'agentPlans:pending') throw new Error('Unexpected query');
            subscriptions.set(workspaceId, callback);
            queueMicrotask(() => { if (subscriptions.has(workspaceId)) callback(workspaceId === 'original' ? plans : []); });
            return () => subscriptions.delete(workspaceId);
          },
          async mutation(ref, args) {
            const name = getFunctionName(ref);
            writes.push({ name, args });
            if (mode === 'switch') await new Promise((_, reject) => { release = reject; });
            if (mode === 'expired') throw new ConvexError({ code: 'UNAUTHENTICATED' });
            if (mode === 'stale' && name === 'agentPlans:approve') throw new ConvexError({ code: 'PLAN_CONTEXT_CHANGED' });
            plans = [];
            publish();
            if (mode === 'retry' && writes.length === 1) throw new Error('Lost response');
            return { publicId: args.publicId, revision: args.expectedRevision + 1 };
          },
        };
        globalThis.fixture = { writes, expired: () => expired, changeRevision() {
          plans = plans.map(row => ({ ...row, reason: 'Reserve time for the revised plan', revision: 4 }));
          publish();
        }, switchWorkspace: () => workspaceId = 'other', rejectOld: () => release(new ConvexError('UNAUTHENTICATED')) };
      </script>
      <output aria-label="Draft state">{dirty ? 'Dirty' : 'Clean'}</output>
      {#key workspaceId}
        <AgentPlanReview {client} {workspaceId} onDirtyChange={value => dirty = value} onUnauthenticated={() => expired++} />
      {/key}`),
    ]);
    const result = await build({ root: scratch, base: './', configFile: false, plugins: [svelte()], logLevel: 'silent',
      build: { write: false, modulePreload: false } });
    assets = new Map(result.output.map(file => [`/${file.fileName}`, file.source ?? file.code]));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  browser = await chromium.launch({ channel: process.env.KLAXON_BROWSER_CHANNEL });
});

after(() => browser?.close());

async function open(t, mode = '') {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  t.after(() => context.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const body = assets.get(path);
    if (url.origin !== origin || body === undefined) return route.abort();
    await route.fulfill({ body, contentType: path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(2500);
  await page.clock.setFixedTime(new Date('2026-11-26T16:00:00Z'));
  await page.goto(`${origin}/?mode=${mode}`);
  return page;
}

const button = (page, name) => page.getByRole('button', { name, exact: true });
const writes = page => page.evaluate(() => globalThis.fixture.writes);

test('shows proposal effects and requires confirmation of the currently displayed revision', async t => {
  const page = await open(t);
  await page.getByText('Operations agent', { exact: true }).waitFor();
  await page.getByText('Inspect the pump before testing.', {exact:true}).waitFor();
  await page.getByText('Prepare for maintenance.', {exact:true}).waitFor();
  await page.getByText(/Service log.*2026-11-25.*2026-11-26/).waitFor();
  await page.getByText('Reserve uninterrupted time for maintenance', { exact: true }).waitFor();
  await page.getByText(/Move Inspect pump from 11:00\s*AM.*12:00\s*PM.* to 1:00.*2:00\s*PM/).waitFor();
  await page.getByText(/Write report.*Insufficient capacity.*30 min remaining/).waitFor();
  await page.getByText('Add Inspect pump to day focus.').waitFor();
  await button(page, 'Approve').click();
  await button(page, 'Confirm approval').waitFor();
  await page.evaluate(() => globalThis.fixture.changeRevision());
  await page.getByText('Reserve time for the revised plan').waitFor();
  assert.equal(await button(page, 'Confirm approval').count(), 0);
  assert.deepEqual(await writes(page), []);
  await button(page, 'Reject').click();
  await button(page, 'Confirm rejection').click();
  await page.getByText('Proposal rejected.').waitFor();
  const [write] = await writes(page);
  assert.equal(write.name, 'agentPlans:reject');
  assert.equal(write.args.expectedRevision, 4);
  assert.equal(write.args.publicId, 'proposal-1');
});

test('retries an ambiguous approval with the original payload after the proposal leaves the list', async t => {
  const page = await open(t, 'retry');
  await button(page, 'Approve').click();
  await button(page, 'Confirm approval').click();
  await page.getByText('Dirty', { exact: true }).waitFor();
  await button(page, 'Retry decision').click();
  await page.getByText('Proposal approved.').waitFor();
  await page.getByText('Clean', { exact: true }).waitFor();
  const attempts = await writes(page);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].name, 'agentPlans:approve');
  assert.deepEqual(attempts[1], attempts[0]);
  assert.match(attempts[0].args.operationId, /^[\da-f-]{36}$/);
});

test('leaves rejection available when the planner can no longer apply a proposal', async t => {
  const page = await open(t, 'stale');
  await button(page, 'Approve').click();
  await button(page, 'Confirm approval').click();
  await page.getByText('This revision can no longer be applied.').waitFor();
  assert.equal(await button(page, 'Approve').isDisabled(), true);
  await button(page, 'Reject').click();
  await button(page, 'Confirm rejection').click();
  await page.getByText('Proposal rejected.').waitFor();
});

test('clears review state on authentication failure and ignores a result from a previous account', async t => {
  const expired = await open(t, 'expired');
  await button(expired, 'Approve').click();
  await button(expired, 'Confirm approval').click();
  await expired.getByText('Sign in again to review proposals.').waitFor();
  assert.equal(await expired.getByText('Operations agent', { exact: true }).count(), 0);
  assert.equal(await expired.evaluate(() => globalThis.fixture.expired()), 1);

  const switched = await open(t, 'switch');
  await button(switched, 'Approve').click();
  await button(switched, 'Confirm approval').click();
  await switched.evaluate(() => globalThis.fixture.switchWorkspace());
  await switched.getByText('No pending proposals.').waitFor();
  await switched.evaluate(() => globalThis.fixture.rejectOld());
  assert.equal(await switched.getByText('Operations agent', { exact: true }).count(), 0);
  assert.equal(await switched.evaluate(() => globalThis.fixture.expired()), 0);
});
