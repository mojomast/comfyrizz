import assert from 'node:assert/strict';
import test from 'node:test';
import { STYLE_PRESETS, STYLE_PRESET_DEFAULTS } from '../src/brief.js';
import { STYLE_PRESET_LABELS, stylePresets } from '../src/style-presets.js';

test('stylePresets: one CPU/SVG thumbnail per bundled look, with its palette', () => {
  const cards = stylePresets();
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.map(card => card.id), [...STYLE_PRESETS]);
  for (const card of cards) {
    assert.equal(card.label, STYLE_PRESET_LABELS[card.id]);
    assert.deepEqual(card.palette, STYLE_PRESET_DEFAULTS[card.id].palette);
    assert.equal(card.font, 'Inter');
    assert.match(card.thumbnail, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(card.thumbnail, /viewBox="0 0 160 90"/);
    assert.doesNotMatch(card.thumbnail, /<script/i, 'no scripts in a thumbnail');
    for (const colour of card.palette) assert.ok(card.thumbnail.includes(colour), `${card.id} should use ${colour}`);
  }
});

test('stylePresets: deterministic output (same string every call)', () => {
  const first = stylePresets();
  const second = stylePresets();
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map(card => card.thumbnail)).size, 6, 'each look is visually distinct');
});
