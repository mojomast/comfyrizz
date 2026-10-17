import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isMediaKind, normalizeScrim, resolveSceneMedia } from '../src/media-model.js';
import { contrastText, textColors } from '../src/theme-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const exampleDir = join(repoRoot, 'examples', 'showcase-gpu2');

const showcase = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const media = JSON.parse(readFileSync(join(exampleDir, 'media.json'), 'utf8'));
const byId = id => showcase.scenes.find(scene => scene.id === id);

test('an image background resolves to its asset with a zero default scrim', () => {
  const pkg = {
    assets: { a_img: { kind: 'image', file: 'assets/a_img.png' } },
    scenes: [],
  };
  const scene = { id: 's1', layout: 'title', background: { asset: 'a_img', fit: 'contain' } };
  const resolved = resolveSceneMedia(scene, pkg);
  assert.equal(resolved.background.kind, 'image');
  assert.equal(resolved.background.file, 'assets/a_img.png');
  assert.equal(resolved.scrim, 0);
  assert.equal(resolved.mediaOnly, false);
  assert.equal(resolved.lowerThird, undefined);
});

test('a video background resolves and is recognised as media', () => {
  const pkg = { assets: { a_vid: { kind: 'video', file: 'assets/a_vid.mp4' } }, scenes: [] };
  const scene = { id: 's1', layout: 'hero', background: { asset: 'a_vid', loop: true, muted: true } };
  const resolved = resolveSceneMedia(scene, pkg);
  assert.equal(resolved.background.kind, 'video');
  assert.ok(isMediaKind(resolved.background.kind));
  assert.ok(!isMediaKind('svg'));
});

test('scrim comes from the schema field, then the sidecar, and is clamped', () => {
  const pkg = { assets: {}, scenes: [] };
  assert.equal(resolveSceneMedia({ id: 'a', background: { scrim: 0.7 } }, pkg).scrim, 0.7);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg, { scrim: { a: 0.25 } }).scrim, 0.25);
  // schema wins over the sidecar
  assert.equal(resolveSceneMedia({ id: 'a', background: { scrim: 0.9 } }, pkg, { scrim: { a: 0.1 } }).scrim, 0.9);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg, { scrim: { a: 5 } }).scrim, 1);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg, { scrim: { a: -3 } }).scrim, 0);
  assert.equal(normalizeScrim('nonsense'), 0);
  assert.equal(normalizeScrim(undefined), 0);
});

test('media_only comes from the schema field or the sidecar skipLayout list', () => {
  const pkg = { assets: {}, scenes: [] };
  assert.equal(resolveSceneMedia({ id: 'a', media_only: true }, pkg).mediaOnly, true);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg, { skipLayout: ['a'] }).mediaOnly, true);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg, { skipLayout: ['b'] }).mediaOnly, false);
  assert.equal(resolveSceneMedia({ id: 'a' }, pkg).mediaOnly, false);
});

test('lower third comes from the schema field or the sidecar', () => {
  const pkg = { assets: {}, scenes: [] };
  const schema = resolveSceneMedia({ id: 'a', lower_third: { kicker: 'K', text: 'T' } }, pkg);
  assert.deepEqual(schema.lowerThird, { kicker: 'K', text: 'T' });
  const sidecar = resolveSceneMedia({ id: 'a' }, pkg, { lowerThird: { a: { text: 'S' } } });
  assert.deepEqual(sidecar.lowerThird, { text: 'S' });
});

test('text colours never depend on an unusable palette[0]', () => {
  const transparent = { theme: { palette: ['transparent', '#13304a', '#ffd166', '#f1faee'] } };
  const colors = textColors(transparent);
  assert.equal(colors.primary, '#f1faee');
  assert.equal(colors.muted, '#ffd166');
  assert.equal(colors.onAccent, '#0d0f14');
  assert.equal(contrastText('#ffd166'), '#0d0f14');
  assert.equal(contrastText('#13304a'), '#f7f9fc');
  assert.equal(contrastText('transparent'), '#0d0f14');
});

test('the launch-demo palette keeps its exact original text colours', () => {
  const pkg = { theme: { palette: ['#0d0f14', '#1b2440', '#6d8cff', '#e6e8ee'] } };
  assert.deepEqual(textColors(pkg), { primary: '#e6e8ee', muted: '#6d8cff', onAccent: '#0d0f14' });
});

test('the showcase package resolves every scene media case through the sidecar', () => {
  const title = resolveSceneMedia(byId('s_title'), showcase, media);
  assert.equal(title.background.kind, 'video');
  assert.equal(title.background.file, 'assets/a_sunrise.mp4');
  assert.equal(title.scrim, 0.45);
  assert.equal(title.mediaOnly, false);

  const flow = resolveSceneMedia(byId('s_flow'), showcase, media);
  assert.equal(flow.background.file, 'assets/a_svg_flow.mp4');
  assert.equal(flow.mediaOnly, true);
  assert.deepEqual(flow.lowerThird, { kicker: 'How it flows', text: 'Sunlight  →  Panel (DC)  →  Inverter (AC)  →  Home' });

  const stat = resolveSceneMedia(byId('s_stat'), showcase, media);
  assert.equal(stat.background.file, 'assets/a_solarfarm.mp4');
  assert.equal(stat.scrim, 0.62);

  const panels = resolveSceneMedia(byId('s_panels'), showcase, media);
  assert.equal(panels.background, undefined);
  assert.equal(panels.mediaOnly, false);
  assert.equal(panels.scrim, 0);

  for (const scene of showcase.scenes) {
    const resolved = resolveSceneMedia(scene, showcase, media);
    for (const item of scene.foreground ?? []) {
      const asset = showcase.assets[item.asset];
      assert.ok(asset, `${scene.id} foreground ${item.asset} missing`);
      assert.ok(isMediaKind(asset.kind), `${scene.id} foreground ${item.asset} should be media`);
    }
    if (resolved.background) assert.ok(isMediaKind(resolved.background.kind));
  }
});
