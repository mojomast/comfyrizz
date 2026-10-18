import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENTER_DISSOLVE_FRAMES,
  PRESENTER_SIZE_DEFAULT,
  isOverlayPlacement,
  presenterAssetId,
  presenterBox,
  presenterOpacity,
} from '../src/presenter-model.js';

const W = 1920;
const H = 1080;

test('P-pres: pip-br sits in the bottom-right, clear of the caption band', () => {
  const box = presenterBox({ placement: 'pip-br', shape: 'circle', size: 0.24, width: W, height: H });
  const side = Math.round(0.24 * Math.min(W, H));
  assert.equal(box.width, side);
  assert.equal(box.height, side);
  assert.equal(box.radius, Math.round(side / 2));
  assert.ok(box.left + box.width < W, 'inside the frame');
  assert.ok(box.top + box.height < H, 'above the bottom edge');
  // The caption band sits at SAFE_AREA.y (100); the box must not reach it.
  assert.ok(box.top + box.height < H - 100, 'above the captions');
});

test('P-pres: pip-bl mirrors pip-br and pip-bc centres bottom (the 9:16 default)', () => {
  const br = presenterBox({ placement: 'pip-br', shape: 'rounded-rect', size: 0.24, width: W, height: H });
  const bl = presenterBox({ placement: 'pip-bl', shape: 'rounded-rect', size: 0.24, width: W, height: H });
  assert.equal(bl.left, Math.round(Math.min(W, H) * 0.035));
  assert.equal(bl.top, br.top);
  assert.equal(bl.radius, Math.round(bl.width * 0.14), 'rounded-rect is not a circle');

  const portrait = presenterBox({ placement: 'pip-bc', shape: 'circle', size: 0.24, width: 1080, height: 1920 });
  assert.equal(portrait.left, Math.round((1080 - portrait.width) / 2));
});

test('P-pres: split-left is a 40% full-height card and is not drawn by the overlay', () => {
  const box = presenterBox({ placement: 'split-left', shape: 'circle', size: 0.24, width: W, height: H });
  assert.deepEqual(box, { left: 0, top: 0, width: Math.round(W * 0.4), height: H, radius: 0 });
  assert.equal(isOverlayPlacement('split-left'), false);
  assert.equal(isOverlayPlacement('pip-br'), true);
  assert.equal(isOverlayPlacement('pip-bc'), true);
});

test('P-pres: the seam dissolve crossfades, so outgoing + incoming opacity sums to 1', () => {
  const duration = 150;
  const dissolve = PRESENTER_DISSOLVE_FRAMES;
  for (let k = 0; k < dissolve; k += 1) {
    const outgoing = presenterOpacity(duration - dissolve + k, duration, 0, dissolve);
    const incoming = presenterOpacity(k, duration, dissolve, 0);
    assert.ok(Math.abs(outgoing + incoming - 1) < 1e-9, `frame ${k}: ${outgoing} + ${incoming}`);
  }
  assert.equal(presenterOpacity(0, duration, 0, 0), 1);
  assert.equal(presenterOpacity(duration, duration, 0, 0), 1, 'out of range is clamped by the caller');
});

test('P-pres: the clip falls back to the package portrait when a scene has no a2v asset', () => {
  const pkg = { presenter: { enabled: true, portrait: 'a_portrait' } };
  assert.equal(presenterAssetId({ id: 's1' }, pkg), 'a_portrait');
  assert.equal(presenterAssetId({ id: 's1', presenter_asset: 'a_clip' }, pkg), 'a_clip');
  assert.equal(presenterAssetId({ id: 's1' }, {}), null);
});

test('P-pres: the default size is inside the schema range', () => {
  assert.ok(PRESENTER_SIZE_DEFAULT >= 0.18 && PRESENTER_SIZE_DEFAULT <= 0.32);
});
