import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ASSET_KINDS,
  LIBRARY_SCHEMA,
  assetRef,
  hashFile,
  parseRef,
  resolveAsset,
  resolveAssets,
  validateLibrary,
  verifyAssetFiles,
} from './asset-library.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SCRIPT_DIR, 'fixtures', 'library.json');

function loadFixture() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function withTempDir(fn) {
  const root = mkdtempSync(join(tmpdir(), 'asset-library-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('fixture validates and locks the raccoon portrait, sandwich and cardigan', () => {
  const lib = loadFixture();
  assert.equal(lib.schema, LIBRARY_SCHEMA);
  const result = validateLibrary(lib);
  assert.deepEqual(result, { ok: true, errors: [] });

  const portrait = resolveAsset(lib, 'raccoon_portrait@1');
  assert.ok(portrait, 'raccoon_portrait@1 must resolve');
  assert.equal(portrait.kind, 'artwork');
  assert.match(portrait.notes, /robe/i);
  assert.match(portrait.notes, /frame/i);
  assert.match(portrait.sha256, /^[0-9a-f]{64}$/);

  const sandwich = resolveAsset(lib, 'sandwich_01@1');
  assert.ok(sandwich, 'sandwich_01@1 must resolve');
  assert.equal(sandwich.kind, 'prop');

  const cardigan = resolveAsset(lib, 'paid_leave_cardigan@1');
  assert.ok(cardigan, 'paid_leave_cardigan@1 must resolve');
  assert.equal(cardigan.kind, 'costume');

  for (const asset of lib.assets) {
    assert.ok(ASSET_KINDS.includes(asset.kind), `${asset.id} kind`);
    assert.ok(asset.file.startsWith('assets/'), `${asset.id} file must stay repo-relative`);
  }
});

test('parseRef accepts versioned ids and rejects malformed refs', () => {
  assert.deepEqual(parseRef('raccoon_portrait@1'), { id: 'raccoon_portrait', version: 1 });
  assert.deepEqual(parseRef('sandwich_01@12'), { id: 'sandwich_01', version: 12 });
  assert.equal(parseRef('raccoon_portrait'), null);
  assert.equal(parseRef('raccoon_portrait@'), null);
  assert.equal(parseRef('@1'), null);
  assert.equal(parseRef('raccoon_portrait@0'), null);
  assert.equal(parseRef('Raccoon@1'), null);
  assert.equal(parseRef('a@1@2'), null);
  assert.equal(parseRef(''), null);
  assert.equal(parseRef(7), null);
  assert.equal(parseRef(null), null);
});

test('assetRef builds the canonical id@version string', () => {
  const lib = loadFixture();
  assert.equal(assetRef(resolveAsset(lib, 'raccoon_portrait@1')), 'raccoon_portrait@1');
  assert.equal(assetRef({ id: 'sandwich_01', version: 3 }), 'sandwich_01@3');
  assert.equal(assetRef({ id: 'sandwich_01' }), null);
  assert.equal(assetRef(null), null);
});

test('resolveAsset returns the exact version and reports unknown versions as null', () => {
  const lib = loadFixture();
  const portrait = resolveAsset(lib, 'raccoon_portrait@1');
  assert.equal(portrait.version, 1);
  assert.equal(resolveAsset(lib, 'raccoon_portrait@9'), null);
  assert.equal(resolveAsset(lib, 'raccoon_portrait@0'), null);
  assert.equal(resolveAsset(lib, 'sandwich_02@1'), null);
  assert.equal(resolveAsset(lib, 'raccoon_portrait'), null);
  assert.equal(resolveAsset(lib, 'raccoon_portrait@x'), null);
  assert.equal(resolveAsset(null, 'raccoon_portrait@1'), null);
});

test('resolveAssets separates resolved refs from unknown ones', () => {
  const lib = loadFixture();
  const { resolved, unknown } = resolveAssets(lib, [
    'raccoon_portrait@1',
    'raccoon_portrait@2',
    'sandwich_01@1',
    'missing_prop@1',
  ]);
  assert.deepEqual(resolved.map(assetRef), ['raccoon_portrait@1', 'sandwich_01@1']);
  assert.deepEqual(unknown, ['raccoon_portrait@2', 'missing_prop@1']);
  assert.deepEqual(resolveAssets(lib, []), { resolved: [], unknown: [] });
  assert.deepEqual(resolveAssets(lib, 'raccoon_portrait@1'), { resolved: [], unknown: [] });
});

test('duplicate id@version is rejected', () => {
  const lib = clone(loadFixture());
  lib.assets.push(clone(lib.assets[0]));
  const { ok, errors } = validateLibrary(lib);
  assert.equal(ok, false);
  const duplicate = errors.find((error) => error.code === 'DUPLICATE_ID_VERSION');
  assert.ok(duplicate, 'a DUPLICATE_ID_VERSION error is reported');
  assert.equal(duplicate.path, `/assets/${lib.assets.length - 1}`);
  assert.match(duplicate.message, /raccoon_portrait@1/);
});

test('different versions of one id are not duplicates', () => {
  const lib = clone(loadFixture());
  const second = clone(lib.assets[0]);
  second.version = 2;
  second.file = 'assets/raccoon_portrait@2.png';
  lib.assets.push(second);
  const { ok, errors } = validateLibrary(lib);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
  assert.equal(assetRef(resolveAsset(lib, 'raccoon_portrait@2')), 'raccoon_portrait@2');
});

test('invalid field values are rejected with JSON paths', () => {
  const base = () => clone(loadFixture());

  const badKind = base();
  badKind.assets[0].kind = 'painting';
  assertValidateError(badKind, '/assets/0/kind', 'INVALID_KIND');

  const badVersion = base();
  badVersion.assets[0].version = 0;
  assertValidateError(badVersion, '/assets/0/version', 'INVALID_VERSION');

  const badSha = base();
  badSha.assets[1].sha256 = 'DEADBEEF';
  assertValidateError(badSha, '/assets/1/sha256', 'INVALID_SHA256');

  const noApprover = base();
  delete noApprover.assets[2].approvedBy;
  assertValidateError(noApprover, '/assets/2/approvedBy', 'INVALID_APPROVER');

  const absoluteFile = base();
  absoluteFile.assets[0].file = '/tmp/raccoon.png';
  assertValidateError(absoluteFile, '/assets/0/file', 'INVALID_FILE');

  const escapeFile = base();
  escapeFile.assets[0].file = '../outside/raccoon.png';
  assertValidateError(escapeFile, '/assets/0/file', 'INVALID_FILE');

  const badSchema = base();
  badSchema.schema = 'comfyrizz.asset-library/v2';
  assertValidateError(badSchema, '/schema', 'SCHEMA_MISMATCH');

  const noAssets = { schema: LIBRARY_SCHEMA, assets: {} };
  assertValidateError(noAssets, '/assets', 'INVALID_ASSETS');

  assert.equal(validateLibrary(null).ok, false);
  assert.equal(validateLibrary([]).ok, false);
  assert.equal(validateLibrary({ schema: LIBRARY_SCHEMA }).errors[0].code, 'INVALID_ASSETS');
});

function assertValidateError(lib, path, code) {
  const { ok, errors } = validateLibrary(lib);
  assert.equal(ok, false);
  const match = errors.find((error) => error.path === path && error.code === code);
  assert.ok(match, `expected ${code} at ${path}, got ${JSON.stringify(errors)}`);
}

test('validateLibrary and resolveAsset do not mutate the library', () => {
  const lib = loadFixture();
  const before = clone(lib);
  validateLibrary(lib);
  resolveAsset(lib, 'raccoon_portrait@1');
  resolveAssets(lib, ['raccoon_portrait@1', 'nope@1']);
  assert.deepEqual(lib, before);
});

test('hashFile uses the injected fs and matches node:crypto', () => {
  const calls = [];
  const fakeFs = {
    readFileSync(path) {
      calls.push(path);
      return Buffer.from('abc');
    },
  };
  const expected = createHash('sha256').update('abc').digest('hex');
  assert.equal(hashFile('virtual/blob.png', { fs: fakeFs }), expected);
  assert.deepEqual(calls, ['virtual/blob.png']);

  withTempDir((root) => {
    const file = join(root, 'blob.bin');
    writeFileSync(file, 'abc');
    assert.equal(hashFile(file), expected);
  });

  assert.throws(() => hashFile('', { fs: fakeFs }), TypeError);
  assert.throws(() => hashFile('x.png', { fs: {} }), TypeError);
});

test('hash mismatch and missing files are reported with manifest-relative paths', () => {
  const approvedBytes = Buffer.from('approved portrait bytes');
  const lib = {
    schema: LIBRARY_SCHEMA,
    assets: [
      {
        id: 'raccoon_portrait',
        version: 1,
        kind: 'artwork',
        label: 'Courtroom raccoon portrait',
        file: 'assets/raccoon_portrait@1.png',
        sha256: createHash('sha256').update(approvedBytes).digest('hex'),
        approvedBy: 'continuity-lead',
      },
      {
        id: 'work_stoppage_sign',
        version: 1,
        kind: 'sign',
        label: 'Work stoppage notice',
        file: 'assets/work_stoppage_sign@1.png',
        sha256: createHash('sha256').update('notice bytes').digest('hex'),
        approvedBy: 'picture-editor',
      },
    ],
  };

  withTempDir((root) => {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'raccoon_portrait@1.png'), 'a regenerated impostor');

    const { ok, findings } = verifyAssetFiles(lib, { root });
    assert.equal(ok, false);

    const mismatch = findings.find((finding) => finding.code === 'HASH_MISMATCH');
    assert.ok(mismatch, 'a HASH_MISMATCH finding is reported');
    assert.equal(mismatch.id, 'raccoon_portrait');
    assert.equal(mismatch.version, 1);
    assert.equal(mismatch.file, 'assets/raccoon_portrait@1.png');
    assert.equal(mismatch.expected, lib.assets[0].sha256);
    assert.equal(mismatch.actual, createHash('sha256').update('a regenerated impostor').digest('hex'));

    const missing = findings.find((finding) => finding.code === 'FILE_MISSING');
    assert.ok(missing, 'a FILE_MISSING finding is reported');
    assert.equal(missing.id, 'work_stoppage_sign');
    assert.equal(missing.file, 'assets/work_stoppage_sign@1.png');

    const serialized = JSON.stringify(findings);
    assert.equal(serialized.includes(root), false, 'findings must not leak absolute paths');
  });
});

