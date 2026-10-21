import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(new URL('package.json', exampleDir));
const library = readJson(new URL('characters/library.json', exampleDir));
const characters = readJson(new URL('characters.json', exampleDir));

const HEX64 = /^[0-9a-f]{64}$/;
const CHARACTER_ID = /^chr_[0-9a-f]{16}$/;
const IMAGE_ID = /^img_[0-9a-f]{16}$/;

let merged = null;
let mergedSkip = false;
try {
  const [model, cast, build] = await Promise.all([
    import('../../src/characters/model.mjs'),
    import('../../src/characters/cast.mjs'),
    import('../../src/characters/build.mjs'),
  ]);
  merged = { model, cast, build };
} catch (error) {
  const missingCharacters = error?.code === 'ERR_MODULE_NOT_FOUND'
    && /characters[\\/](?:model|cast|build)\.mjs/.test(error.message);
  if (!missingCharacters) throw error;
  mergedSkip = 'character-creator modules are not present in this checkout (after-CC dependency)';
}

const needsMerged = mergedSkip ? { skip: mergedSkip } : {};

function allStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => allStrings(item, out));
  return out;
}

const byName = new Map(library.characters.map((character) => [character.name, character]));

test('PN10: library is the merged character-library shape with fictional Pip and Juno', () => {
  assert.equal(library.schema, 'comfyrizz.character-library/v1');
  assert.equal(library.synthetic, true);
  assert.equal(library.characters.length, 2);
  assert.deepEqual(library.characters.map((character) => character.name), ['Pip', 'Juno']);

  for (const character of library.characters) {
    assert.equal(character.schema, 'comfyrizz.character/v1');
    assert.equal(character.kind, 'fictional');
    assert.match(character.id, CHARACTER_ID);
    assert.equal(character.handle, character.name.toLowerCase());
    assert.match(character.summary, /fictional/i);
    assert.match(character.summary, /not a real person/i);

    const images = character.visual.images;
    assert.equal(images.length, 1);
    assert.equal(images.filter((image) => image.primary === true).length, 1);
    assert.equal(images[0].imgId, `img_${images[0].sha256.slice(0, 16)}`);
    assert.match(images[0].imgId, IMAGE_ID);
    assert.match(images[0].sha256, HEX64);
    assert.equal(images[0].source, 'generated');
    assert.equal(images[0].width, 768);
    assert.equal(images[0].height, 768);
    assert.equal(character.visual.identity.method, 'klein_ref');
    assert.equal(character.voice.engine, 'none');
  }

  assert.equal(byName.get('Pip').role, 'mascot');
  assert.equal(byName.get('Juno').role, 'supporting');
  assert.match(byName.get('Juno').visual.identityPrompt, /yellow/i);
});

test('PN10: each library record loads through the merged character model', needsMerged, () => {
  for (const character of library.characters) {
    const parsed = merged.model.makeCharacter(character);
    assert.deepEqual(parsed, character);
    assert.equal(merged.model.primaryImage(parsed).sha256, character.visual.images[0].sha256);
  }
});

test('PN10: characters.json is the sidecar of the merged applyCast build', needsMerged, () => {
  const entries = library.characters.map((character) => merged.cast.makeCastEntry(character));
  const placements = characters.placements.map((placement) => ({ ...placement, confirmed: true }));
  const result = merged.build.applyCast(pkg, entries, placements);

  assert.deepEqual(result.characters, characters);
  assert.equal(result.characters.schema, merged.build.CHARACTERS_SCHEMA);
  assert.equal(result.characters.packageId, pkg.id);
  assert.deepEqual(result.characters.cast.map((member) => member.castId), ['c_pip', 'c_juno']);
  assert.deepEqual(result.characters.placements, [
    { castId: 'c_pip', sceneId: 's2_counter' },
    { castId: 'c_juno', sceneId: 's3_juno' },
  ]);
  assert.deepEqual(result.ignored, []);
  assert.deepEqual(result.warnings, []);
});

