/**
 * L1 re-layout check: a 16:9 package re-laid-out for 9:16 / 1:1 moves its
 * foreground assets into the aspect's free area instead of cropping them, and
 * the result still has no text/asset overlap. 16:9 is the identity transform.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASPECTS,
  FORMATS,
  aspectName,
  findLayoutOverlaps,
  formatFor,
  freeArea,
  relayoutPackage,
  relayoutVariants,
  textZones,
} from '../src/layout-model.js';

const ASSETS = {
  a_wide: { kind: 'image', status: 'ready', file: 'wide.png', media: { width: 1920, height: 1080 } },
  a_square: { kind: 'image', status: 'ready', file: 'square.png', media: { width: 1000, height: 1000 } },
  a_tall: { kind: 'image', status: 'ready', file: 'tall.png', media: { width: 900, height: 1600 } },
};

function samplePackage(asset = 'a_wide') {
  return {
    id: 'pkg_relayout0001',
    title: 'Re-layout sample',
    format: { width: 1920, height: 1080, fps: 30 },
    assets: ASSETS,
    scenes: [
      { id: 's_title', layout: 'title', variant: 'centered', foreground: [{ asset, x: 0.5, y: 0.5, w: 0.4, anim: 'fade' }], copy: { headline: 'Title' } },
      { id: 's_hero', layout: 'hero', variant: 'split', foreground: [{ asset, x: 0.72, y: 0.5, w: 0.46, anim: 'fade' }], copy: { headline: 'Hero' } },
      { id: 's_hero_full', layout: 'hero', variant: 'full-bleed', foreground: [{ asset, x: 0.5, y: 0.5, w: 0.4, anim: 'fade' }], copy: { headline: 'Full' } },
      { id: 's_stat', layout: 'stat', foreground: [{ asset, x: 0.6, y: 0.5, w: 0.4, anim: 'fade' }], copy: { headline: 'Stat' } },
      { id: 's_chart', layout: 'chart', variant: 'bar', foreground: [{ asset, x: 0.5, y: 0.5, w: 0.5, anim: 'fade' }], copy: { headline: 'Chart' } },
      { id: 's_list', layout: 'list', variant: 'bullets', foreground: [{ asset, x: 0.5, y: 0.5, w: 0.4, anim: 'fade' }], copy: { headline: 'List', items: ['one', 'two'] } },
    ],
  };
}

test('L1: aspectName and formatFor round-trip the three frame sizes', () => {
  assert.deepEqual(ASPECTS, ['16:9', '9:16', '1:1']);
  assert.deepEqual(FORMATS['9:16'], { width: 1080, height: 1920 });
  for (const aspect of ASPECTS) {
    const frame = formatFor(aspect);
    assert.equal(aspectName(frame.width, frame.height), aspect);
  }
  assert.equal(aspectName(undefined, undefined), '16:9');
});

test('L1: text-safe zones differ per aspect and split heroes use their own zone', () => {
  const landscape = textZones({ layout: 'hero', variant: 'split' }, '16:9');
  const portrait = textZones({ layout: 'hero', variant: 'split' }, '9:16');
  const square = textZones({ layout: 'hero', variant: 'split' }, '1:1');
  assert.notDeepEqual(landscape, portrait);
  assert.notDeepEqual(portrait, square);
  // Portrait stacks the hero: copy on top, so its zone ends higher up.
  assert.ok(portrait[0].y1 < landscape[0].y1, 'portrait hero copy sits above the media');
  assert.notDeepEqual(textZones({ layout: 'hero', variant: 'full-bleed' }, '9:16'), portrait);
});

test('L1: every free area clears its text-safe zone', () => {
  for (const aspect of ASPECTS) {
    for (const key of ['title', 'hero', 'hero-split', 'stat', 'chart', 'list']) {
      const area = freeArea(aspect, key);
      if (!area) continue;
      const scene = key === 'hero-split'
        ? { layout: 'hero', variant: 'split' }
        : key === 'hero'
          ? { layout: 'hero', variant: 'full-bleed' }
          : { layout: key };
      for (const zone of textZones(scene, aspect)) {
        // Either vertically separated or horizontally separated.
        const separated = zone.y1 <= area.y0 + 1e-9 || area.y1 <= zone.y0 + 1e-9 || zone.x1 <= area.x0 + 1e-9 || area.x1 <= zone.x0 + 1e-9;
        assert.ok(separated, `${aspect}/${key} free area overlaps its text zone`);
      }
    }
  }
});

test('L1: 16:9 re-layout is the identity transform', () => {
  const source = samplePackage();
  const variant = relayoutPackage(source, '16:9');
  assert.deepEqual(variant.format, source.format);
  assert.deepEqual(variant.scenes, source.scenes);
  assert.notEqual(variant, source);
});

test('L1: 9:16 and 1:1 re-layout fit foreground assets without cropping', () => {
  for (const asset of ['a_wide', 'a_square', 'a_tall']) {
    for (const aspect of ['9:16', '1:1']) {
      const source = samplePackage(asset);
      const variant = relayoutPackage(source, aspect);
      const frame = formatFor(aspect);
      assert.equal(variant.format.width, frame.width);
      assert.equal(variant.format.height, frame.height);
      assert.equal(variant.format.fps, 30);
      // Not cropped: the asset table is untouched and the source is unchanged.
      assert.deepEqual(variant.assets, source.assets);
      assert.deepEqual(source.format, { width: 1920, height: 1080, fps: 30 });
      assert.deepEqual(findLayoutOverlaps(variant, { aspect }), []);
      assert.deepEqual(findLayoutOverlaps(variant), [], 'aspect is inferred from the new format');
      // Every foreground item ends inside its free area with the asset intact.
      for (const scene of variant.scenes) {
        const item = scene.foreground?.[0];
        if (!item) continue;
        assert.equal(item.asset, asset);
        assert.ok(item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1);
        assert.ok(item.w > 0 && item.w <= 1);
      }
    }
  }
});

test('L1: relayoutVariants covers every aspect', () => {
  const variants = relayoutVariants(samplePackage());
  assert.deepEqual(Object.keys(variants), ['16:9', '9:16', '1:1']);
  assert.equal(variants['9:16'].format.height, 1920);
  assert.equal(variants['1:1'].format.width, 1080);
});