test('verifyAssetFiles passes when every file matches its declared hash', () => {
  const bytes = { 'assets/raccoon_portrait@1.png': 'portrait', 'assets/sandwich_01@1.png': 'sandwich' };
  const lib = {
    schema: LIBRARY_SCHEMA,
    assets: Object.entries(bytes).map(([file, content], index) => ({
      id: index === 0 ? 'raccoon_portrait' : 'sandwich_01',
      version: 1,
      kind: index === 0 ? 'artwork' : 'prop',
      label: file,
      file,
      sha256: createHash('sha256').update(content).digest('hex'),
      approvedBy: 'continuity-lead',
    })),
  };

  withTempDir((root) => {
    mkdirSync(join(root, 'assets'), { recursive: true });
    for (const [file, content] of Object.entries(bytes)) {
      writeFileSync(join(root, file), content);
    }
    assert.deepEqual(verifyAssetFiles(lib, { root }), { ok: true, findings: [] });
  });

  const fakeFs = {
    readFileSync(path) {
      const name = path.split('/').pop();
      return Buffer.from(bytes[`assets/${name}`]);
    },
  };
  assert.deepEqual(verifyAssetFiles(lib, { fs: fakeFs, root: '/unused' }), { ok: true, findings: [] });
});

test('verifyAssetFiles reports unverifiable entries instead of skipping them', () => {
  const lib = clone(loadFixture());
  lib.assets[0].file = '/absolute/escape.png';
  lib.assets[1].sha256 = 'not-a-hash';
  lib.assets.push(null);

  const { ok, findings } = verifyAssetFiles(lib, { root: '/unused' });
  assert.equal(ok, false);
  const unverifiable = findings.filter((finding) => finding.code === 'UNVERIFIABLE');
  assert.deepEqual(unverifiable, [
    { path: '/assets/0', id: 'raccoon_portrait', version: 1, file: '/absolute/escape.png', expected: lib.assets[0].sha256, code: 'UNVERIFIABLE', actual: null },
    { path: '/assets/1', id: 'sandwich_01', version: 1, file: 'assets/sandwich_01@1.png', expected: 'not-a-hash', code: 'UNVERIFIABLE', actual: null },
    { path: '/assets/6', id: null, version: null, file: null, expected: null, code: 'UNVERIFIABLE', actual: null },
  ]);
});
