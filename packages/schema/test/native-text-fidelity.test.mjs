import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schemaErrors } from '../src/index.mjs';

test('package schema bounds native title size and disallows ignored sizing on other layouts', () => {
  const pkg = JSON.parse(readFileSync(new URL('../fixtures/valid/minimal.json', import.meta.url), 'utf8'));
  const scene = pkg.scenes[0];
  scene.layout = 'title';
  for (const size of [24, 104, 440, 512]) {
    scene.headline_size = size;
    assert.deepEqual(schemaErrors(pkg), []);
  }
  for (const size of [23, 513, 104.5, '440']) {
    scene.headline_size = size;
    assert.ok(schemaErrors(pkg).some(error => error.path.endsWith('/headline_size')));
  }
  scene.headline_size = 440;
  scene.layout = 'hero';
  assert.ok(schemaErrors(pkg).some(error => error.path.endsWith('/layout')));
  delete scene.headline_size;
  assert.deepEqual(schemaErrors(pkg), []);
});
