import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAndroidMetadata, validateWindowsVersion, createManifest } from './release-check.mjs';

const cert = 'd2464b90aecb56ac935fb44bad67a8388c618f8ef906996a20cde0f57ebc0fe5';
const badging = "package: name='com.klaxon.app' versionCode='10003' versionName='0.10.3' platformBuildVersionName='15'\n native-code: 'arm64-v8a'\n";
const signature = `Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: ${cert}\n`;

test('APK metadata accepts the production arm64 package and signing identity', () => {
  assert.deepEqual(validateAndroidMetadata(badging, signature, '0.10.3', 10003), {
    package: 'com.klaxon.app', versionName: '0.10.3', versionCode: 10003,
    abis: ['arm64-v8a'], signatureVerified: true, certificateSha256: cert,
  });
});

for (const [name, bad, sig] of [
  ['package', badging.replace('com.klaxon.app', 'com.attacker.app'), signature],
  ['versionName', badging.replace("versionName='0.10.3'", "versionName='0.10.2'"), signature],
  ['versionCode', badging.replace('10003', '10002'), signature],
  ['extra ABI', badging.replace("'arm64-v8a'", "'arm64-v8a' 'x86_64'"), signature],
  ['missing ABI', badging.replace(" native-code: 'arm64-v8a'", ''), signature],
  ['wrong certificate', badging, signature.replace(cert, '0'.repeat(64))],
  ['unsigned', badging, 'DOES NOT VERIFY'],
  ['multiple signers', badging, signature.replace('Number of signers: 1', 'Number of signers: 2')],
]) test(`rejects APK ${name}`, () => assert.throws(() => validateAndroidMetadata(bad, sig, '0.10.3', 10003)));

test('unsigned build inspection is explicitly marked unverified', () => {
  const metadata = validateAndroidMetadata(badging, null, '0.10.3', 10003, true);
  assert.equal(metadata.signatureVerified, false);
  assert.equal(metadata.certificateSha256, null);
});

test('Windows file version matches all components including revision', () => {
  assert.equal(validateWindowsVersion('0.10.3.0', '0.10.3'), '0.10.3.0');
  assert.throws(() => validateWindowsVersion('0.10.2.0', '0.10.3'));
  assert.throws(() => validateWindowsVersion('0.10.3.1', '0.10.3'));
  assert.throws(() => validateWindowsVersion('', '0.10.3'));
});

test('manifest binds files to validated metadata, hashes, version, and commit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'klaxon-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = 'a'.repeat(40);
  const windowsFile = join(root, 'Klaxon_0.10.3_x64-setup.exe');
  const androidFile = join(root, 'klaxon-0.10.3-arm64.apk');
  await writeFile(windowsFile, 'abc');
  await writeFile(androidFile, 'abc');
  const common = { schemaVersion: 1, version: '0.10.3', commit, size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
  const windowsReport = join(root, 'windows.json');
  const androidReport = join(root, 'android.json');
  await writeFile(windowsReport, JSON.stringify({ ...common, platform: 'windows', file: 'Klaxon_0.10.3_x64-setup.exe', fileVersion: '0.10.3.0' }));
  const android = { ...common, platform: 'android', file: 'klaxon-0.10.3-arm64.apk', package: 'com.klaxon.app', versionName: '0.10.3', versionCode: 10003, abis: ['arm64-v8a'], signatureVerified: true, certificateSha256: cert };
  await writeFile(androidReport, JSON.stringify(android));
  const options = { windowsFile, windowsReport, androidFile, androidReport, version: '0.10.3', versionCode: 10003, tag: 'v0.10.3', commit };
  const result = await createManifest(options);
  assert.equal(result.assets.length, 2);
  assert.equal(result.tag, 'v0.10.3');
  await assert.rejects(createManifest({ ...options, commit: 'b'.repeat(40) }), /commit/i);
  for (const mutation of [{ signatureVerified: false }, { certificateSha256: '0'.repeat(64) }, { versionCode: 10002 }, { abis: ['arm64-v8a', 'x86_64'] }, { file: 'wrong.apk' }]) {
    await writeFile(androidReport, JSON.stringify({ ...android, ...mutation }));
    await assert.rejects(createManifest(options));
  }
  await writeFile(androidReport, JSON.stringify(android));
  await writeFile(windowsFile, 'abd');
  await assert.rejects(createManifest(options), /hash/i);
  assert.equal((await readFile(androidFile)).toString(), 'abc');
});
