import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHARACTER_LIBRARY_SCHEMA,
  CharacterStoreError,
  MAX_REVISION_SNAPSHOTS,
  createCharacterStore,
} from '../../src/characters/store.mjs';

const FIXED_TIME = '2026-10-21T12:00:00.000Z';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const clock = () => new Date(FIXED_TIME);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'comfyrizz-character-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pngBytes(width = 4, height = 3, marker = 0) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  ihdr[21] = marker & 0xff;
  return Buffer.concat([PNG_SIGNATURE, ihdr]);
}

function idSource() {
  let sequence = 0;
  return () => {
    sequence += 1;
    return sequence.toString(16).padStart(16, '0');
  };
}

function makeStore(root, extra = {}) {
  return createCharacterStore({ rootDir: root, clock, randomId: idSource(), ...extra });
}

function filesIn(dir) {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test('CC03: create writes the library index, character and revision 1 with mode 0600', t => {
  const root = tempDir(t);
  const store = makeStore(root);

  assert.equal(store.dir, join(root, 'characters'));
  assert.equal(store.libraryPath, join(root, 'characters', 'library.json'));
  assert.equal(store.schema, CHARACTER_LIBRARY_SCHEMA);

  const character = store.create({
    name: 'Pip',
    role: 'mascot',
    summary: 'Round coffee bean',
    visual: { identityPrompt: 'glossy brown bean' },
  });

  assert.match(character.id, /^chr_[0-9a-f]{16}$/);
  assert.equal(character.schema, 'comfyrizz.character/v1');
  assert.equal(character.revision, 1);
  assert.equal(character.name, 'Pip');
  assert.equal(character.handle, 'pip');
  assert.equal(character.role, 'mascot');
  assert.equal(character.createdAt, FIXED_TIME);
  assert.equal(character.updatedAt, FIXED_TIME);

  assert.deepEqual(store.get(character.id), character);
  assert.deepEqual(store.list(), [character]);
  assert.deepEqual(store.index(), [{
    id: character.id,
    name: 'Pip',
    handle: 'pip',
    revision: 1,
    updatedAt: FIXED_TIME,
  }]);

  const characterDir = join(store.dir, character.id);
  assert.equal(existsSync(join(characterDir, 'character.json')), true);
  assert.equal(existsSync(join(characterDir, 'revisions', '1.json')), true);
  assert.equal(existsSync(join(characterDir, 'images')), true);
  assert.equal(statSync(store.libraryPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(characterDir, 'character.json')).mode & 0o777, 0o600);

  const library = JSON.parse(readFileSync(store.libraryPath, 'utf8'));
  assert.equal(library.schema, CHARACTER_LIBRARY_SCHEMA);
  assert.equal(library.characters.length, 1);

  assert.equal(store.get('chr_0000000000000000'), null);
  assert.throws(
    () => store.get('../../etc/passwd'),
    error => error instanceof CharacterStoreError && error.code === 'INVALID_ID',
  );
});

test('CC03: create keeps names and handles unique and rejects non-fictional kinds', t => {
  const store = makeStore(tempDir(t));

  assert.equal(store.create({ name: 'Pip' }).name, 'Pip');
  const second = store.create({ name: '  pip  ' });
  assert.equal(second.name, 'pip 2');
  assert.equal(second.handle, 'pip-2');

  const explicit = store.create({ name: 'Mocha', handle: 'pip' });
  assert.equal(explicit.handle, 'pip_2');

  assert.throws(
    () => store.create({ name: 'Real Person', kind: 'real_authorized' }),
    error => error instanceof CharacterStoreError
      && error.code === 'CHAR_KIND_UNSUPPORTED',
  );
});

test('CC03: update deep-merges patches, bumps the revision and keeps the last ten snapshots', t => {
  const store = makeStore(tempDir(t));
  const created = store.create({
    name: 'Pip',
    visual: {
      identityPrompt: 'brown bean',
      palette: ['#5b3a1e'],
      wardrobe: [{ id: 'w1', label: 'apron', prompt: 'green apron' }],
    },
    bible: { personality: 'upbeat' },
    tags: ['coffee'],
  });

  const updated = store.update(created.id, {
    summary: 'Now with a hat',
    visual: { negative: 'no text' },
    bible: { speakingStyle: 'short' },
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.revision, 2);
  assert.equal(updated.summary, 'Now with a hat');
  assert.equal(updated.visual.identityPrompt, 'brown bean');
  assert.equal(updated.visual.negative, 'no text');
  assert.deepEqual(updated.visual.palette, ['#5b3a1e']);
  assert.equal(updated.visual.wardrobe[0].id, 'w1');
  assert.equal(updated.bible.personality, 'upbeat');
  assert.equal(updated.bible.speakingStyle, 'short');
  assert.deepEqual(updated.tags, ['coffee']);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, FIXED_TIME);

  assert.deepEqual(store.getRevision(created.id, 1), created);
  assert.deepEqual(store.getRevision(created.id, 2), updated);

  for (let revision = 3; revision <= 13; revision += 1) {
    store.update(created.id, { summary: `revision ${revision}` });
  }

  assert.equal(store.get(created.id).revision, 13);
  assert.deepEqual(
    store.revisionNumbers(created.id),
    Array.from({ length: MAX_REVISION_SNAPSHOTS }, (_, index) => index + 4),
  );
  assert.equal(store.getRevision(created.id, 3), null);
  assert.equal(store.getRevision(created.id, 4).summary, 'revision 4');
  assert.equal(store.getRevision(created.id, 13).summary, 'revision 13');
  assert.deepEqual(
    filesIn(join(store.dir, created.id, 'revisions')),
    Array.from({ length: MAX_REVISION_SNAPSHOTS }, (_, index) => `${index + 4}.json`).sort(),
  );
  assert.equal(store.listRevisions(created.id).length, MAX_REVISION_SNAPSHOTS);

  assert.throws(
    () => store.update(created.id, { sha256: 'f'.repeat(64) }),
    error => error instanceof CharacterStoreError
      && error.code === 'CHAR_UNKNOWN_FIELD'
      && error.field === 'sha256',
  );
  assert.throws(
    () => store.update('chr_0000000000000000', { summary: 'nope' }),
    error => error instanceof CharacterStoreError && error.code === 'NOT_FOUND',
  );
});

test('CC03: addImage dedupes by sha, reuses probe dimensions and keeps one primary', t => {
  const store = makeStore(tempDir(t));
  const created = store.create({ name: 'Pip' });

  const first = store.addImage(created.id, {
    bytes: pngBytes(8, 6, 1),
    filename: 'front.png',
    view: 'front',
    source: 'upload',
  });

  assert.match(first.imgId, /^img_[0-9a-f]{16}$/);
  assert.equal(first.sha256.length, 64);
  assert.equal(first.view, 'front');
  assert.equal(first.source, 'upload');
  assert.equal(first.primary, true);
  assert.equal(first.width, 8);
  assert.equal(first.height, 6);
  assert.equal(existsSync(join(store.dir, created.id, 'images', `${first.imgId}.png`)), true);

  const afterFirst = store.get(created.id);
  assert.equal(afterFirst.revision, 2);
  assert.deepEqual(afterFirst.visual.images, [first]);

  const duplicate = store.addImage(created.id, {
    bytes: pngBytes(8, 6, 1),
    filename: 'renamed.png',
    view: 'side',
    primary: true,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(store.get(created.id).revision, 2);
  assert.equal(filesIn(join(store.dir, created.id, 'images')).length, 1);

  const second = store.addImage(created.id, {
    bytes: pngBytes(8, 6, 2),
    view: 'three_quarter',
    primary: true,
  });
  assert.equal(second.primary, true);
  const afterSecond = store.get(created.id);
  assert.equal(afterSecond.revision, 3);
  assert.equal(afterSecond.visual.images.length, 2);
  assert.equal(afterSecond.visual.images.find(image => image.imgId === first.imgId).primary, false);
  assert.equal(afterSecond.visual.images.find(image => image.imgId === second.imgId).primary, true);

  assert.throws(
    () => store.addImage(created.id, { bytes: Buffer.from('not an image'), filename: 'x.png' }),
    error => error instanceof CharacterStoreError && error.code === 'UNSUPPORTED_TYPE',
  );
  assert.throws(
    () => store.addImage('chr_0000000000000000', { bytes: pngBytes() }),
    error => error instanceof CharacterStoreError && error.code === 'NOT_FOUND',
  );
});

test('CC03: a character holds at most eight images', t => {
  const store = makeStore(tempDir(t));
  const created = store.create({ name: 'Pip' });

  for (let marker = 1; marker <= 8; marker += 1) {
    store.addImage(created.id, { bytes: pngBytes(4, 3, marker) });
  }
  assert.equal(store.get(created.id).visual.images.length, 8);

  assert.throws(
    () => store.addImage(created.id, { bytes: pngBytes(4, 3, 9) }),
    error => error instanceof CharacterStoreError
      && error.code === 'LIMIT'
      && error.limit === 8,
  );
});

test('CC03: the fifty-first character is rejected with LIMIT', t => {
  const store = makeStore(tempDir(t));

  for (let index = 1; index <= 50; index += 1) {
    store.create({ name: `Character ${index}` });
  }
  assert.equal(store.list().length, 50);

  assert.throws(
    () => store.create({ name: 'Character 51' }),
    error => error instanceof CharacterStoreError
      && error.code === 'LIMIT'
      && error.limit === 50,
  );
  assert.equal(store.list().length, 50);
});

test('CC03: remove deletes the character directory and index entry', t => {
  const store = makeStore(tempDir(t));
  const kept = store.create({ name: 'Kept' });
  const removed = store.create({ name: 'Removed' });

  assert.equal(store.remove(removed.id), true);
  assert.equal(store.get(removed.id), null);
  assert.equal(existsSync(join(store.dir, removed.id)), false);
  assert.deepEqual(store.list().map(character => character.id), [kept.id]);
  assert.equal(store.remove(removed.id), false);

  const library = JSON.parse(readFileSync(store.libraryPath, 'utf8'));
  assert.deepEqual(library.characters.map(entry => entry.id), [kept.id]);
});

test('CC03: atomic writes keep the previous record when a rename crashes', t => {
  const root = tempDir(t);
  let crash = false;
  const flakyFs = {
    renameSync(from, to) {
      if (crash && to.endsWith('character.json')) {
        const error = new Error('simulated crash');
        error.code = 'EIO';
        throw error;
      }
      return fs.renameSync(from, to);
    },
  };

  const store = makeStore(root, { fs: flakyFs });
  const created = store.create({ name: 'Pip', summary: 'before' });
  const libraryBefore = readFileSync(store.libraryPath, 'utf8');

  crash = true;
  assert.throws(
    () => store.update(created.id, { summary: 'after' }),
    error => error.code === 'EIO',
  );

  assert.deepEqual(store.get(created.id), created);
  assert.equal(store.get(created.id).revision, 1);
  assert.equal(readFileSync(store.libraryPath, 'utf8'), libraryBefore);
  assert.equal(JSON.parse(readFileSync(store.libraryPath, 'utf8')).characters[0].revision, 1);
  assert.deepEqual(filesIn(join(store.dir, created.id)).filter(name => name.endsWith('.tmp')), []);
  assert.deepEqual(store.revisionNumbers(created.id), [1]);

  crash = false;
  const updated = store.update(created.id, { summary: 'after' });
  assert.equal(updated.revision, 2);
  assert.equal(store.get(created.id).summary, 'after');
});

test('CC03: paths that escape the library or its real root are refused', t => {
  const root = tempDir(t);
  const outside = tempDir(t);
  const store = makeStore(root);
  const created = store.create({ name: 'Pip' });

  assert.throws(
    () => store.create({ id: '../escape', name: 'Bad' }),
    error => error instanceof CharacterStoreError && error.code === 'CHAR_INVALID_ID',
  );

  const images = join(store.dir, created.id, 'images');
  rmSync(images, { recursive: true, force: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, images);

  assert.throws(
    () => store.addImage(created.id, { bytes: pngBytes(2, 2, 7) }),
    error => error instanceof CharacterStoreError && error.code === 'PATH_ESCAPE',
  );
  assert.deepEqual(readdirSync(outside), []);
});
