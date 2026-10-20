import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { animationOptions } from '../src/animation-options.mjs';
import { CONVERSATION_RECIPES, CONVERSATION_TRANSITIONS } from '../../../packages/agent/dist/src/index.js';

const TOKEN = 'animation-options-test-token';
const RECIPE_IDS = ['sketch', 'paper-cut', 'morph', 'technical-flow', 'focus', 'kinetic'];

async function listen(t, server) {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the animation catalogue is the shared schema catalogue', () => {
  const options = animationOptions();
  assert.equal(options.version, 1);
  assert.deepEqual(options.recipes.map(recipe => recipe.id), RECIPE_IDS);
  assert.deepEqual(options.recipes.map(recipe => recipe.id), [...CONVERSATION_RECIPES]);
  assert.deepEqual(options.transitions, [...CONVERSATION_TRANSITIONS]);
  for (const recipe of options.recipes) {
    assert.deepEqual(Object.keys(recipe).sort(), ['description', 'id', 'label', 'layouts']);
    assert.ok(recipe.layouts.includes('title') || recipe.layouts.includes('hero'));
  }
});

test('GET /api/animation-options is authenticated and returns recipes and transitions', async t => {
  const runtimeDir = mkdtempSync('/tmp/opencode/animation-options-');
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const app = createApp({ token: TOKEN, runtimeDir });
  t.after(() => app.close());
  const base = await listen(t, createServer(app.handler));

  const denied = await fetch(`${base}/api/animation-options`);
  assert.equal(denied.status, 401);

  const response = await fetch(`${base}/api/animation-options`, { headers: { 'x-comfyrizz-token': TOKEN } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.version, 1);
  assert.deepEqual(body.recipes.map(recipe => recipe.id), RECIPE_IDS);
  assert.deepEqual(body.transitions, [...CONVERSATION_TRANSITIONS]);
  assert.deepEqual(body.recipes.map(recipe => recipe.id), [...CONVERSATION_RECIPES]);
});
