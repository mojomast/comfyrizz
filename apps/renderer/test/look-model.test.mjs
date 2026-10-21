import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOOK_SCHEMA_ID,
  LOOK_FONT_FILES,
  buildLookRender,
  hasLook,
  lookFontEntries,
  normalizeFinish,
} from '../src/look-model.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PALETTE = ['#0b1020', '#eef3ff', '#4f6bff', '#9fe8ff'];

function sidecar(finish, overrides = {}) {
  return {
    schema: LOOK_SCHEMA_ID,
    recipeId: 'film-35mm',
    seed: 42,
    fonts: [{ family: 'Inter', assetId: 'aInter' }],
    finish: finish.map(item => (typeof item === 'string' ? { id: item, params: {} } : item)),
    transitions: [],
    ...overrides,
  };
}

function render(finish, overrides = {}, options = {}) {
  return buildLookRender(sidecar(finish, overrides), {
    frame: 12,
    width: 1920,
    height: 1080,
    palette: PALETTE,
    ...options,
  });
}

function layerFor(id, params = {}, options = {}) {
  const built = render([{ id, params }], {}, options);
  return built.layers.find(layer => layer.effectId === id);
}

test('M17: an absent or malformed sidecar keeps the existing render path', () => {
  for (const value of [undefined, null, {}, { schema: LOOK_SCHEMA_ID }, { schema: LOOK_SCHEMA_ID, recipeId: 'x' }]) {
    assert.equal(hasLook(value), false);
    assert.equal(buildLookRender(value), null);
  }
  assert.equal(hasLook(sidecar([])), true);
  assert.deepEqual(lookFontEntries(null), []);
  assert.deepEqual(normalizeFinish(null), []);
});

test('M17: film grain emits a deterministic SVG turbulence layer', () => {
  const built = render(['film-grain']);
  const grain = built.layers[0];
  assert.equal(grain.kind, 'grain');
  assert.equal(grain.svg.type, 'fractalNoise');
  assert.equal(grain.svg.stitchTiles, 'stitch');
  assert.ok(grain.svg.baseFrequency > 0 && grain.svg.baseFrequency < 8);
  assert.equal(grain.svg.seed, (1337 + 42 + 6) % 10000);
  assert.equal(grain.style.mixBlendMode, 'overlay');
  assert.equal(grain.style.opacity, 0.12);

  const next = render(['film-grain'], {}, { frame: 20 });
  assert.notEqual(next.layers[0].svg.seed, grain.svg.seed);
  const same = render(['film-grain'], {}, { frame: 12 });
  assert.deepEqual(same, built);
});

test('M17: fine and paper grain stay in the grain family with their own texture', () => {
  const fine = layerFor('grain-fine');
  const paper = layerFor('paper-grain');
  const texture = layerFor('paper-texture');
  assert.equal(fine.kind, 'grain');
  assert.equal(fine.style.opacity, 0.06);
  assert.equal(paper.style.mixBlendMode, 'multiply');
  assert.ok(paper.svg.baseFrequency < fine.svg.baseFrequency);
  assert.equal(texture.svg.numOctaves, 5);
});

