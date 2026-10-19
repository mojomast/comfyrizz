import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENTER_DISSOLVE_FRAMES,
  PRESENTER_SIZE_DEFAULT,
  isOverlayPlacement,
  presenterAssetId,
  presenterBox,
  presenterLabelStyle,
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

test('G6-11: the disclosure chip fits inside a circular presenter mask at every legal size', () => {
  const label = 'AI presenter';
  for (const size of [0.18, 0.24, PRESENTER_SIZE_DEFAULT, 0.32]) {
    const box = presenterBox({ placement: 'pip-br', shape: 'circle', size, width: W, height: H });
    const style = presenterLabelStyle('circle', Math.max(16, Math.round(box.height * 0.075)));
    const inset = (box.width * parseFloat(style.left)) / 100;
    const available = box.width - inset * 2;
    const chipHeight = 4 * 2 + Math.round(style.fontSize * 1.2);
    const centreFromBottom = (box.height * parseFloat(style.bottom)) / 100 + chipHeight / 2;
    const radius = box.height / 2;
    const chord = 2 * Math.sqrt(Math.max(0, radius ** 2 - (radius - centreFromBottom) ** 2));
    // Rough advance width for a bold uppercase face, plus the per-glyph tracking.
    const text = label.length * style.fontSize * 0.62 + label.length * style.letterSpacing;
    assert.ok(available <= chord, `size ${size}: chip ${available}px wide exceeds the ${Math.round(chord)}px chord`);
    assert.ok(text <= available, `size ${size}: ${Math.round(text)}px of label does not fit ${Math.round(available)}px`);
  }
});

test('G6-11: a rounded-rect card keeps the chip flush instead of insetting it', () => {
  const style = presenterLabelStyle('rounded-rect', 24);
  assert.equal(style.left, 0);
  assert.equal(style.right, 0);
  assert.equal(style.bottom, 0);
  assert.equal(style.fontSize, 24);
});
