import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// These files use plain quoted strings in package tables, not inherited versions.
// Reject unsupported/missing values rather than silently accepting a partial check.
function tomlPackageVersion(text, array = false) {
  const header = array ? /^\[\[package\]\]\s*$/m : /^\[package\]\s*$/m;
  const packages = text.split(header).slice(1).map(block => block.split(/^\[/m)[0]);
  const matches = packages.filter(block => /^name\s*=\s*["']klaxon["']\s*$/m.test(block));
  if (matches.length !== 1) throw new Error('Expected exactly one klaxon package version in Cargo metadata');
  return matches[0].match(/^version\s*=\s*["']([^"']+)["']\s*$/m)?.[1];
}

export async function checkVersions(root = repositoryRoot, tag) {
  const read = path => readFile(join(root, path), 'utf8');
  const [pkg, lock, cargo, cargoLock, tauri] = await Promise.all([
    read('package.json').then(JSON.parse), read('package-lock.json').then(JSON.parse),
    read('src-tauri/Cargo.toml'), read('src-tauri/Cargo.lock'), read('src-tauri/tauri.conf.json').then(JSON.parse),
  ]);
  const version = pkg.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('package.json version must be a stable X.Y.Z release');
  }
  for (const [name, actual] of Object.entries({
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'src-tauri/Cargo.toml': tomlPackageVersion(cargo),
    'src-tauri/Cargo.lock': tomlPackageVersion(cargoLock, true),
    'src-tauri/tauri.conf.json': tauri.version,
  })) if (actual !== version) throw new Error(`${name} version ${actual} does not match ${version}`);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`Release tag ${tag} must equal v${version}`);
  return version;
}

export async function runSteps(steps, cwd = repositoryRoot) {
  for (const [command, args] of steps) {
    console.log(`\n> ${command} ${args.join(' ')}`);
    await new Promise((resolveStep, reject) => {
      const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolveStep() : reject(new Error(`${command} failed (${signal ?? code})`)));
    });
  }
}

function npmStep(script) {
  // .cmd cannot be spawned directly on Windows. Only fixed script names reach
  // cmd.exe; paths and arbitrary arguments never become shell command text.
  return process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${script}`]]
    : ['npm', ['run', script]];
}

async function main() {
  const { values } = parseArgs({ options: {
    'versions-only': { type: 'boolean' }, frontend: { type: 'boolean' }, rust: { type: 'boolean' }, tag: { type: 'string' },
  } });
  if (values.frontend && values.rust) throw new Error('Choose either --frontend or --rust, or omit both for all checks');
  console.log(`Aligned version: ${await checkVersions(repositoryRoot, values.tag)}`);
  if (values['versions-only']) return;
  const steps = [];
  if (!values.rust) {
    const tests = (await readdir(join(repositoryRoot, 'scripts'))).filter(name => name.endsWith('.test.mjs')).sort();
    steps.push([process.execPath, ['--test', ...tests.map(name => `scripts/${name}`)]]);
    for (const script of ['check', 'test', 'build']) steps.push(npmStep(script));
  }
  if (!values.frontend) {
    steps.push(['cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml']]);
    steps.push(['cargo', ['run', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'sync_smoke']]);
  }
  await runSteps(steps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
