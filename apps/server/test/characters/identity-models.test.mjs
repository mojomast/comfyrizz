import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LOCK_PATH = join(REPO_ROOT, 'colab', 'character-identity-models.lock.json');
const BASE_LOCK_PATH = join(REPO_ROOT, 'colab', 'models.lock.json');

const LOCK_TEXT = await readFile(LOCK_PATH, 'utf8');
const LOCK = JSON.parse(LOCK_TEXT);
const BASE_LOCK = JSON.parse(await readFile(BASE_LOCK_PATH, 'utf8'));

const LICENCES = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'CC-BY-4.0']);
const ROLES = new Set(['identity-adapter', 'image-encoder', 'face-encoder']);
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MODEL_FILE = /\.(safetensors|onnx|pt|bin)$/;
const SECRET_KEY = /^(?:token|secret|password|api[_-]?key|access[_-]?key)$/i;

const isRelativePath = value => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0, 'a path cannot be empty');
  assert.ok(!value.startsWith('/'), `absolute path: ${value}`);
  assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `absolute path: ${value}`);
  assert.ok(!value.includes('\\'), `path uses a backslash: ${value}`);
  assert.ok(!value.split('/').includes('..'), `path escapes its root: ${value}`);
  assert.ok(!value.includes('~'), `path uses a home shortcut: ${value}`);
};

const walkKeys = (value, visit) => {
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key);
      walkKeys(child, visit);
    }
  }
};

test('CCL2b: the identity lock is a versioned PuLID document', () => {
  assert.equal(LOCK.schema, 'comfyrizz.character-identity-models/v1');
  assert.equal(LOCK.v, 1);
  assert.equal(LOCK.method, 'pulid');
  assert.match(LOCK.workflow, /^workflows\/[a-z0-9._-]+\.api\.json$/);
  assert.equal(LOCK.baseModels.lock, 'colab/models.lock.json');
  assert.ok(Array.isArray(LOCK.models));
  assert.ok(LOCK.models.length >= 3, 'the identity tier needs an adapter, an image encoder and a face encoder');
  assert.equal(LOCK.policy.commercialUse, true);
});

test('CCL2b: every model pins url, sha256, licence and size', () => {
  for (const model of LOCK.models) {
    assert.match(model.id, ID);
    assert.ok(ROLES.has(model.role), `${model.id}: unknown role ${model.role}`);
    assert.equal(model.repo.split('/').length, 2, `${model.id}: repo must be owner/name`);
    assert.match(model.revision, REVISION, `${model.id}: revision must be a 40-hex commit`);
    assert.match(model.path, MODEL_FILE, `${model.id}: not a weight file`);
    assert.match(model.sha256, SHA256, `${model.id}: sha256 must be 64 lowercase hex`);
    assert.notEqual(model.sha256, '0'.repeat(64), `${model.id}: placeholder sha256`);
    assert.ok(Number.isSafeInteger(model.size) && model.size > 0, `${model.id}: size must be positive bytes`);
    assert.equal(
      model.url,
      `https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.path}`,
      `${model.id}: url must be the pinned file, not a moving branch`,
    );
    isRelativePath(model.path);
    isRelativePath(model.target);
    assert.match(model.target, /^[a-z0-9][a-z0-9._-]*\//, `${model.id}: target needs a folder under ComfyUI/models`);
  }
});

test('CCL2b: only licences that allow commercial use and redistribution are pinned', () => {
  for (const model of LOCK.models) {
    const licence = model.licence;
    assert.equal(typeof licence, 'object', `${model.id}: missing licence`);
    assert.ok(LICENCES.has(licence.id), `${model.id}: licence ${licence.id} is not on the permissive allow-list`);
    assert.doesNotMatch(licence.id, /(?:^|[-_])(?:nc|nd|noncommercial|non-commercial)(?:$|[-_])/i);
    assert.equal(licence.commercial_use, true, `${model.id}: commercial use is not allowed`);
    assert.equal(licence.redistributable, true, `${model.id}: redistribution is not allowed`);
    assert.match(licence.url, /^https:\/\//);
    assert.match(licence.source, /^https:\/\//);
  }
});

test('CCL2b: the graph has one adapter, one image encoder and one face encoder', () => {
  const roles = LOCK.models.map(model => model.role);
  for (const role of ['identity-adapter', 'image-encoder', 'face-encoder']) {
    assert.equal(roles.filter(value => value === role).length, 1, `expected exactly one ${role}`);
  }
});

test('CCL2b: no download or destination is declared twice', () => {
  for (const key of ['id', 'url', 'sha256', 'path']) {
    const values = LOCK.models.map(model => model[key]);
    assert.equal(new Set(values).size, values.length, `duplicate ${key}`);
  }
  const targets = LOCK.models.map(model => model.target);
  assert.equal(new Set(targets).size, targets.length, 'two models cannot claim one ComfyUI path');
});

test('CCL2b: non-commercial alternatives are named and excluded, never downloaded', () => {
  const excluded = LOCK.policy.excluded;
  assert.ok(Array.isArray(excluded) && excluded.length > 0);
  const pinned = new Set(LOCK.models.map(model => model.id));
  for (const entry of excluded) {
    assert.match(entry.id, ID);
    assert.ok(!pinned.has(entry.id), `${entry.id} is both pinned and excluded`);
    assert.match(entry.source, /^https:\/\//);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 20);
    assert.ok(!LICENCES.has(entry.licence), `${entry.licence} cannot be an excluded non-permissive licence`);
  }
});

test('CCL2b: the existing Colab model lock is untouched and separate', () => {
  assert.equal(BASE_LOCK.v, 1);
  assert.equal(BASE_LOCK.files.length, 9);
  assert.equal(
    BASE_LOCK.files.reduce((total, entry) => total + entry.bytes, 0),
    60_019_207_384,
    'colab/models.lock.json must keep the measured GPU-test-3 pin',
  );
  const basePaths = new Set(BASE_LOCK.files.map(entry => entry.path));
  const baseTargets = new Set(BASE_LOCK.files.map(entry => entry.target).filter(Boolean));
  for (const model of LOCK.models) {
    assert.ok(!basePaths.has(model.path), `${model.path} must not be merged into models.lock.json`);
    assert.ok(!baseTargets.has(model.target), `${model.target} must not be merged into models.lock.json`);
  }
});

test('CCL2b: the lock carries no credentials or machine-specific paths', () => {
  assert.doesNotMatch(LOCK_TEXT, /(?:hf_|sk-|ghp_|xox[baprs]-|Bearer\s|-----BEGIN)/);
  assert.doesNotMatch(LOCK_TEXT, /[?&](?:token|key|sig|signature)=/i);
  walkKeys(LOCK, key => assert.doesNotMatch(key, SECRET_KEY, `secret-shaped field: ${key}`));
  for (const model of LOCK.models) {
    for (const value of [model.url, model.path, model.target]) {
      assert.ok(!value.includes('@'), `credentials in ${value}`);
      assert.ok(!value.startsWith('/'), `absolute path in ${value}`);
      assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `absolute path in ${value}`);
    }
  }
});
