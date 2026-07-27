#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const REGISTRY = 'https://registry.npmjs.org';
const RELEASE_TIME_ZONE = process.env.CLAWORLD_RELEASE_TIME_ZONE || 'Asia/Shanghai';

function usage() {
  return [
    'Usage: node scripts/publish-package.mjs --tag latest|testing [--dry-run]',
    '',
    'latest  requires yyyy.m.d for the current release date.',
    'testing requires yyyy.m.d-testing.N for the current release date.',
  ].join('\n');
}

function parseArgs(argv = []) {
  const options = { tag: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--tag') {
      options.tag = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (!['latest', 'testing'].includes(options.tag)) {
    throw new Error(`--tag must be latest or testing.\n${usage()}`);
  }
  return options;
}

function run(command, args = [], { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${command} ${args.join(' ')} failed`);
  }
  return result;
}

function npm(args = [], options = {}) {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}

function git(args = [], options = {}) {
  return run('git', args, options);
}

function commandOutput(result) {
  return String(result?.stdout || '').trim();
}

export function assertReleaseGitState({ tag, gitCommand = git } = {}) {
  const expectedBranch = tag === 'latest' ? 'main' : 'staging';
  const branch = commandOutput(gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }));
  if (branch !== expectedBranch) {
    throw new Error(`${tag} releases must run from the ${expectedBranch} branch; found ${branch || 'unknown'}`);
  }

  const status = commandOutput(gitCommand(['status', '--porcelain', '--untracked-files=all'], { capture: true }));
  if (status) {
    throw new Error(`working tree must be clean before release:\n${status}`);
  }

  gitCommand(['fetch', 'origin', expectedBranch, '--quiet']);
  const head = commandOutput(gitCommand(['rev-parse', 'HEAD'], { capture: true }));
  const remoteHead = commandOutput(gitCommand(['rev-parse', `origin/${expectedBranch}`], { capture: true }));
  if (!head || head !== remoteHead) {
    throw new Error(`${expectedBranch} must match origin/${expectedBranch} before release; local=${head || 'unknown'} remote=${remoteHead || 'unknown'}`);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function currentReleaseDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: RELEASE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
  };
}

function sameDate(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function parseStableVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(version);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseTestingVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-testing\.(\d+)$/.exec(version);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    sequence: Number(match[4]),
  };
}

function assertVersionForTag({ tag, version }) {
  const releaseDate = currentReleaseDate();
  const expected = `${releaseDate.year}.${releaseDate.month}.${releaseDate.day}`;
  if (tag === 'latest') {
    const parsed = parseStableVersion(version);
    if (!parsed || !sameDate(parsed, releaseDate)) {
      throw new Error(`latest publishes must use ${expected}; found ${version}`);
    }
    return;
  }

  const parsed = parseTestingVersion(version);
  if (!parsed || parsed.sequence < 1 || !sameDate(parsed, releaseDate)) {
    throw new Error(`testing publishes must use ${expected}-testing.N; found ${version}`);
  }
}

function exactVersionExists(packageName, version) {
  const result = npm(['view', `${packageName}@${version}`, 'version', '--registry', REGISTRY], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 && String(result.stdout || '').trim() === version;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertReleaseGitState({ tag: options.tag });
  const packageJson = await readJson('package.json');
  const manifest = await readJson('openclaw.plugin.json');

  if (manifest.version !== packageJson.version) {
    throw new Error('openclaw.plugin.json version must match package.json version');
  }
  assertVersionForTag({ tag: options.tag, version: packageJson.version });
  if (exactVersionExists(packageJson.name, packageJson.version)) {
    throw new Error(`${packageJson.name}@${packageJson.version} already exists on npm`);
  }

  npm(['test']);
  npm(['run', 'check:package']);

  const publishArgs = ['publish', '--tag', options.tag, '--access', 'public', '--registry', REGISTRY];
  if (options.dryRun) publishArgs.push('--dry-run');
  npm(publishArgs);
}

if (path.resolve(process.argv[1] || '') === SCRIPT_PATH) {
  main().catch((error) => {
    console.error('FAIL publish');
    console.error(error);
    process.exit(1);
  });
}
