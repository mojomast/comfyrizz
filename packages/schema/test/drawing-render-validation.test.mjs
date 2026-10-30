import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePackage } from '../src/index.mjs';

const base = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url), 'utf8'));
const drawing = { background: '#ffffff', elements: [{ type: 'path', color: '#000000', width: 4, points: [[0, 0], [100, 100]], start: 0, end: 5 }] };
const docFor = (scene) => ({ ...structuredClone(base), scenes: [{ id: 's1', layout: 'hero', preferredFrames: 90, ...scene }] });

test('drawings replace layout and media-only content, without bypassing drawing validation', () => {
  for (const layout of ['hero', 'chart', 'code', 'split']) {
    const result = validatePackage(docFor({ layout, media_only: true, drawing }));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  }
  const noDrawing = validatePackage(docFor({ media_only: true }));
  assert.ok(noDrawing.errors.some((e) => e.code === 'SEM_MEDIA_ONLY_NO_MEDIA'));
  assert.ok(noDrawing.errors.some((e) => e.code === 'SEM_COPY_REQUIRED'));
  const empty = validatePackage(docFor({ media_only: true, drawing: { ...drawing, elements: [] } }));
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => e.code === 'SCHEMA_MINITEMS'));
  const reversed = structuredClone(drawing);
  reversed.elements[0].start = 6;
  assert.ok(validatePackage(docFor({ drawing: reversed })).errors.some((e) => e.code === 'SEM_DRAWING_TIMING'));
});
