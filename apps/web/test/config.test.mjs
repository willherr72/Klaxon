import assert from 'node:assert/strict';
import test from 'node:test';
import { developmentOrigin } from '../build-config.mjs';

test('local builds ignore the hosted origin from the environment', () => {
  assert.equal(developmentOrigin('production', 'https://example.convex.cloud'), undefined);
  assert.equal(developmentOrigin('offline', 'invalid'), undefined);
});

test('Development accepts a plain HTTPS Convex deployment origin', () => {
  const origin = 'https://klaxon-dev-123.convex.cloud';
  assert.equal(developmentOrigin('development', origin), origin);
  const longest = 'https://' + 'a'.repeat(63) + '.convex.cloud';
  assert.equal(developmentOrigin('development', longest), longest);
});

test('Development rejects missing or noncanonical origins without exposing their values', () => {
  const invalid = [
    undefined,
    '',
    'http://klaxon-dev.convex.cloud',
    'https://localhost',
    'https://one.two.convex.cloud',
    'https://' + 'a'.repeat(64) + '.convex.cloud',
    'https://dev.convex.cloud.attacker.example',
    'https://dev.convex.cloud:443',
    'https://dev.convex.cloud/',
    'https://dev.convex.cloud/path',
    'https://dev.convex.cloud?token=secret',
    'https://dev.convex.cloud#fragment',
    'https://secret@dev.convex.cloud',
    'https://dev.convex.cloud\n',
  ];

  for (const origin of invalid) {
    assert.throws(() => developmentOrigin('development', origin), {
      message: 'KLAXON_PUBLIC_DEV_ORIGIN must be a plain HTTPS Convex deployment origin',
    });
  }
});
