import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBuild, requireNewer, releaseNotes, verifyRemoteTag } from './prepare-release.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

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

test('remote lightweight and annotated tags must still point at the validated commit', async () => {
  const prefix = join(tmpdir(), 'klaxon-release-tag-');
  const directory = await mkdtemp(prefix);
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init']);
    git(['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '--allow-empty', '-m', 'first']);
    const first = git(['rev-parse', 'HEAD']);
    git(['tag', 'v0.10.4']);
    verifyRemoteTag(directory, 'v0.10.4', first);
    git(['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'tag', '-a', 'v0.10.5', '-m', 'annotated']);
    verifyRemoteTag(directory, 'v0.10.5', first);
    git(['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '--allow-empty', '-m', 'second']);
    git(['tag', '-f', 'v0.10.4']);
    assert.throws(() => verifyRemoteTag(directory, 'v0.10.4', first), /moved|match/);
    assert.throws(() => verifyRemoteTag(directory, 'v9.9.9', first), /missing|match/);
  } finally {
    if (!resolve(directory).startsWith(resolve(prefix))) throw Error('Unexpected fixture path');
    await rm(directory, { recursive: true, force: true });
  }
});
