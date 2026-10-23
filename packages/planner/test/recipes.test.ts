import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALL_RECIPES,
  applyGraphicsRecipe,
  applyMusicRecipe,
  applyRecipe,
  resolveRecipe,
  type GraphicsRecipe,
  type MusicRecipe,
} from '../src/recipes.js';

const MOTION_ENERGIES = ['calm', 'medium', 'high'];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

async function semanticCheck(doc: unknown): Promise<{ errors: Array<{ code: string; path: string; message: string }> }> {
  let lastError: unknown;
  for (const path of ['../../../schema/src/semantic.mjs', '../../../../packages/schema/src/semantic.mjs']) {
    try {
      const mod = await import(new URL(path, import.meta.url).href);
      return mod.semanticCheck(doc);
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw lastError;
}

function fixturePackage(): Record<string, any> {
  let lastError: unknown;
  for (const path of [
    '../../../../apps/web/test/fixtures/editor/hermes-190s/package.json',
    '../../../apps/web/test/fixtures/editor/hermes-190s/package.json',
  ]) {
    try {
      return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw lastError;
}

/** The fixture already has a music bed; this adds a second ready audio asset for the swap. */
function withReadyBed(pkg: Record<string, any>): Record<string, any> {
  const next = structuredClone(pkg);
  next.assets.a_bed = {
    kind: 'audio',
    origin: 'upload',
    status: 'ready',
    file: 'audio/bed.wav',
    license: { id: 'CC0-1.0' },
    redistributable: true,
    sha256: 'c'.repeat(64),
    bytes: 2048,
  };
  return next;
}

test('the catalog is frozen, has unique ids, and music describes a bed instead of an asset', () => {
  assert.ok(Object.isFrozen(ALL_RECIPES));
  assert.equal(new Set(ALL_RECIPES.map(recipe => recipe.id)).size, ALL_RECIPES.length);
  for (const recipe of ALL_RECIPES) {
    assert.ok(Object.isFrozen(recipe), `${recipe.id} is frozen`);
    assert.ok(Object.isFrozen(recipe.keywords), `${recipe.id} keywords are frozen`);
    assert.ok(recipe.keywords.length > 0, `${recipe.id} has searchable keywords`);
    assert.ok(recipe.brief.length > 0, `${recipe.id} has a search/generation brief`);
    if (recipe.kind === 'music') {
      assert.equal('asset' in recipe, false, `${recipe.id} must not hard-code an asset id`);
      assert.ok(recipe.mood.length > 0);
      assert.ok(MOTION_ENERGIES.includes(recipe.energy));
      assert.ok(recipe.bpm.min > 0 && recipe.bpm.max >= recipe.bpm.min);
    } else {
      assert.ok(recipe.palette.length >= 1 && recipe.palette.length <= 8, `${recipe.id} palette length`);
      for (const hex of recipe.palette) assert.match(hex, HEX_COLOR);
      assert.ok(MOTION_ENERGIES.includes(recipe.energy));
    }
  }
});

test('resolveRecipe puts an explicitly named kind before any id or keyword match', () => {
  const upbeat = resolveRecipe('more upbeat music');
  assert.equal(upbeat?.kind, 'music');
  assert.equal(upbeat?.id, 'upbeat');

  // The music recipe whose keywords include cinematic, never the graphics recipe 'cinematic'.
  const cinematicMusic = resolveRecipe('cinematic music');
  assert.equal(cinematicMusic?.kind, 'music');
  assert.equal(cinematicMusic?.id, 'dramatic');
  assert.ok(cinematicMusic?.keywords.includes('cinematic'));

  const cinematicGraphics = resolveRecipe('cinematic graphics');
  assert.equal(cinematicGraphics?.kind, 'graphics');
  assert.equal(cinematicGraphics?.id, 'cinematic');

  const plainCinematic = resolveRecipe('cinematic');
  assert.equal(plainCinematic?.kind, 'graphics');
  assert.equal(plainCinematic?.id, 'cinematic');

  const upbeatGraphics = resolveRecipe('upbeat graphics');
  assert.equal(upbeatGraphics?.kind, 'graphics');
  assert.notEqual(upbeatGraphics?.id, 'upbeat');

  assert.deepEqual(resolveRecipe('more upbeat music'), resolveRecipe('more upbeat music'));
});

test('applyMusicRecipe swaps only audio.music.asset when the caller supplies a ready audio asset', async () => {
  const recipe = resolveRecipe('more upbeat music') as MusicRecipe;
  const pkg = withReadyBed(fixturePackage());
  const before = structuredClone(pkg);

  const result = applyMusicRecipe(pkg, recipe, 'a_bed');
  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  assert.equal(result.recipeId, 'upbeat');
  assert.equal(result.assetId, 'a_bed');

  assert.deepEqual(pkg, before, 'the input package is never mutated');
  const expected = structuredClone(before);
  expected.audio.music.asset = 'a_bed';
  assert.deepEqual(result.package, expected, 'only audio.music.asset changes');

  const report = await semanticCheck(result.package);
  assert.deepEqual(report.errors, []);
});

test('applyMusicRecipe returns needs_bed and leaves the package alone without a usable ready audio asset', () => {
  const recipe = resolveRecipe('more upbeat music') as MusicRecipe;
  const pkg = withReadyBed(fixturePackage());
  const pending = structuredClone(pkg);
  pending.assets.a_pending = {
    kind: 'audio',
    origin: 'upload',
    status: 'pending',
    file: 'audio/pending.wav',
    license: { id: 'CC0-1.0' },
    sha256: 'd'.repeat(64),
    bytes: 2048,
  };

  const cases: Array<[Record<string, any>, string | undefined]> = [
    [pkg, undefined],
    [pkg, 'a_missing'],
    [pkg, 'a_portrait'],
    [pending, 'a_pending'],
  ];
  for (const [input, assetId] of cases) {
    const before = structuredClone(input);
    const result = applyMusicRecipe(input, recipe, assetId);
    assert.equal(result.status, 'needs_bed');
    if (result.status !== 'needs_bed') continue;
    assert.equal(result.recipeId, 'upbeat');
    assert.equal(result.mood, recipe.mood);
    assert.equal(result.energy, recipe.energy);
    assert.deepEqual(result.bpm, recipe.bpm);
    assert.deepEqual(input, before);
  }
});

test('applyGraphicsRecipe writes a schema-shaped palette and motion energy only', async () => {
  const recipe = resolveRecipe('cinematic graphics') as GraphicsRecipe;
  const pkg = withReadyBed(fixturePackage());
  pkg.motion = { direction: 'right' };
  const before = structuredClone(pkg);

  const result = applyGraphicsRecipe(pkg, recipe);
  assert.equal(result.status, 'applied');
  assert.equal(result.recipeId, 'cinematic');
  assert.deepEqual(pkg, before, 'the input package is never mutated');

  const applied = result.package;
  assert.ok(Array.isArray(applied.theme.palette));
  assert.ok(applied.theme.palette.length >= 1 && applied.theme.palette.length <= 8);
  for (const hex of applied.theme.palette) assert.match(hex, HEX_COLOR);
  assert.deepEqual(applied.theme.palette, recipe.palette);
  assert.ok(MOTION_ENERGIES.includes(applied.motion.energy));
  assert.equal(applied.motion.energy, recipe.energy);
  assert.equal(applied.motion.direction, 'right', 'other motion fields survive');
  assert.deepEqual(applied.scenes, before.scenes);
  assert.deepEqual(applied.audio, before.audio);

  const report = await semanticCheck(applied);
  assert.deepEqual(report.errors, []);
});

test('applyRecipe is the one dispatcher for graphics and music', () => {
  const pkg = withReadyBed(fixturePackage());
  const graphics = resolveRecipe('cinematic graphics') as GraphicsRecipe;
  assert.equal(applyRecipe(pkg, graphics).status, 'applied');

  const music = resolveRecipe('more upbeat music') as MusicRecipe;
  assert.equal(applyRecipe(pkg, music).status, 'needs_bed');
  assert.equal(applyRecipe(pkg, music, 'a_bed').status, 'applied');
});
