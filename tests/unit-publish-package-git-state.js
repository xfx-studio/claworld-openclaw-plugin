#!/usr/bin/env node

import assert from 'node:assert/strict';

import { assertReleaseGitState } from '../scripts/publish-package.mjs';

function createGitCommand({ branch = 'staging', status = '', head = 'abc123', remoteHead = head } = {}) {
  return (args) => {
    const command = args.join(' ');
    if (command === 'rev-parse --abbrev-ref HEAD') return { stdout: `${branch}\n` };
    if (command === 'status --porcelain --untracked-files=all') return { stdout: status };
    if (command === `fetch origin ${branch} --quiet`) return { stdout: '' };
    if (command === 'rev-parse HEAD') return { stdout: `${head}\n` };
    if (command === `rev-parse origin/${branch}`) return { stdout: `${remoteHead}\n` };
    throw new Error(`unexpected git command: ${command}`);
  };
}

assert.doesNotThrow(() => assertReleaseGitState({ tag: 'testing', gitCommand: createGitCommand() }));
assert.doesNotThrow(() => assertReleaseGitState({ tag: 'latest', gitCommand: createGitCommand({ branch: 'main' }) }));

assert.throws(
  () => assertReleaseGitState({ tag: 'testing', gitCommand: createGitCommand({ branch: 'feature' }) }),
  /testing releases must run from the staging branch/,
);

assert.throws(
  () => assertReleaseGitState({ tag: 'latest', gitCommand: createGitCommand() }),
  /latest releases must run from the main branch/,
);

assert.throws(
  () => assertReleaseGitState({ tag: 'testing', gitCommand: createGitCommand({ status: '?? local-only.js\n' }) }),
  /working tree must be clean before release/,
);

assert.throws(
  () => assertReleaseGitState({ tag: 'testing', gitCommand: createGitCommand({ remoteHead: 'def456' }) }),
  /staging must match origin\/staging before release/,
);

console.log('PASS unit-publish-package-git-state');
