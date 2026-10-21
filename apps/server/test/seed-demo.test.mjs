import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEDIA } from '../../../scripts/pip-night-shift/make-media.mjs';
import { TRACKS } from '../../../scripts/pip-night-shift/make-music.mjs';
import { DEMO_CHAT_ID, seedDemoProject } from '../src/seed-demo.mjs';
import { createReferenceStore } from '../src/references/store.mjs';
import { createTakeStore } from '../src/takes/store.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const sourceExample = join(repoRoot, 'examples', 'pip-night-shift');
const sourcePackage = JSON.parse(readFileSync(join(sourceExample, 'package.json'), 'utf8'));
const sourceTakes = JSON.parse(readFileSync(join(sourceExample, 'takes.json'), 'utf8'));
const sourceEditor = JSON.parse(readFileSync(join(sourceExample, 'editor.json'), 'utf8'));
const sourceManifest = JSON.parse(readFileSync(join(sourceExample, 'references', 'manifest.json'), 'utf8'));

function tempDir(t, label) {
  const directory = mkdtempSync(join(tmpdir(), `comfyrizz-${label}-`));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

/** A small example tree with every media file present, so seeding only copies. */
function makeExample(t) {
  const directory = tempDir(t, 'seed-example');
  for (const name of ['package.json', 'takes.json', 'editor.json']) {
    copyFileSync(join(sourceExample, name), join(directory, name));
  }
  write(join(directory, 'references', 'manifest.json'), readFileSync(join(sourceExample, 'references', 'manifest.json')));
  for (const entry of MEDIA) {
    write(join(directory, entry.file), Buffer.from(`placeholder:${entry.id}\n`));
  }
  for (const track of TRACKS) {
    write(join(directory, 'assets', track.file), Buffer.from(`music:${track.id}\n`));
  }
  return directory;
}

function trackingFs(writes) {
  return {
    writeFileSync(path, ...rest) {
      writes.push(resolve(path));
      return writeFileSync(path, ...rest);
    },
    mkdirSync(path, ...rest) {
      writes.push(resolve(path));
      return mkdirSync(path, ...rest);
    },
  };
}

function assertGeneratedPathsInside(writes, runtimeDir) {
  const root = resolve(runtimeDir) + sep;
  for (const path of writes) assert.ok(path.startsWith(root), 'seed writes only inside the runtime');
}

test('PN05: first seed writes the package, media, takes, editor and references', (t) => {
  const exampleDir = makeExample(t);
  const runtimeDir = tempDir(t, 'seed-runtime');
  const writes = [];

  const report = seedDemoProject({ runtimeDir, exampleDir, fs: trackingFs(writes) });

  assert.equal(report.packageId, sourcePackage.id);
  assert.equal(report.chatId, DEMO_CHAT_ID);
  assert.equal(report.noop, false);
  assert.equal(report.changed, true);
  assert.deepEqual(report.generated, []);

  const packagePath = join(runtimeDir, 'packages', `${sourcePackage.id}.json`);
  assert.deepEqual(JSON.parse(readFileSync(packagePath, 'utf8')), sourcePackage);
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, 'takes', `${sourcePackage.id}.json`), 'utf8')), sourceTakes);
  assert.deepEqual(JSON.parse(readFileSync(join(runtimeDir, 'editor', `${sourcePackage.id}.json`), 'utf8')), sourceEditor);

  for (const track of TRACKS) {
    assert.equal(existsSync(join(runtimeDir, 'packages', 'assets', track.file)), true, `${track.file} copied`);
  }
  for (const entry of MEDIA) {
    if (entry.group === 'reference') continue;
    const destination = entry.group === 'character'
      ? join(runtimeDir, 'characters', entry.file.replace(/^characters\//, ''))
      : entry.group === 'clip' || entry.group === 'still'
        ? join(runtimeDir, 'packages', sourcePackage.id, entry.file)
        : join(runtimeDir, 'packages', entry.file);
    assert.equal(existsSync(destination), true, `${entry.file} copied`);
  }

  const referencesPath = join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json');
  const library = JSON.parse(readFileSync(referencesPath, 'utf8'));
  assert.equal(library.schema, 'comfyrizz.reference-library/v1');
  assert.equal(library.chatId, DEMO_CHAT_ID);
  assert.deepEqual(library.references.map((reference) => reference.id), sourceManifest.references.map((reference) => reference.id));
  assert.equal(library.assignments.length, 2);
  for (const reference of library.references) {
    assert.equal(existsSync(join(runtimeDir, 'references', DEMO_CHAT_ID, 'files', reference.file)), true, `${reference.id} media`);
  }

  assertGeneratedPathsInside(writes, runtimeDir);

  const takeStore = createTakeStore({ runtimeDir, packageDir: join(runtimeDir, 'packages') });
  assert.deepEqual(takeStore.read(sourcePackage.id), sourceTakes);
  const referenceStore = createReferenceStore({ rootDir: runtimeDir, chatId: DEMO_CHAT_ID });
  assert.deepEqual(referenceStore.list().map((reference) => reference.id), sourceManifest.references.map((reference) => reference.id));
  assert.equal(referenceStore.assignments().length, 2);
});

