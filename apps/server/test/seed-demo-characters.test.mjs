import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIBRARY_SCHEMA,
  SeedCharactersError,
  loadExampleCharacters,
  pinProjectSnapshot,
  seedDemoCharacters,
  createCompatCharacterStore,
} from '../src/seed-demo-characters.mjs';
import { validatePackage } from '../../../packages/schema/src/index.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const exampleDir = join(repoRoot, 'examples', 'pip-night-shift');
const sourceLibrary = JSON.parse(readFileSync(join(exampleDir, 'characters', 'library.json'), 'utf8'));
const sourceCharacters = JSON.parse(readFileSync(join(exampleDir, 'characters.json'), 'utf8'));
const sourcePackage = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));

function tempDir(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `comfyrizz-${label}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/**
 * A store with the same narrow contract the seeder expects. It persists to the
 * runtime just like the real store, records every write and exposes the pin
 * hook separately so the tests can prove the seeder never writes by itself.
 */
function makeStore(runtimeDir, { pins = [], writes = [] } = {}) {
  const path = join(runtimeDir, 'characters', 'library.json');
  return {
    kind: 'test',
    libraryPath: path,
    writes,
    pins,
    hasLibrary: () => existsSync(path),
    readLibrary() {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    writeLibrary(library) {
      writes.push(path);
      write(path, `${JSON.stringify(library, null, 2)}\n`);
      return structuredClone(library);
    },
    pinProject(payload) {
      pins.push(structuredClone(payload));
      return payload;
    },
  };
}

function copyExample(t) {
  const directory = tempDir(t, 'seed-characters-example');
  write(join(directory, 'package.json'), readFileSync(join(exampleDir, 'package.json')));
  write(join(directory, 'characters.json'), readFileSync(join(exampleDir, 'characters.json')));
  write(join(directory, 'characters', 'library.json'), readFileSync(join(exampleDir, 'characters', 'library.json')));
  return directory;
}

test('PN11: first seed writes the library through the store and pins the project cast', (t) => {
  const runtimeDir = tempDir(t, 'seed-characters-runtime');
  const pins = [];
  const writes = [];
  const store = makeStore(runtimeDir, { pins, writes });

  const report = seedDemoCharacters({ runtimeDir, exampleDir, store });

  assert.equal(report.packageId, sourcePackage.id);
  assert.equal(report.changed, true);
  assert.equal(report.noop, false);
  assert.deepEqual(report.written, ['characters']);
  assert.deepEqual(report.skipped, []);
  assert.equal(report.store, 'test');
  assert.equal(report.method, 'writeLibrary');
  assert.equal(report.pinMethod, 'pinProject');

  const libraryPath = join(runtimeDir, 'characters', 'library.json');
  assert.deepEqual(writes, [libraryPath]);
  assert.deepEqual(JSON.parse(readFileSync(libraryPath, 'utf8')), sourceLibrary);
  assert.equal(report.libraryPath, libraryPath);

  assert.equal(pins.length, 1);
  assert.equal(pins[0].packageId, sourcePackage.id);
  assert.equal(pins[0].characters.schema, 'comfyrizz.characters/v1');
  assert.deepEqual(pins[0].characters.cast.map((member) => member.castId), ['c_pip', 'c_juno']);
  assert.deepEqual(report.pinned, [
    {
      characterId: 'chr_542077e0091abbc6',
      handle: 'pip',
      revision: 1,
      pinnedRevision: 1,
    },
    {
      characterId: 'chr_94945d9324b614f3',
      handle: 'juno',
      revision: 1,
      pinnedRevision: 1,
    },
  ]);
});

test('PN11: a second run is a no-op and never overwrites owner edits', (t) => {
  const runtimeDir = tempDir(t, 'seed-characters-runtime');
  const firstPins = [];
  const firstWrites = [];
  const first = seedDemoCharacters({
    runtimeDir,
    exampleDir,
    store: makeStore(runtimeDir, { pins: firstPins, writes: firstWrites }),
  });
  assert.equal(first.noop, false);

  const libraryPath = join(runtimeDir, 'characters', 'library.json');
  const ownerEdit = {
    ...JSON.parse(readFileSync(libraryPath, 'utf8')),
    characters: [{ ...sourceLibrary.characters[0], name: 'Pip (owner edit)' }],
  };
  write(libraryPath, `${JSON.stringify(ownerEdit, null, 2)}\n`);

  const pins = [];
  const writes = [];
  const second = seedDemoCharacters({
    runtimeDir,
    exampleDir,
    store: makeStore(runtimeDir, { pins, writes }),
  });

  assert.equal(second.changed, false);
  assert.equal(second.noop, true);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.skipped, ['characters']);
  assert.deepEqual(writes, []);
  assert.deepEqual(pins, []);
  assert.deepEqual(JSON.parse(readFileSync(libraryPath, 'utf8')), ownerEdit);
});

test('PN11: an existing library is left alone even on the first seed', (t) => {
  const runtimeDir = tempDir(t, 'seed-characters-runtime');
  const libraryPath = join(runtimeDir, 'characters', 'library.json');
  const ownerLibrary = { schema: LIBRARY_SCHEMA, synthetic: true, characters: [], owner: true };
  write(libraryPath, `${JSON.stringify(ownerLibrary, null, 2)}\n`);

  const writes = [];
  const pins = [];
  const report = seedDemoCharacters({
    runtimeDir,
    exampleDir,
    store: makeStore(runtimeDir, { pins, writes }),
  });

  assert.equal(report.noop, true);
  assert.deepEqual(report.written, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(pins, []);
  assert.deepEqual(JSON.parse(readFileSync(libraryPath, 'utf8')), ownerLibrary);
});

test('PN11: the example project snapshot is pinned to the library revisions', () => {
  const loaded = loadExampleCharacters({ exampleDir });
  const result = pinProjectSnapshot({
    library: loaded.library,
    characters: loaded.characters,
    packageId: loaded.packageId,
    packageRevision: loaded.packageRevision,
  });

  assert.equal(result.characters.schema, 'comfyrizz.characters/v1');
  assert.equal(result.characters.packageId, sourcePackage.id);
  assert.deepEqual(result.characters.cast.map((member) => member.castId), ['c_pip', 'c_juno']);
  assert.deepEqual(result.characters.placements, [
    { castId: 'c_pip', sceneId: 's2_counter' },
    { castId: 'c_juno', sceneId: 's3_juno' },
  ]);

  for (const member of result.characters.cast) {
    const character = loaded.library.characters.find((entry) => entry.id === member.characterId);
    assert.equal(member.pinnedRevision, character.revision);
    assert.deepEqual(member.snapshot, character);
    assert.equal(member.snapshot.revision, member.pinnedRevision);
  }
  assert.notEqual(result.characters.cast[0].snapshot, loaded.library.characters[0], 'snapshots are copies');
  assert.notEqual(result.characters, loaded.characters, 'the helper returns a new document');
});

test('PN11: a newer library revision does not re-pin an open project', () => {
  const loaded = loadExampleCharacters({ exampleDir });
  const library = structuredClone(loaded.library);
  library.characters[0].revision = 2;
  library.characters[0].name = 'Pip revised';

  const result = pinProjectSnapshot({
    library,
    characters: loaded.characters,
    packageId: loaded.packageId,
  });

  const pip = result.characters.cast.find((member) => member.castId === 'c_pip');
  assert.equal(pip.pinnedRevision, 1);
  assert.deepEqual(pip.snapshot, loaded.library.characters[0]);
  assert.deepEqual(result.pinned[0], {
    characterId: 'chr_542077e0091abbc6',
    handle: 'pip',
    revision: 2,
    pinnedRevision: 1,
  });
});

test('PN11: the cast snapshot is derived from the library when the sidecar is absent', () => {
  const loaded = loadExampleCharacters({ exampleDir });
  const result = pinProjectSnapshot({
    library: loaded.library,
    characters: null,
    packageId: loaded.packageId,
    packageRevision: 1,
  });

  assert.equal(result.characters.schema, 'comfyrizz.characters/v1');
  assert.equal(result.characters.packageId, loaded.packageId);
  assert.equal(result.characters.packageRevision, 1);
  assert.deepEqual(result.characters.cast.map((member) => member.castId), ['c_pip', 'c_juno']);
  assert.deepEqual(result.characters.placements, []);
  for (const member of result.characters.cast) {
    assert.equal(member.detached, false);
    assert.equal(member.orphaned, false);
    assert.equal(member.pinnedRevision, member.revision);
    assert.deepEqual(member.snapshot, loaded.library.characters.find((entry) => entry.id === member.characterId));
  }
});

test('PN11: mismatched snapshots, unknown cast and package drift are rejected', () => {
  const loaded = loadExampleCharacters({ exampleDir });

  const unknown = structuredClone(loaded.characters);
  unknown.cast[0].characterId = 'chr_0000000000000000';
  assert.throws(() => pinProjectSnapshot({
    library: loaded.library,
    characters: unknown,
    packageId: loaded.packageId,
  }), (error) => error instanceof SeedCharactersError && error.code === 'UNKNOWN_CHARACTER');

  const drifted = structuredClone(loaded.characters);
  drifted.cast[0].snapshot.revision = 9;
  assert.throws(() => pinProjectSnapshot({
    library: loaded.library,
    characters: drifted,
    packageId: loaded.packageId,
  }), (error) => error instanceof SeedCharactersError && error.code === 'SNAPSHOT_NOT_PINNED');

  assert.throws(() => pinProjectSnapshot({
    library: loaded.library,
    characters: loaded.characters,
    packageId: 'pkg_somethingelse',
  }), (error) => error instanceof SeedCharactersError && error.code === 'PACKAGE_MISMATCH');
});

test('PN11: the seeded example passes the shared package validator and is unchanged', () => {
  const before = structuredClone(sourcePackage);
  const report = validatePackage(sourcePackage);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);
  assert.deepEqual(sourcePackage, before, 'seeding never mutates the example package');
});

test('PN11: a checkout without the character modules still seeds through the compat store', (t) => {
  const runtimeDir = tempDir(t, 'seed-characters-runtime');
  // Simulate a checkout without characters/store.mjs by handing the seeder the compat store directly.
  const compat = () => createCompatCharacterStore({ runtimeDir });
  const first = seedDemoCharacters({ runtimeDir, exampleDir, store: compat() });
  assert.equal(first.changed, true);
  assert.equal(first.noop, false);
  assert.deepEqual(first.written, ['characters']);

  const libraryPath = join(runtimeDir, 'characters', 'library.json');
  assert.equal(existsSync(libraryPath), true);
  assert.deepEqual(JSON.parse(readFileSync(libraryPath, 'utf8')), sourceLibrary);

  const second = seedDemoCharacters({ runtimeDir, exampleDir, store: compat() });
  assert.equal(second.noop, true);
  assert.deepEqual(second.written, []);
  assert.deepEqual(JSON.parse(readFileSync(libraryPath, 'utf8')), sourceLibrary);
});

test('PN11: the report and both source files carry no credentials', () => {
  const forbidden = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /\bsk-[A-Za-z0-9_-]{6,}\b/,
    /secret[_-]?key\s*[:=]/i,
    /client[_-]?secret\s*[:=]/i,
    /refresh[_-]?token\s*[:=]/i,
  ];
  const sources = [
    join(repoRoot, 'apps', 'server', 'src', 'seed-demo-characters.mjs'),
    join(repoRoot, 'apps', 'server', 'test', 'seed-demo-characters.test.mjs'),
  ];
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${relativeRepo(path)} matches ${pattern}`);
  }

  const loaded = loadExampleCharacters({ exampleDir });
  const report = seedDemoCharacters({
    runtimeDir: join(tmpdir(), 'comfyrizz-report-check'),
    exampleDir,
    store: {
      kind: 'test',
      hasLibrary: () => true,
      readLibrary: () => sourceLibrary,
    },
  });
  const text = JSON.stringify({ loaded: loaded.library, report });
  for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `seeded output matches ${pattern}`);
});

function relativeRepo(path) {
  return resolve(path).slice(repoRoot.length).replace(/^[/\\]/, '');
}

test('PN11: with the merged character store the seeder writes every character through create() and keeps ids', async (t) => {
  const { createCharacterStore } = await import('../src/characters/store.mjs');
  const runtimeDir = tempDir(t, 'seed-characters-real');
  const first = seedDemoCharacters({ runtimeDir, exampleDir });
  assert.equal(first.changed, true);
  assert.deepEqual(first.written, ['characters']);
  assert.equal(first.method, 'create');
  const store = createCharacterStore({ rootDir: runtimeDir });
  const ids = store.list().map(entry => entry.id).sort();
  assert.deepEqual(ids, sourceLibrary.characters.map(c => c.id).sort());
  for (const source of sourceLibrary.characters) {
    const got = store.get(source.id);
    assert.equal(got.name, source.name);
    assert.equal(got.handle, source.handle);
  }
  const second = seedDemoCharacters({ runtimeDir, exampleDir });
  assert.equal(second.noop, true);
  assert.deepEqual(second.written, []);
});
