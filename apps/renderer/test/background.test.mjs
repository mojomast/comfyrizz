/**
 * A6 regression: the procedural `dots` and `grid` backgrounds must keep their
 * base colour. They previously used the CSS `background` shorthand with the
 * colour in the wrong position, so the browser dropped the whole declaration and
 * the scene rendered transparent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proceduralStyle, readableMediaScrim } from '../src/background-model.js';

const palette = ['#120b1f', '#2a1b45', '#f6a94a', '#fdf6ec'];

for (const pattern of ['dots', 'grid', 'grain', 'mesh']) {
  test(`the ${pattern} background paints its base colour`, () => {
    const style = proceduralStyle(pattern, palette);
    assert.equal(style.backgroundColor, palette[0], `${pattern} keeps the base colour`);
    assert.equal(style.background, undefined, `${pattern} must not use the background shorthand`);
  });
}

test('dots and grid draw their pattern with backgroundImage, not background', () => {
  const dots = proceduralStyle('dots', palette);
  assert.match(dots.backgroundImage, /radial-gradient/);
  assert.equal(dots.backgroundSize, '46px 46px, 46px 46px');
  assert.equal(dots.backgroundPosition, '0 0, 23px 23px');

  const grid = proceduralStyle('grid', palette);
  assert.match(grid.backgroundImage, /linear-gradient/);
  assert.equal(grid.backgroundSize, '96px 96px, 96px 96px');
});

test('gradient is the only pattern that uses the background shorthand', () => {
  const style = proceduralStyle('gradient', palette);
  assert.match(style.background, /^linear-gradient/);
  assert.equal(style.backgroundColor, undefined);
});

test('a short palette falls back safely instead of reading undefined', () => {
  const style = proceduralStyle('dots', ['#120b1f']);
  assert.equal(style.backgroundColor, '#120b1f');
  assert.doesNotMatch(style.backgroundImage, /undefined/);
});

test('generated media gets a readability scrim beneath editorial copy', () => {
  assert.equal(readableMediaScrim({ copy: { headline: 'A chord' } }, 0), 0.42);
  assert.equal(readableMediaScrim({ copy: { headline: 'A chord' } }, 0.6), 0.6);
  assert.equal(readableMediaScrim({ copy: { headline: 'A chord' } }, 1), 0.85);
  assert.equal(readableMediaScrim({ copy: {} }, 0), 0);
  assert.equal(readableMediaScrim({ media_only: true, lower_third: { text: 'Ratio' } }, 0), 0.18);
});