test('M17: vignette emits a radial gradient with clamped amount and radius', () => {
  const soft = layerFor('vignette-soft');
  const hard = layerFor('vignette-hard');
  const clamped = layerFor('vignette-hard', { amount: 9, radius: -2 });
  assert.equal(soft.kind, 'vignette');
  assert.match(soft.style.backgroundImage, /radial-gradient\(ellipse at center/);
  assert.match(soft.style.backgroundImage, /rgba\(0,0,0,0\) 65%/);
  assert.equal(soft.style.mixBlendMode, 'multiply');
  assert.match(hard.style.backgroundImage, /rgba\(0,0,0,0\.6\) 100%/);
  assert.match(clamped.style.backgroundImage, /rgba\(0,0,0,1\) 100%/);
  assert.match(clamped.style.backgroundImage, /rgba\(0,0,0,0\) 0%/);
});

test('M17: light leak uses screen-blended radial gradients and softness blur', () => {
  const leak = layerFor('light-leak', { intensity: 0.4, hue: 200, softness: 0.8 });
  assert.equal(leak.kind, 'light-leak');
  assert.equal(leak.style.mixBlendMode, 'screen');
  assert.match(leak.style.backgroundImage, /hsla\(200, 100%, 68%/);
  assert.match(leak.style.backgroundImage, new RegExp(PALETTE[2]));
  assert.equal(leak.style.opacity, 0.4);
  assert.match(leak.style.filter, /blur\(19\.2px\)/);
});

test('M17: scanlines derive pitch from frame height and animate the offset', () => {
  const scan = layerFor('scanlines', { count: 120, opacity: 0.25 });
  assert.equal(scan.kind, 'scanlines');
  assert.match(scan.style.backgroundImage, /^repeating-linear-gradient\(to bottom/);
  assert.match(scan.style.backgroundImage, /rgba\(0,0,0,0\.25\)/);
  assert.equal(scan.style.backgroundPositionY, '3px');
  assert.equal(scan.style.mixBlendMode, 'multiply');
  const soft = layerFor('scanlines-soft');
  assert.equal(soft.style.backgroundPositionY, '3px');
});

test('M17: chromatic aberration offsets the red and cyan channels', () => {
  const chroma = render(['chroma-shift']);
  assert.equal(chroma.layers.length, 0);
  assert.deepEqual(chroma.chroma, { dx: 2, dy: 0 });
  const angled = render([{ id: 'chroma-shift', params: { offset: 10, angle: 90 } }]);
  assert.deepEqual(angled.chroma, { dx: 0, dy: 10 });
  const alias = render(['chromatic-aberration']);
  assert.deepEqual(alias.chroma, chroma.chroma);
});

test('M17: duotone grades to grayscale then tints with the palette pair', () => {
  const built = render(['duotone']);
  assert.match(built.sceneFilter, /grayscale\(1\)/);
  const duo = built.layers[0];
  assert.equal(duo.kind, 'duotone');
  assert.deepEqual(duo.tones, [PALETTE[0], PALETTE[1]]);
  assert.match(duo.style.backgroundImage, new RegExp(`${PALETTE[0]} 0%`));
  assert.equal(duo.style.mixBlendMode, 'color');

  const fallback = buildLookRender(sidecar(['duotone']), { frame: 0, width: 1920, height: 1080 });
  assert.deepEqual(fallback.layers[0].tones, ['#0b0b12', '#f5f0e6']);
});

test('M17: halation blurs and warms highlights at the catalog radius', () => {
  const halation = layerFor('halation', { radius: 24, threshold: 0.5 });
  assert.equal(halation.kind, 'halation');
  assert.match(halation.style.backdropFilter, /blur\(24px\)/);
  assert.match(halation.style.backdropFilter, /brightness\(1\.25\)/);
  assert.match(halation.style.backgroundImage, /radial-gradient/);
  assert.equal(halation.style.mixBlendMode, 'screen');
  assert.equal(halation.style.opacity, 0.455);
});

test('M17: every grade variant outputs a CSS filter', () => {
  assert.match(render(['mono-grade']).sceneFilter, /grayscale\(1\) contrast\(1\.05\)/);
  assert.match(render(['sepia-grade']).sceneFilter, /sepia\(0\.8\)/);
  assert.match(render(['teal-orange']).sceneFilter, /saturate\(/);
  assert.match(render(['lut']).sceneFilter, /contrast\(1\)/);
});

test('M17: every catalog effect renders a layer, a filter, or a camera transform', () => {
  const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts/motionkit/data/effects.json'), 'utf8'));
  for (const effect of catalog.effects) {
    const built = buildLookRender(sidecar([{ id: effect.id, params: {} }]), {
      frame: 12,
      width: 1920,
      height: 1080,
      palette: PALETTE,
    });
    assert.ok(built, effect.id);
    const output = built.layers.length + (built.sceneFilter ? 1 : 0) + (built.sceneTransform ? 1 : 0) + (built.chroma ? 1 : 0);
    assert.ok(output > 0, `${effect.id} produced no style output`);
  }
});

test('M17: every finish id used by the 24 recipes has a renderer implementation', () => {
  const dir = join(REPO_ROOT, 'scripts/motionkit/data/recipes');
  const ids = new Set();
  for (const file of readdirSync(dir).filter(name => name.endsWith('.json'))) {
    const recipe = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    for (const effect of recipe.finish ?? []) ids.add(typeof effect === 'string' ? effect : effect.id);
  }
  assert.ok(ids.has('gate-weave'));
  for (const id of ids) {
    const built = buildLookRender(sidecar([{ id, params: {} }]), { frame: 12, width: 1920, height: 1080, palette: PALETTE });
    const output = built.layers.length + (built.sceneFilter ? 1 : 0) + (built.sceneTransform ? 1 : 0) + (built.chroma ? 1 : 0);
    assert.ok(output > 0, `${id} produced no style output`);
  }
});

test('M17: effect layers paint in a stable order and unknown ids are ignored', () => {
  const built = render(['vignette-soft', 'film-grain', 'scanlines', 'halation', 'not-a-real-effect']);
  assert.deepEqual(built.layers.map(layer => layer.kind), ['halation', 'scanlines', 'grain', 'vignette']);
  const sorted = [...built.layers].sort((a, b) => (a.order === b.order ? a.effectId.localeCompare(b.effectId) : a.order - b.order));
  assert.deepEqual(built.layers, sorted);
  assert.equal(render(['not-a-real-effect']).layers.length, 0);
});

test('M17: params are clamped to the catalog ranges', () => {
  const grain = layerFor('film-grain', { amount: 5, size: 0 });
  assert.equal(grain.style.opacity, 1);
  assert.ok(grain.svg.baseFrequency >= 0.75 / 8);
  const scan = layerFor('scanlines', { count: 1, opacity: 2 });
  assert.match(scan.style.backgroundImage, /rgba\(0,0,0,1\)/);
  assert.ok(scan.style.backgroundPositionY.endsWith('px'));
  const dust = layerFor('dust-scratches', { density: 0, opacity: 1 });
  assert.equal(dust.specks.length, 0);
  assert.equal(dust.scratches.length, 0);
});

test('M17: dust and glitch stay deterministic for a seed and frame', () => {
  const a = layerFor('dust-scratches');
  const b = layerFor('dust-scratches');
  assert.deepEqual(a.specks, b.specks);
  assert.deepEqual(a.scratches, b.scratches);
  assert.equal(a.kind, 'dust');
  const other = render(['glitch-slice'], {}, { frame: 13 });
  const same = render(['glitch-slice'], {}, { frame: 13 });
  assert.deepEqual(other.layers[0].style, same.layers[0].style);
});

test('M17: look fonts resolve from the staged public/fonts files', () => {
  assert.equal(LOOK_FONT_FILES.Inter, 'Inter-Variable.ttf');
  assert.equal(LOOK_FONT_FILES['JetBrains Mono'], 'JetBrainsMono-Regular.ttf');
  assert.equal(LOOK_FONT_FILES['Space Grotesk'], 'SpaceGrotesk[wght].ttf');
  const entries = lookFontEntries(sidecar([], {
    fonts: [
      { family: 'Inter', assetId: 'aInter' },
      { family: 'Inter', assetId: 'aInter' },
      { family: 'JetBrains Mono', assetId: 'aJetBrainsMono' },
      { family: 'Not Installed', assetId: 'aNope' },
    ],
  }));
  assert.deepEqual(entries, [
    { family: 'Inter', file: 'Inter-Variable.ttf', path: 'fonts/Inter-Variable.ttf' },
    { family: 'JetBrains Mono', file: 'JetBrainsMono-Regular.ttf', path: 'fonts/JetBrainsMono-Regular.ttf' },
  ]);
  for (const entry of entries) {
    assert.ok(existsSync(new URL(`../public/${entry.path}`, import.meta.url)), entry.path);
  }
});

test('M17: the look model is pure and deterministic', () => {
  const source = readFileSync(new URL('../src/look-model.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Math\.random/);
  assert.doesNotMatch(source, /Date\.now|new Date\(/);
  const first = render(['light-leak', 'film-grain', 'scanlines', 'duotone']);
  const second = render(['light-leak', 'film-grain', 'scanlines', 'duotone']);
  assert.deepEqual(first, second);
  assert.equal(first.recipeId, 'film-35mm');
  assert.equal(first.seed, 42);
});
