import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/app.mjs';
import { animationOptions } from '../src/animation-options.mjs';
import { chatProjectResponse } from '../src/chat-project.mjs';
import { compilePackage } from '../src/compile-package.mjs';
import { CONVERSATION_RECIPES, CONVERSATION_TRANSITIONS } from '../../../packages/agent/dist/src/index.js';

const TOKEN = 'animation-options-test-token';
const RECIPE_IDS = ['sketch', 'paper-cut', 'morph', 'technical-flow', 'focus', 'kinetic'];

test('chat responses compile the same store-root narration sidecar and cue provenance as the editor', t => {
  const runtime = mkdtempSync(join(tmpdir(), 'animation-chat-timing-'));
  t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const packageDir = join(runtime, 'packages');
  mkdirSync(join(packageDir, 'audio'), { recursive: true });
  const pkg = { id: 'pkg_timing', revision: 1, assets: {}, format: { width: 1280, height: 720, fps: 30 }, scenes: [
    { id: 's_flow', layout: 'list', preferredFrames: 90, copy: { headline: 'A result', items: ['Result'] }, narration: 'Result', motion: { recipe: 'technical-flow', cue_phrases: ['Result'] } },
  ] };
  writeFileSync(join(packageDir, 'audio', 'durations.json'), JSON.stringify({ engine: 'kokoro', scenes: { s_flow: { chunks: [
    { text: 'Result', seconds: 5, words: [{ text: 'Result', start: 1, end: 2 }], timing: 'syllable-fallback' },
  ] } } }));
  const timeline = chatProjectResponse(pkg, runtime).timeline;
  assert.deepEqual(timeline, compilePackage(pkg, packageDir));
  assert.ok(timeline.scenes[0].durationInFrames > 90);
  assert.equal(timeline.scenes[0].motionCues[0].timing, 'syllable-fallback');
  assert.equal(timeline.scenes[0].motionCues[0].estimated, true);
});

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
  const runtimeDir = mkdtempSync(join(tmpdir(), 'animation-options-'));
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
