import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageModelLock, skillsNeeds } from '../src/fasth3-profile.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKILLS = JSON.parse(readFileSync(resolve(ROOT, 'colab/skills-models.lock.json'), 'utf8'));
const BASE = JSON.parse(readFileSync(resolve(ROOT, 'colab/models.lock.json'), 'utf8'));
const DEFAULT = resolve(ROOT, 'colab/models.lock.json');

function loaderNames(file) {
  const names = new Set();
  for (const node of Object.values(JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')))) {
    for (const field of ['unet_name', 'clip_name', 'vae_name', 'bg_removal_name']) {
      const value = node.inputs?.[field];
      if (typeof value === 'string' && value.endsWith('.safetensors')) names.add(value);
    }
  }
  return [...names];
}

test('SPW10: every qwen edit and birefnet loader name has a skills-lock target', () => {
  const targets = new Set(SKILLS.files.map((f) => f.target.split('/').pop()));
  for (const name of [...loaderNames('workflows/qwen_edit_2511_instruct.api.json'), ...loaderNames('workflows/birefnet_image_transparent.api.json')]) {
    assert.ok(targets.has(name), `${name} has no lock target`);
  }
  for (const f of SKILLS.files) assert.ok(Number.isSafeInteger(f.bytes) && f.bytes > 0);
  for (const h of Object.values(SKILLS.hosts)) { assert.match(h.revision, /^[0-9a-f]{40}$/); assert.equal(h.gated, false); }
  assert.equal(SKILLS.customNodes[0].name, 'ComfyUI_Fill-ChatterBox');
});

test('SPW10: the default lock stays Klein + LTX only', () => {
  assert.deepEqual(Object.keys(BASE.hosts).sort(), ['klein', 'ltx']);
  assert.equal(BASE.customNodes, undefined);
});

function pkgDir(pkg) {
  const dir = mkdtempSync(join(tmpdir(), 'spw10-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

test('SPW10: packageModelLock merges only what the package needs', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'spw10s-'));
  const plain = pkgDir({ assets: {}, voice: { engine: 'kokoro' } });
  assert.equal(packageModelLock({ packageDir: plain, scratchDir, repo: ROOT, defaultLock: DEFAULT }), DEFAULT);
  const watched = JSON.parse(readFileSync(packageModelLock({ packageDir: plain, scratchDir, repo: ROOT, defaultLock: DEFAULT, refWatch: true }), 'utf8'));
  assert.ok(watched.hosts.qwenedit && !watched.hosts.birefnet);
  assert.deepEqual(watched.customNodes, []);
  const full = pkgDir({ assets: {}, voice: { engine: 'chatterbox' }, titleCards: [{ stillJobId: 'a', text: 'T' }] });
  const lock = JSON.parse(readFileSync(packageModelLock({ packageDir: full, scratchDir, repo: ROOT, defaultLock: DEFAULT, refWatch: true }), 'utf8'));
  assert.ok(lock.hosts.klein && lock.hosts.ltx && lock.hosts.qwenedit && lock.hosts.birefnet);
  assert.equal(lock.files.length, BASE.files.length + 4);
  assert.equal(lock.customNodes.length, 1);
  assert.deepEqual([...skillsNeeds({ voice: { engine: 'chatterbox' } })], ['chatterbox']);
});
