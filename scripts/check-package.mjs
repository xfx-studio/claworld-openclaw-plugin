#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claworldChannelConfigJsonSchema,
  claworldPluginConfigJsonSchema,
} from '../src/openclaw/index.js';
import { CLAWORLD_PUBLIC_TOOL_NAMES } from '../src/openclaw/runtime/tool-inventory.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_PACK_PATHS = Object.freeze([
  'package.json',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'index.js',
  'setup-entry.js',
  'openclaw.plugin.json',
  'skills/claworld-help/SKILL.md',
  'skills/claworld-main-session/SKILL.md',
  'skills/claworld-management-session/SKILL.md',
  'skills/claworld-manage-worlds/SKILL.md',
  'src/openclaw/index.js',
  'src/openclaw/plugin/managed-config.js',
  'src/openclaw/plugin/relay-client.js',
  'src/openclaw/runtime/tool-contracts.js',
  'src/openclaw/runtime/management-report.js',
  'src/openclaw/runtime/transcript-report.js',
  'src/openclaw/runtime/transcript-report-comic-grid.js',
  'src/openclaw/runtime/transcript-report-stylekit.js',
]);

const FORBIDDEN_PACK_PREFIXES = Object.freeze([
  '.github/',
  'scripts/',
  'tests/',
  'node_modules/',
]);

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8'));
}

function run(command, args = [], { cwd = REPO_ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${command} ${args.join(' ')} failed`);
  }

  return result;
}

function npm(args = []) {
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
}

function stableRecord(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

async function main() {
  const packageJson = await readJson('package.json');
  const manifest = await readJson('openclaw.plugin.json');
  const errors = [];

  if (packageJson.name !== '@xfxstudio/claworld') {
    errors.push(`unexpected package name: ${packageJson.name}`);
  }
  if (manifest.version !== packageJson.version) {
    errors.push('openclaw.plugin.json version must match package.json version');
  }
  if (packageJson.private === true) {
    errors.push('plugin package must be publishable');
  }
  if (Object.prototype.hasOwnProperty.call(packageJson, 'bin')) {
    errors.push('plugin package must not expose a bin entry');
  }
  if (packageJson.peerDependencies?.openclaw !== '>=2026.6.11') {
    errors.push('peerDependencies.openclaw must be >=2026.6.11');
  }
  if (packageJson.peerDependenciesMeta?.openclaw?.optional !== true) {
    errors.push('peerDependenciesMeta.openclaw.optional must be true');
  }
  if (
    JSON.stringify(stableRecord(packageJson.dependencies))
    !== JSON.stringify({
      '@iconify-json/twemoji': '1.2.5',
      sharp: '^0.35.3',
      ws: '^8.19.0',
    })
  ) {
    errors.push('runtime dependencies must stay intentionally small');
  }
  if (manifest.id !== 'claworld') {
    errors.push('manifest id must be claworld');
  }
  if (
    JSON.stringify(manifest.contracts?.tools)
    !== JSON.stringify(CLAWORLD_PUBLIC_TOOL_NAMES)
  ) {
    errors.push('manifest contracts.tools must match the public tool inventory');
  }
  if (JSON.stringify(manifest.configSchema) !== JSON.stringify(claworldPluginConfigJsonSchema)) {
    errors.push('manifest configSchema must match plugin schema export');
  }
  if (
    JSON.stringify(manifest.channelConfigs?.claworld?.schema)
    !== JSON.stringify(claworldChannelConfigJsonSchema)
  ) {
    errors.push('manifest claworld channel schema must match plugin schema export');
  }

  const packResult = npm(['pack', '--dry-run', '--json', '--ignore-scripts']);
  const packJson = JSON.parse(packResult.stdout || '[]');
  const packPaths = new Set(
    packJson.flatMap((entry) => Array.isArray(entry.files) ? entry.files.map((file) => file.path) : []),
  );

  for (const requiredPath of REQUIRED_PACK_PATHS) {
    if (!packPaths.has(requiredPath)) errors.push(`missing required pack path: ${requiredPath}`);
  }

  for (const packPath of [...packPaths]) {
    if (FORBIDDEN_PACK_PREFIXES.some((prefix) => packPath.startsWith(prefix))) {
      errors.push(`forbidden pack path: ${packPath}`);
    }
  }

  if (errors.length > 0) {
    console.error('Package check failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log('PASS package boundary check');
}

main().catch((error) => {
  console.error('FAIL package boundary check');
  console.error(error);
  process.exit(1);
});
