import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBuild, requireNewer, releaseNotes } from './prepare-release.mjs';

test('only a successful main build of the exact source revision can ship', () => {
  const good = { id: 8, head_sha: 'a'.repeat(40), head_branch: 'main', conclusion: 'success', status: 'completed', event: 'push' };
  assert.equal(selectBuild([
    { ...good, id: 11, head_sha: 'b'.repeat(40) },
    { ...good, id: 10, conclusion: 'failure' },
    { ...good, id: 9, head_branch: 'unreviewed' }, good,
  ], 'a'.repeat(40)), 8);
  assert.equal(selectBuild([{ ...good, status: 'in_progress' }], good.head_sha), null);
});

test('publication rejects same, older and malformed release versions', () => {
  requireNewer('0.10.4', 'v0.10.3');
  requireNewer('0.11.0', 'v0.10.99');
  for (const version of ['0.10.3', '0.9.9', 'dev']) assert.throws(() => requireNewer(version, 'v0.10.3'));
});

test('release notes must contain the requested dated changelog section', () => {
  const changelog = '# Changelog\n\n## [0.10.4] - 2026-09-14\n\nFixed sync.\n\n## [0.10.3] - 2026-09-13\nOld.\n';
  assert.equal(releaseNotes(changelog, '0.10.4'), 'Fixed sync.');
  assert.throws(() => releaseNotes(changelog, '0.11.0'));
});