test('PN10: the package build gets cast[], s2 Pip, s3 Juno and fictional flags', needsMerged, () => {
  const before = structuredClone(pkg);
  const entries = library.characters.map((character) => merged.cast.makeCastEntry(character));
  const placements = characters.placements.map((placement) => ({ ...placement, confirmed: true }));
  const result = merged.build.applyCast(pkg, entries, placements);

  assert.deepEqual(pkg, before, 'the build does not mutate the example package');

  assert.deepEqual(result.pkg.cast.map((member) => member.id), ['c_pip', 'c_juno']);
  assert.deepEqual(result.pkg.cast.map((member) => member.name), ['Pip', 'Juno']);
  assert.match(result.pkg.cast[0].description, /fictional/i);
  assert.match(result.pkg.cast[1].description, /fictional/i);

  assert.deepEqual(result.pkg.scenes[1].cast, ['c_pip'], 's2_counter shows Pip');
  assert.deepEqual(result.pkg.scenes[2].cast, ['c_juno'], 's3_juno shows Juno');
  assert.equal(result.pkg.scenes[0].cast, undefined, 's1_dawn has no cast');
  assert.equal(result.pkg.scenes[3].cast, undefined, 's4_outro has no cast');
  for (const member of result.pkg.cast) {
    const asset = result.pkg.assets[member.ref_asset];
    assert.ok(asset, `${member.id} ref_asset is in the built package`);
    assert.equal(asset.kind, 'image');
    assert.equal(asset.status, 'ready');
    assert.equal(asset.license.id, 'CC0-1.0');
    assert.equal(asset.redistributable, true);
    assert.match(asset.sha256, HEX64);
    assert.match(asset.file, /^assets\/a_chr_[0-9a-f]{16}\.png$/);
  }
});

test('PN10: the built package passes the shared package validator', needsMerged, async () => {
  const { validatePackage } = await import('../../../../packages/schema/src/index.mjs');
  const entries = library.characters.map((character) => merged.cast.makeCastEntry(character));
  const placements = characters.placements.map((placement) => ({ ...placement, confirmed: true }));
  const result = merged.build.applyCast(pkg, entries, placements);

  const report = validatePackage(result.pkg);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);
  assert.equal(report.schemaOk, true);
});

test('PN10: unconfirmed placements do not add a scene cast', needsMerged, () => {
  const entries = library.characters.map((character) => merged.cast.makeCastEntry(character));
  const placements = characters.placements.map((placement) => ({ ...placement, confirmed: false }));
  const result = merged.build.applyCast(pkg, entries, placements);

  assert.deepEqual(result.pkg.cast.map((member) => member.id), ['c_pip', 'c_juno']);
  assert.equal(result.pkg.scenes[1].cast, undefined);
  assert.equal(result.pkg.scenes[2].cast, undefined);
  assert.deepEqual(result.characters.placements, []);
  assert.ok(result.ignored.every((item) => item.reason === 'unconfirmed'));
});

test('PN10: baked JSON carries no secrets or machine paths', () => {
  const forbidden = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /secret[_-]?key\s*[:=]/i,
    /\bsk-[A-Za-z0-9_-]{6,}\b/,
  ];
  const raw = [
    readFileSync(new URL('characters/library.json', exampleDir), 'utf8'),
    readFileSync(new URL('characters.json', exampleDir), 'utf8'),
  ].join('\n');

  for (const pattern of forbidden) assert.doesNotMatch(raw, pattern, `cast fixture matches ${pattern}`);

  for (const value of allStrings([library, characters])) {
    assert.equal(value.startsWith('/'), false, `absolute path leaked: ${value}`);
    assert.equal(/^[A-Za-z]:[\\/]/.test(value), false, `absolute path leaked: ${value}`);
    assert.equal(value.includes('..'), false, `relative escape leaked: ${value}`);
  }
});
