import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { lintMotion, validatePackage } from '../../../../packages/schema/src/index.mjs';
import { compileRecipe } from '../../../../scripts/motionkit/compile.mjs';
import { validateRecipe } from '../../../../scripts/motionkit/recipe-schema.mjs';

const exampleDir = new URL('../../../../examples/pip-night-shift/', import.meta.url);
const repoRoot = new URL('../../../../', import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const pkg = readJson(new URL('package.json', exampleDir));
const timeline = readJson(new URL('timeline.json', exampleDir));
const recipe = readJson(new URL('scripts/motionkit/data/recipes/film-35mm.json', repoRoot));

const words = (value) => (typeof value === 'string' ? value.trim().split(/\s+/).filter(Boolean) : []);

/** The planner ships as compiled JS; build it once if a fresh checkout has no dist yet. */
async function loadPlanner() {
  const entry = new URL('../../../../packages/planner/dist/src/index.js', import.meta.url);
  if (!existsSync(fileURLToPath(entry))) {
    const plannerDir = fileURLToPath(new URL('../../../../packages/planner/', import.meta.url));
    const build = spawnSync('pnpm', ['run', 'build'], { cwd: plannerDir, encoding: 'utf8' });
    if (build.status !== 0) {
      throw new Error(`planner build failed: ${build.stderr || build.stdout || build.error?.message || 'unknown error'}`);
    }
  }
  return import(entry.href);
}

test('package validates and has no semantic warnings', () => {
  const report = validatePackage(pkg);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.valid, true);
  assert.equal(report.schemaOk, true);
});

test('look is compiled from the film-35mm recipe (Tier A)', () => {
  assert.equal(recipe.id, 'film-35mm');
  assert.equal(validateRecipe(recipe).ok, true);

  assert.deepEqual(pkg.theme.palette, recipe.palette.map((entry) => entry.hex));
  assert.equal(pkg.theme.font, 'Instrument Serif');
  assert.equal(pkg.theme.text, '#f6ead8');
  assert.equal(pkg.theme.text_muted, '#6b4a33');

  for (const scene of pkg.scenes) {
    assert.deepEqual(scene.background.procedural.pattern, recipe.background.pattern);
    assert.equal(typeof scene.background.procedural.seed, 'number');
  }

  const compiled = compileRecipe(pkg, recipe, { seed: 1058 });
  assert.deepEqual(compiled.pkg.theme, pkg.theme);
  assert.deepEqual(compiled.pkg.scenes.map((scene) => scene.background), pkg.scenes.map((scene) => scene.background));
  assert.equal(compiled.look.recipeId, 'film-35mm');
  assert.deepEqual(compiled.look.finish.map((effect) => effect.id), recipe.finish.map((effect) => (typeof effect === 'string' ? effect : effect.id)));
  assert.deepEqual(compiled.look.fonts.map((font) => font.family).sort(), ['Instrument Serif', 'Inter']);
});

test('four scenes carry the section 3a motion treatments', () => {
  assert.deepEqual(pkg.scenes.map((scene) => scene.id), ['s1_dawn', 's2_counter', 's3_juno', 's4_outro']);
  assert.deepEqual(pkg.scenes.map((scene) => scene.layout), ['title', 'hero', 'stat', 'title']);
  assert.deepEqual(pkg.scenes.map((scene) => scene.variant ?? null), ['centered', 'split', null, 'outro']);
  assert.equal(new Set(pkg.scenes.map((scene) => `${scene.layout}/${scene.variant ?? '-'}`)).size, 4);

  assert.deepEqual(pkg.scenes.map((scene) => scene.motion.recipe), ['kinetic', 'paper-cut', 'focus', 'sketch']);
  assert.equal(new Set(pkg.scenes.map((scene) => scene.motion.recipe)).size, 4);
  assert.deepEqual(pkg.scenes.map((scene) => scene.motion.energy), ['high', 'medium', 'high', 'calm']);
  assert.deepEqual(pkg.scenes.map((scene) => scene.motion.entry), ['maskRise', 'fadeUp', 'countUp', 'waterfall']);
  assert.equal(new Set(pkg.scenes.map((scene) => scene.motion.entry)).size, 4);

  assert.deepEqual(pkg.scenes.map((scene) => scene.transitionOut.type), ['iris', 'paper-reveal', 'push', 'fade']);
  assert.equal(new Set(pkg.scenes.map((scene) => scene.transitionOut.type)).size, 4);
  assert.deepEqual(pkg.scenes[2].transitionOut.direction, 'left');

  assert.equal(pkg.scenes.filter((scene) => scene.motion.emphasis === 'hero').length, 1);
  assert.equal(pkg.scenes[2].motion.emphasis, 'hero');
  for (const scene of pkg.scenes) {
    if (scene.motion.emphasis === 'keyword') {
      assert.ok(words(scene.motion.highlight).length > 0, `${scene.id} keyword needs a highlight`);
    }
  }
});

