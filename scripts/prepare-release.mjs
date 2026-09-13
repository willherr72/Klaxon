import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { checkVersions } from './verify.mjs';

export function selectBuild(runs, commit) {
  return runs.filter(run => run.head_sha === commit && run.head_branch === 'main'
    && ['push', 'workflow_dispatch'].includes(run.event)
    && run.status === 'completed' && run.conclusion === 'success')
    .sort((a, b) => b.id - a.id)[0]?.id ?? null;
}

export function requireNewer(version, latestTag) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw Error(`Invalid release version: ${value}`);
    return value.split('.').map(Number);
  };
  const current = parse(version);
  const previous = parse(latestTag.replace(/^v/, ''));
  const different = current.findIndex((part, i) => part !== previous[i]);
  if (different < 0 || current[different] < previous[different]) throw Error('A published update must have a strictly newer version');
}

export function releaseNotes(changelog, version) {
  const heading = new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] [—-] \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
  const match = heading.exec(changelog);
  if (!match) throw Error(`Missing dated changelog entry for ${version}`);
  const notes = changelog.slice(match.index + match[0].length).split(/^## /m)[0].trim();
  if (!notes) throw Error('Release notes must not be empty');
  return notes;
}

export function verifyRemoteTag(remote, tag, commit) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[a-f0-9]{40}$/.test(commit)) throw Error('Invalid tag or source commit');
  const ref = `refs/tags/${tag}`;
  const lines = execFileSync('git', ['ls-remote', '--tags', remote, ref, `${ref}^{}`], { encoding: 'utf8' });
  const refs = new Map(lines.trim().split('\n').filter(Boolean).map(line => {
    const [sha, name] = line.trim().split(/\s+/);
    return [name, sha];
  }));
  const actual = refs.get(`${ref}^{}`) ?? refs.get(ref);
  if (actual !== commit) throw Error(`Remote tag is missing or moved; ${tag} must match ${commit}`);
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_OUTPUT: output } = process.env;
  if (!repository || !token || !output) throw Error('This preflight runs inside GitHub Actions');
  const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  git(['merge-base', '--is-ancestor', commit, 'origin/main']);
  const version = await checkVersions();
  const tag = `v${version}`;
  const publish = process.env.PUBLISH_RELEASE === 'true';
  const finalCheck = process.argv.includes('--final-check');
  if (publish && (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== tag)) {
    throw Error('Publication requires the matching version tag on main');
  }
  const api = async path => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`GitHub API ${response.status} for ${path}`);
    return response.json();
  };
  if (publish) {
    verifyRemoteTag('origin', tag, commit);
    if (!finalCheck && await api(`releases/tags/${tag}`)) throw Error(`${tag} already exists; releases are never overwritten`);
    const latest = await api('releases/latest');
    if (latest) requireNewer(version, latest.tag_name);
  }
  if (finalCheck) {
    if (!publish) throw Error('Final publication check requires PUBLISH_RELEASE=true');
    return;
  }
  await writeFile('release-notes.md', releaseNotes(await readFile('CHANGELOG.md', 'utf8'), version));
  let runId;
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await api(`actions/workflows/build.yml/runs?head_sha=${commit}&per_page=100`);
    runId = selectBuild(result?.workflow_runs ?? [], commit);
    if (runId) break;
    console.log('Waiting for a successful Build workflow for this exact main commit...');
    await setTimeout(15000);
  }
  if (!runId) throw Error('No successful matching Build run. Run Build on main, then retry this workflow.');
  const artifacts = await api(`actions/runs/${runId}/artifacts`);
  for (const name of ['klaxon-windows-x64', 'klaxon-android-arm64-unsigned']) {
    if (!artifacts?.artifacts.some(item => item.name === name && !item.expired)) {
      throw Error(`${name} expired or missing. Run Build on main again before releasing.`);
    }
  }
  await appendFile(output, `commit=${commit}\nversion=${version}\ntag=${tag}\nbuild_run=${runId}\npublish=${publish}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