test('PN05: a second run is a no-op and never overwrites owner edits', (t) => {
  const exampleDir = makeExample(t);
  const runtimeDir = tempDir(t, 'seed-runtime');
  const first = seedDemoProject({ runtimeDir, exampleDir });
  assert.equal(first.noop, false);

  const packagePath = join(runtimeDir, 'packages', `${sourcePackage.id}.json`);
  const takesPath = join(runtimeDir, 'takes', `${sourcePackage.id}.json`);
  const editorPath = join(runtimeDir, 'editor', `${sourcePackage.id}.json`);
  const referencesPath = join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json');
  const mediaPath = join(runtimeDir, 'packages', 'assets', TRACKS[0].file);

  const ownerPackage = { ...JSON.parse(readFileSync(packagePath, 'utf8')), ownerEdit: 'keep me' };
  write(packagePath, `${JSON.stringify(ownerPackage, null, 2)}\n`);
  write(takesPath, '{"owner":"takes"}\n');
  write(editorPath, '{"owner":"editor"}\n');
  write(referencesPath, '{"owner":"references"}\n');
  appendFileSync(mediaPath, 'owner-media');

  const writes = [];
  const second = seedDemoProject({ runtimeDir, exampleDir, fs: trackingFs(writes) });

  assert.equal(second.noop, true);
  assert.equal(second.changed, false);
  assert.equal(second.written.length, 0);
  assert.deepEqual(writes, []);
  assert.equal(JSON.parse(readFileSync(packagePath, 'utf8')).ownerEdit, 'keep me');
  assert.equal(readFileSync(takesPath, 'utf8'), '{"owner":"takes"}\n');
  assert.equal(readFileSync(editorPath, 'utf8'), '{"owner":"editor"}\n');
  assert.equal(readFileSync(referencesPath, 'utf8'), '{"owner":"references"}\n');
  assert.equal(readFileSync(mediaPath, 'utf8').endsWith('owner-media'), true);
});

test('PN05: existing sidecars are kept when the package is still absent', (t) => {
  const exampleDir = makeExample(t);
  const runtimeDir = tempDir(t, 'seed-runtime');
  const packagePath = join(runtimeDir, 'packages', `${sourcePackage.id}.json`);
  const takesPath = join(runtimeDir, 'takes', `${sourcePackage.id}.json`);
  const editorPath = join(runtimeDir, 'editor', `${sourcePackage.id}.json`);
  const referencesPath = join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json');
  const mediaPath = join(runtimeDir, 'packages', 'assets', TRACKS[0].file);
  write(takesPath, '{"owner":"takes"}\n');
  write(editorPath, '{"owner":"editor"}\n');
  write(referencesPath, '{"owner":"references"}\n');
  write(mediaPath, 'owner-media');

  const report = seedDemoProject({ runtimeDir, exampleDir });

  assert.equal(existsSync(packagePath), true);
  assert.equal(report.noop, false);
  assert.equal(readFileSync(takesPath, 'utf8'), '{"owner":"takes"}\n');
  assert.equal(readFileSync(editorPath, 'utf8'), '{"owner":"editor"}\n');
  assert.equal(readFileSync(referencesPath, 'utf8'), '{"owner":"references"}\n');
  assert.equal(readFileSync(mediaPath, 'utf8'), 'owner-media');
});

test('PN05: a fresh example without generated media gets deterministic placeholders', (t) => {
  const exampleDir = tempDir(t, 'seed-empty-example');
  for (const name of ['package.json', 'takes.json', 'editor.json']) {
    copyFileSync(join(sourceExample, name), join(exampleDir, name));
  }
  write(join(exampleDir, 'references', 'manifest.json'), readFileSync(join(sourceExample, 'references', 'manifest.json')));
  const runtimeDir = tempDir(t, 'seed-runtime');

  const first = seedDemoProject({ runtimeDir, exampleDir });
  assert.ok(first.generated.length > 0, 'missing media is generated');
  const musicPath = join(runtimeDir, 'packages', 'assets', TRACKS[0].file);
  assert.equal(existsSync(musicPath), true);
  const library = JSON.parse(readFileSync(join(runtimeDir, 'references', DEMO_CHAT_ID, 'refs.json'), 'utf8'));
  assert.equal(library.references.length, sourceManifest.references.length);
  for (const reference of library.references) {
    assert.equal(existsSync(join(runtimeDir, 'references', DEMO_CHAT_ID, 'files', reference.file)), true);
  }

  const second = seedDemoProject({ runtimeDir, exampleDir });
  assert.equal(second.noop, true);
  assert.deepEqual(second.generated, []);
});

test('PN05: the seeded report carries no credentials', (t) => {
  const exampleDir = makeExample(t);
  const runtimeDir = tempDir(t, 'seed-runtime');
  const report = seedDemoProject({ runtimeDir, exampleDir });
  const text = JSON.stringify(report);
  for (const pattern of [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /sk-[A-Za-z0-9_-]{6,}/,
    /secret[_-]?key\s*[:=]/i,
  ]) {
    assert.equal(pattern.test(text), false);
  }
  assert.equal(readdirSync(runtimeDir).includes('server-token'), false);
});
