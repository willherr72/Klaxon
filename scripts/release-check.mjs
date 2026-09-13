import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkVersions, repositoryRoot } from './verify.mjs';

const productionCertificate = 'd2464b90aecb56ac935fb44bad67a8388c618f8ef906996a20cde0f57ebc0fe5';
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function assetName(platform, version) {
  return platform === 'windows' ? `Klaxon_${version}_x64-setup.exe` : `klaxon-${version}-arm64.apk`;
}
function validateAndroidFields(metadata, version, versionCode, allowUnsigned = false) {
  requireThat(metadata.package === 'com.klaxon.app', 'APK package must be com.klaxon.app');
  requireThat(metadata.versionName === version, 'APK versionName mismatch');
  requireThat(metadata.versionCode === versionCode, 'APK versionCode mismatch');
  requireThat(Array.isArray(metadata.abis) && metadata.abis.length === 1 && metadata.abis[0] === 'arm64-v8a', 'APK must contain only arm64-v8a native code');
  if (!allowUnsigned) {
    requireThat(metadata.signatureVerified === true, 'APK signature is not verified');
    requireThat(metadata.certificateSha256 === productionCertificate, 'APK signing certificate does not match the production identity');
  }
}

export function validateAndroidMetadata(badging, signature, version, versionCode, allowUnsigned = false) {
  const packageLine = badging.match(/^package: (.+)$/m)?.[1] ?? '';
  const field = name => packageLine.match(new RegExp(`(?:^| )${name}='([^']*)'`))?.[1];
  const nativeLine = badging.match(/^\s*native-code:\s*(.+)$/m)?.[1] ?? '';
  const metadata = {
    package: field('name'), versionName: field('versionName'), versionCode: Number(field('versionCode')),
    abis: [...nativeLine.matchAll(/'([^']+)'/g)].map(match => match[1]),
    signatureVerified: false, certificateSha256: null,
  };
  if (!allowUnsigned) {
    requireThat(typeof signature === 'string' && /^Verifies\s*$/m.test(signature), 'APK signature verification did not succeed');
    requireThat(/^Number of signers: 1\s*$/m.test(signature), 'APK must have exactly one signer');
    const certificates = [...signature.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$/gm)];
    requireThat(certificates.length === 1, 'APK must have exactly one signing certificate');
    metadata.signatureVerified = true;
    metadata.certificateSha256 = certificates[0][1].toLowerCase();
  }
  validateAndroidFields(metadata, version, versionCode, allowUnsigned);
  return metadata;
}

export function validateWindowsVersion(fileVersion, version) {
  requireThat(fileVersion === `${version}.0`, `Windows installer FileVersion ${fileVersion} must equal ${version}.0`);
  return fileVersion;
}

