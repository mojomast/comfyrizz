// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGalleryModel } from './gallery-model.ts';
import { normalizedGallerySnapshot, packageGalleryShots } from './gallery-snapshot.ts';

function fixture() {
  const pkg = { id: 'pkg_test', scenes: [], assets: {} };
  for (let index = 1; index <= 10; index++) {
    pkg.scenes.push({ id: `s${index}`, background: { asset: `video${index}` }, media: [{ asset: `video${index}` }, { asset: `video${index}` }],
      foreground: index === 1 || index === 8 ? [{ asset: `reference${index}` }] : [] });
    pkg.assets[`video${index}`] = { kind: 'video', status: 'generating', gen: { model: 'ltx-2.5', workflow: 'workflows/ltx25_i2v_2stage.api.json', inputs: { image: `reference${index}`, prompt: `Motion ${index}`, seed: 0 } } };
    pkg.assets[`reference${index}`] = { kind: 'image', status: 'ready', file: `assets/reference${index}.png`, media: { width: 1920, height: 1088 },
      gen: { model: 'flux-3-klein', workflow: 'workflows/flux3_klein_t2i.api.json', inputs: { prompt: `Exact reference ${index}`, seed: 0 } } };
  }
  return { production: { id: 'prod_test', packageId: pkg.id }, run: { runId: 'run_test', packageId: pkg.id, productionId: 'prod_test', status: 'failed', result: { package: pkg } } };
}

test('background/media composition maps every shot, with correctly identified conditioning fallback', () => {
  const source = fixture();
  const model = buildGalleryModel(source);
  const shots = model.items.filter(item => item.kind === 'shot');
  assert.equal(shots.length, 10);
  assert.equal(shots.filter(item => item.url !== null).length, 10);
  assert.equal(shots.filter(item => item.state === 'loading').length, 10);
  for (const [index, shot] of shots.entries()) {
    assert.equal(shot.details.role, 'reference');
    assert.equal(shot.details.assetId, `reference${index + 1}`);
    assert.equal(shot.details.prompt, `Exact reference ${index + 1}`);
    assert.equal(shot.details.model, 'flux-3-klein');
    assert.match(shot.url, /^\/api\/package\/pkg_test\/media\?path=assets%2Freference/u);
  }
  assert.notEqual(model.final.state, 'ready');
  assert.equal(model.items.find(item => item.id === 'character:reference2').details.prompt, 'Exact reference 2');
});

test('ready background videos replace reference previews with the exact video prompt and dimensions', () => {
  const source = fixture(), pkg = source.run.result.package;
  for (let index = 1; index <= 10; index++) Object.assign(pkg.assets[`video${index}`], { status: 'ready', file: `assets/video${index}.mp4`, media: { width: 1280, height: 720, frames: 145, fps: 24 } });
  const shots = buildGalleryModel(source).items.filter(item => item.kind === 'shot');
  assert.equal(shots.length, 10);
  assert.ok(shots.every(item => item.details.role === 'generated' && item.details.mediaType === 'video' && item.state === 'ready'));
  assert.equal(shots[7].details.prompt, 'Motion 8');
  assert.equal(shots[7].details.durationSeconds, 145 / 24);
  assert.equal(shots[7].details.width, 1280);
  assert.notEqual(buildGalleryModel(source).final.state, 'ready');
});

test('cross-project run packages and unsafe file paths never produce media URLs', () => {
  const source = fixture();
  source.run.packageId = 'pkg_other';
  assert.equal(normalizedGallerySnapshot(source), source);
  assert.equal(buildGalleryModel(source).counts.shot, 0);
  const pkg = fixture().run.result.package;
  pkg.assets.reference1.file = '/home/private/image.png';
  pkg.assets.reference2.file = '../../other-invite/image.png';
  const shots = packageGalleryShots(pkg);
  assert.equal(shots[0].url, null);
  assert.equal(shots[1].url, null);
});
