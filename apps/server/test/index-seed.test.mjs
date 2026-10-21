import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_DEMO,
  LAUNCH_DEMO,
  demoMode,
  seedProjects,
} from '../src/index.mjs';
import { DEMO_CHAT_ID } from '../src/seed-demo.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const examplesDir = join(repoRoot, 'examples');
const pipPackage = JSON.parse(readFileSync(join(examplesDir, DEFAULT_DEMO, 'package.json'), 'utf8'));
const launchPackage = JSON.parse(readFileSync(join(examplesDir, LAUNCH_DEMO, 'package.json'), 'utf8'));
const launchAssets = readdirSync(join(examplesDir, LAUNCH_DEMO, 'assets')).sort();

function tempRuntime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'comfyrizz-index-seed-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('PN06: the default boot seeds Pip first and launch-demo as a second project', (t) => {
  const runtimeDir = tempRuntime(t);
  const report = seedProjects({ runtimeDir, examplesDir, env: {}, generateMedia: false });

  assert.equal(report.mode, 'pip');
  assert.deepEqual(report.packageIds, [pipPackage.id, launchPackage.id]);
  assert.equal(report.pip.packageId, pipPackage.id);
  assert.equal(report.launch.packageId, launchPackage.id);

  assert.deepEqual(readJson(join(runtimeDir, 'packages', `${pipPackage.id}.json`)), pipPackage);
  assert.deepEqual(readJson(join(runtimeDir, 'packages', `${launchPackage.id}.json`)), launchPackage);

  assert.equal(existsSync(join(runtimeDir, 'takes', `${pipPackage.id}.json`)), true);
  assert.equal(existsSync(join(runtimeDir, 'editor', `${pipPackage.id}.json`)), true);

  const library = readJson(join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json'));
  assert.equal(library.chatId, DEMO_CHAT_ID);
  assert.ok(library.references.length > 0);

  for (const asset of launchAssets) {
    assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', asset)), true, `${asset} copied`);
  }
});

test('PN06: COMFYRIZZ_DEMO=launch restores the old single launch-demo seed', (t) => {
  const runtimeDir = tempRuntime(t);
  const report = seedProjects({
    runtimeDir,
    examplesDir,
    env: { COMFYRIZZ_DEMO: 'launch' },
    generateMedia: false,
  });

  assert.equal(report.mode, 'launch');
  assert.deepEqual(report.packageIds, [launchPackage.id]);
  assert.equal(report.pip, null);
  assert.equal(report.launch.seeded, true);

  assert.deepEqual(readJson(join(runtimeDir, 'packages', `${launchPackage.id}.json`)), launchPackage);
  assert.equal(existsSync(join(runtimeDir, 'packages', `${pipPackage.id}.json`)), false);
  assert.equal(existsSync(join(runtimeDir, 'takes', `${pipPackage.id}.json`)), false);
  assert.equal(existsSync(join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json')), false);

  for (const asset of launchAssets) {
    assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', asset)), true, `${asset} copied`);
  }
});

test('PN06: only the exact launch value switches modes', () => {
  assert.equal(demoMode({}), 'pip');
  assert.equal(demoMode({ COMFYRIZZ_DEMO: '' }), 'pip');
  assert.equal(demoMode({ COMFYRIZZ_DEMO: 'pip' }), 'pip');
  assert.equal(demoMode({ COMFYRIZZ_DEMO: 'Launch' }), 'pip');
  assert.equal(demoMode({ COMFYRIZZ_DEMO: 'launch' }), 'launch');
});

test('PN06: a second default boot does not overwrite seeded projects', (t) => {
  const runtimeDir = tempRuntime(t);
  const first = seedProjects({ runtimeDir, examplesDir, env: { COMFYRIZZ_DEMO: 'pip' }, generateMedia: false });
  assert.equal(first.pip.noop, false);

  const pipPath = join(runtimeDir, 'packages', `${pipPackage.id}.json`);
  const ownerPackage = { ...readJson(pipPath), ownerEdit: 'keep me' };
  writeFileSync(pipPath, `${JSON.stringify(ownerPackage, null, 2)}\n`);

  const second = seedProjects({ runtimeDir, examplesDir, env: { COMFYRIZZ_DEMO: 'pip' }, generateMedia: false });
  assert.equal(second.pip.noop, true);
  assert.equal(readJson(pipPath).ownerEdit, 'keep me');
});

test('PN06: the seed report contains no credentials', (t) => {
  const runtimeDir = tempRuntime(t);
  const report = seedProjects({ runtimeDir, examplesDir, env: {}, generateMedia: false });
  const text = JSON.stringify(report);
  for (const pattern of [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /sk-[A-Za-z0-9_-]{6,}/,
    /secret[_-]?key\s*[:=]/i,
    /COMFYRIZZ_TOKEN\s*[:=]/,
  ]) {
    assert.equal(pattern.test(text), false);
  }
  assert.equal(readdirSync(runtimeDir).includes('server-token'), false);
});
