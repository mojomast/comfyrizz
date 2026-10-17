import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCheck } from '../src/index.js';

const solid = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${fill}"/></svg>`;

test('a solid SVG renders and stays inside its palette', () => {
  const result = renderCheck(solid('#6d8cff'), { width: 128, palette: ['#6d8cff'] });
  assert.equal(result.ok, true);
  assert.equal(result.width, 128);
  assert.equal(result.height, 128);
  assert.ok(result.opaqueFraction > 0.99);
  assert.ok((result.outOfPaletteFraction ?? 1) < 0.01);
});

test('a broken SVG fails render-check with a usable message', () => {
  const result = renderCheck('<svg viewBox="0 0 10 10"><path d="M0 0 L', { width: 64 });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'parse-error');
  assert.match(result.errors[0].message, /parse|raster/i);
});

test('blank output fails', () => {
  const result = renderCheck('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>', { width: 64 });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'blank-output');
});

test('near-invisible output fails with a coverage message', () => {
  const result = renderCheck('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="2" height="2" fill="#6d8cff"/></svg>', { width: 512 });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'near-invisible');
  assert.match(result.errors[0].message, /covers only/);
});

test('content outside the theme palette fails', () => {
  const result = renderCheck(solid('#ff0055'), { width: 128, palette: ['#0d0f14', '#6d8cff', '#e6e8ee'] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'out-of-palette');
  assert.match(result.errors[0].message, /outside the theme palette/);
});
