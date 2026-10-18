import assert from 'node:assert/strict';
import test from 'node:test';
import { SCENE_CHIPS, applySceneChip, isSceneChip, warmHex } from '../src/scene-chips.js';
import type { ChipPackage, ChipScene } from '../src/scene-chips.js';

function fixture(): ChipPackage {
  return {
    theme: { palette: ['#101018', '#203050', '#6d8cff', '#e8ecef'] },
    scenes: [
      {
        id: 's_one',
        layout: 'list',
        preferredFrames: 210,
        transitionOut: { type: 'slide', frames: 12 },
        background: { procedural: { pattern: 'mesh', seed: 4, palette: ['#101018', '#203050', '#6d8cff'] } },
        foreground: [
          { asset: 'a', anim: 'slide-in', z: 1 },
          { asset: 'b', anim: 'zoom-in' },
        ],
        copy: { headline: 'One', items: ['a', 'b', 'c', 'd', 'e'] },
      },
      {
        id: 's_two',
        layout: 'hero',
        background: { procedural: { pattern: 'grid', seed: 9 } },
        foreground: [{ asset: 'c', anim: 'fade-in' }],
      },
    ],
  };
}

function sceneOf(result: { package: ChipPackage }, id: string): ChipScene {
  return result.package.scenes!.find(scene => scene.id === id)!;
}

test('scene-chip bank: four fixed edits', () => {
  assert.deepEqual(SCENE_CHIPS.map(chip => chip.id), ['warmer', 'calmer-motion', 'more-depth', 'less-busy']);
  assert.ok(isSceneChip('warmer'));
  assert.ok(!isSceneChip('pixelate'));
});

test('warmer shifts only the target scene palette and never mutates the input', () => {
  const pkg = fixture();
  const before = JSON.stringify(pkg);
  const result = applySceneChip(pkg, 's_one', 'warmer');
  assert.equal(JSON.stringify(pkg), before, 'input package must be untouched');
  assert.deepEqual(result.package.theme, pkg.theme, 'theme is global and stays put');
  const warmed = sceneOf(result, 's_one').background!.procedural!.palette!;
  assert.notDeepEqual(warmed, pkg.scenes![0].background!.procedural!.palette);
  for (const colour of warmed) assert.match(colour, /^#[0-9a-f]{6}$/);
  assert.deepEqual(sceneOf(result, 's_two'), pkg.scenes![1]);
  assert.equal(result.changed, true);
});

test('warmHex only warms real colours and pushes red up as it pushes blue down', () => {
  assert.equal(warmHex('not-a-colour'), 'not-a-colour');
  const source = '#3344aa';
  const warm = warmHex(source);
  const from = Number.parseInt(source.slice(1), 16);
  const to = Number.parseInt(warm.slice(1), 16);
  assert.ok(((to >> 16) & 0xff) > ((from >> 16) & 0xff), `${warm} should be redder`);
  assert.ok((to & 0xff) < (from & 0xff), `${warm} should be less blue`);
  assert.match(warm, /^#[0-9a-f]{6}$/);
});

test('calmer-motion softens entrances and slides without touching frames', () => {
  const pkg = fixture();
  const result = applySceneChip(pkg, 's_one', 'calmer-motion');
  const scene = sceneOf(result, 's_one');
  assert.equal(scene.transitionOut!.type, 'fade');
  assert.equal(scene.transitionOut!.frames, 12, 'frames are timing: unchanged');
  assert.equal(scene.preferredFrames, 210, 'duration untouched so no full render');
  assert.deepEqual(scene.foreground!.map(item => item.anim), ['fade-in', 'fade-in']);
  assert.equal(sceneOf(result, 's_two').foreground![0].anim, 'fade-in', 'other scene untouched');
});

test('more-depth adds parallax and clamps z inside the schema range', () => {
  const pkg = fixture();
  pkg.scenes![0].foreground![0].z = 32;
  const result = applySceneChip(pkg, 's_one', 'more-depth');
  const scene = sceneOf(result, 's_one');
  assert.deepEqual(scene.foreground!.map(item => item.anim), ['parallax-in', 'parallax-in']);
  assert.deepEqual(scene.foreground!.map(item => item.z), [32, 2]);
});

test('less-busy trims bullets, overlays and a busy background pattern', () => {
  const pkg = fixture();
  const result = applySceneChip(pkg, 's_one', 'less-busy');
  const scene = sceneOf(result, 's_one');
  assert.deepEqual(scene.copy!.items, ['a', 'b', 'c']);
  assert.equal(scene.foreground!.length, 1);
  assert.equal(scene.background!.procedural!.pattern, 'gradient');
  assert.equal(sceneOf(result, 's_two').background!.procedural!.pattern, 'grid', 'other scene untouched');
});

test('unknown scenes and chips are rejected with their HTTP status', () => {
  assert.throws(() => applySceneChip(fixture(), 'nope', 'warmer'), error => (error as { status?: number }).status === 404);
  assert.throws(() => applySceneChip(fixture(), 's_one', 'zoom' as never), error => (error as { status?: number }).status === 400);
});