test('s2 and s3 carry lower thirds and s3 counts its dataset', () => {
  assert.equal(pkg.scenes[0].lower_third, undefined);
  assert.equal(pkg.scenes[3].lower_third, undefined);

  assert.deepEqual(pkg.scenes[1].lower_third, { kicker: 'Pip', text: 'Pip, barista bot' });
  assert.deepEqual(pkg.scenes[2].lower_third, { kicker: 'Juno', text: 'Juno, courier' });

  assert.deepEqual(pkg.scenes[2].data, { dataset: 'd_orders', display: 'counter' });
  assert.equal(pkg.datasets.d_orders.values[0].value, 347);
  assert.equal(pkg.scenes[2].copy.body, '347 orders before 7 am');
  assert.deepEqual(timeline.scenes[1].lowerThird, { kicker: 'Pip', text: 'Pip, barista bot' });
  assert.deepEqual(timeline.scenes[2].lowerThird, { kicker: 'Juno', text: 'Juno, courier' });
  assert.deepEqual(timeline.scenes[2].data, { dataset: 'd_orders', display: 'counter' });
});

test('captions are karaoke and narration covers s1-s3', () => {
  assert.equal(pkg.captions.style, 'karaoke');
  for (const scene of pkg.scenes.slice(0, 3)) assert.ok(words(scene.narration).length > 0);
  assert.equal(pkg.scenes[3].narration, undefined);
});

test('scene lengths are 75-frame bars at 96 BPM', () => {
  const fps = pkg.format.fps;
  const barFrames = (60 / 96) * 4 * fps;
  assert.equal(barFrames, 75);
  for (const scene of pkg.scenes) {
    assert.equal(scene.preferredFrames % barFrames, 0, `${scene.id} preferredFrames`);
    assert.equal(scene.preferredFrames, 150);
  }
  for (const scene of timeline.scenes) {
    assert.equal(scene.durationInFrames % barFrames, 0, `${scene.id} compiled duration`);
    assert.equal(scene.durationInFrames, 150);
  }
});

test('the only assets are the PN18 generated audio (music bed + sfx)', () => {
  assert.equal(Object.hasOwn(pkg, 'audio'), true);
  assert.equal(pkg.audio.music.asset, 'a_music_bed');
  for (const [id, asset] of Object.entries(pkg.assets)) assert.equal(asset.kind, 'audio', `${id} is audio`);
});

test('motion lint is clean, with and without the compiled timeline', () => {
  const plain = lintMotion(pkg, { fps: pkg.format.fps });
  const compiled = lintMotion(pkg, { fps: pkg.format.fps, timeline });
  assert.deepEqual(plain, []);
  assert.deepEqual(compiled, []);
  const report = validatePackage(pkg);
  assert.deepEqual(report.motion, []);
});

test('timeline.json is exactly the planner compile of package.json', async () => {
  const { compileTimeline } = await loadPlanner();
  const recompiled = compileTimeline(pkg);
  assert.deepEqual(timeline, recompiled);
  assert.equal(timeline.sourceHash, recompiled.sourceHash);
  assert.equal(timeline.hash, recompiled.hash);
  assert.equal(timeline.provisional, false);
  assert.equal(timeline.scenes.length, 4);
  assert.equal(timeline.durationInFrames, 572);
});

test('every scene draws text with no generated media present', () => {
  for (const asset of Object.values(pkg.assets)) assert.equal(asset.kind, 'audio', 'no generated visual media is required');
  for (const scene of pkg.scenes) {
    assert.equal(scene.background.asset, undefined, `${scene.id} must not require a media asset`);
    assert.equal(scene.media, undefined);
    assert.equal(scene.foreground, undefined);
    assert.ok(Object.keys(scene.copy).length >= 2, `${scene.id} needs visible copy`);
  }
  assert.equal(pkg.scenes[0].copy.headline, "Pip's Night Shift");
  assert.equal(pkg.scenes[1].copy.headline, 'Still warm. Still open.');
  assert.equal(pkg.scenes[2].copy.headline, 'Orders before seven');
  assert.equal(pkg.scenes[2].copy.body, '347 orders before 7 am');
  assert.equal(pkg.scenes[3].copy.headline, 'Open all night');
  assert.equal(pkg.scenes[3].copy.cta, 'Come in');

  const noMedia = (scene) => !scene.background?.asset && !(scene.media?.length) && !(scene.foreground?.length);
  assert.ok(timeline.scenes.every(noMedia));
});

test('README documents the look, scenes and checks', () => {
  const path = new URL('README.md', exampleDir);
  assert.equal(existsSync(fileURLToPath(path)), true);
  const readme = readFileSync(path, 'utf8');
  for (const needle of ['film-35mm', 'karaoke', 'compileTimeline', '75 frames', 'No `audio` block', 'node --test apps/server/test/pip-night-shift/package.test.mjs']) {
    assert.ok(readme.includes(needle), `README should mention ${needle}`);
  }
});

test('committed example files carry no secret values', () => {
  const forbidden = [
    /ghp_[A-Za-z0-9]{8,}/,
    /github_pat_[A-Za-z0-9_]{8,}/,
    /Bearer\s+[A-Za-z0-9._-]{8,}/,
    /secret[_-]?key\s*[:=]/i,
  ];
  for (const name of ['package.json', 'timeline.json', 'README.md']) {
    const text = readFileSync(new URL(name, exampleDir), 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`);
  }
});