async function fileMetadata(file) {
  const info = await stat(file);
  requireThat(info.isFile() && info.size > 0, `Artifact must be a nonempty file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { file: basename(file), size: info.size, sha256: hash.digest('hex') };
}

export async function createManifest({ windowsFile, windowsReport, androidFile, androidReport, version, versionCode, tag, commit }) {
  requireThat(tag === `v${version}`, 'Release tag mismatch');
  requireThat(/^[a-f0-9]{40}$/.test(commit ?? ''), 'A full lowercase source commit SHA is required');
  const assets = [];
  for (const [platform, file, reportPath] of [['windows', windowsFile, windowsReport], ['android', androidFile, androidReport]]) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    const actual = await fileMetadata(file);
    requireThat(report.schemaVersion === 1 && report.platform === platform, `Invalid ${platform} report`);
    requireThat(report.version === version, `${platform} report version mismatch`);
    requireThat(report.commit === commit, `${platform} report source commit mismatch`);
    requireThat(actual.file === assetName(platform, version) && report.file === actual.file, `${platform} asset name mismatch`);
    requireThat(report.sha256 === actual.sha256 && report.size === actual.size, `${platform} artifact hash/size mismatch`);
    if (platform === 'windows') validateWindowsVersion(report.fileVersion, version);
    else validateAndroidFields(report, version, versionCode);
    assets.push(report);
  }
  return { schemaVersion: 1, version, tag, commit, assets };
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, env, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  requireThat(result.status === 0, `${basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    tag: { type: 'string' }, commit: { type: 'string' }, file: { type: 'string' }, output: { type: 'string' },
    aapt: { type: 'string' }, apksigner: { type: 'string' }, 'allow-unsigned': { type: 'boolean' },
    'windows-file': { type: 'string' }, 'windows-report': { type: 'string' },
    'android-file': { type: 'string' }, 'android-report': { type: 'string' },
  } });
  requireThat(positionals.length === 1 && ['versions', 'windows', 'android', 'manifest'].includes(positionals[0]), 'Use versions, windows, android, or manifest');
  const mode = positionals[0];
  const version = await checkVersions(repositoryRoot, values.tag);
  if (mode === 'versions') { console.log(version); return; }
  const commit = values.commit ?? process.env.GITHUB_SHA;
  requireThat(/^[a-f0-9]{40}$/.test(commit ?? ''), 'Pass --commit with the full lowercase source commit SHA (or set GITHUB_SHA)');
  requireThat(values.output, '--output is required');
  const config = JSON.parse(await readFile(join(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  requireThat(!config.bundle?.android?.autoIncrementVersionCode, 'Release validation requires deterministic Android versionCode');
  // Tauri's documented default: major * 1000000 + minor * 1000 + patch.
  const [major, minor, patch] = version.split('.').map(Number);
  const versionCode = config.bundle?.android?.versionCode ?? major * 1000000 + minor * 1000 + patch;
  requireThat(Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode <= 2100000000, 'Invalid Android versionCode');
  let report;
  if (mode === 'manifest') {
    requireThat(!values['allow-unsigned'], 'Publication manifest cannot allow unsigned APKs');
    for (const flag of ['windows-file', 'windows-report', 'android-file', 'android-report', 'tag']) requireThat(values[flag], `--${flag} is required`);
    report = await createManifest({ windowsFile: values['windows-file'], windowsReport: values['windows-report'], androidFile: values['android-file'], androidReport: values['android-report'], version, versionCode, tag: values.tag, commit });
  } else {
    requireThat(values.file, '--file is required');
    requireThat(basename(values.file) === assetName(mode, version), `Expected asset name ${assetName(mode, version)}`);
    let metadata;
    if (mode === 'windows') {
      requireThat(process.platform === 'win32', 'Windows installer validation requires Windows');
      const fileVersion = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; $installerInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:KLAXON_INSTALLER_CHECK_PATH); '{0}.{1}.{2}.{3}' -f $installerInfo.FileMajorPart, $installerInfo.FileMinorPart, $installerInfo.FileBuildPart, $installerInfo.FilePrivatePart"], { ...process.env, KLAXON_INSTALLER_CHECK_PATH: resolve(values.file) }).trim();
      metadata = { fileVersion: validateWindowsVersion(fileVersion, version) };
    } else {
      requireThat(values.aapt, '--aapt is required');
      const badging = run(values.aapt, ['dump', 'badging', resolve(values.file)]);
      let signature = null;
      if (!values['allow-unsigned']) {
        requireThat(values.apksigner, '--apksigner is required for signed validation');
        const args = ['verify', '--verbose', '--print-certs', resolve(values.file)];
        // Run the JAR behind the Windows batch wrapper, keeping paths out of a shell.
        signature = /\.bat$/i.test(values.apksigner)
          ? run(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'java.exe') : 'java', ['-jar', join(dirname(values.apksigner), 'lib', 'apksigner.jar'), ...args])
          : run(values.apksigner, args);
      }
      metadata = validateAndroidMetadata(badging, signature, version, versionCode, values['allow-unsigned']);
    }
    report = { schemaVersion: 1, platform: mode, version, commit, ...await fileMetadata(values.file), ...metadata };
  }
  await mkdir(dirname(resolve(values.output)), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
