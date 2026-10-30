import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatProject } from '../src/chat-project.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240"><rect width="400" height="240" fill="#05070d"/><circle cx="200" cy="120" r="70" fill="#6d8cff"/></svg>';

function plan() {
  return {
    title: 'Adopted launch',
    brief: 'A generated project that needs a later edit.',
    audience: 'Customers',
    aspect: '16:9',
    stylePreset: 'cinematic-dark',
    scenes: [
      { id: 's_title', layout: 'title', headline: 'Original opening', sub: 'Keep this subtitle', seconds: 4, narration: 'Original opening.', visual: 'An editorial opening plate', mediaType: 'image' },
      { id: 's_hero', layout: 'hero', headline: 'Original hero', sub: 'Current supporting copy', body: 'Current body copy.', seconds: 8, narration: 'Current narration.', visual: 'A current diagram', mediaType: 'svg', svg: SVG },
    ],
  };
}

async function setup(t) {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'comfyrizz-chat-adoption-build-'));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const originalPlan = plan();
  const previous = await buildChatProject({ plan: originalPlan, runtimeDir });
  return { runtimeDir, originalPlan, previous };
}

test('the first complete adopted plan revises the same package with stable scene ids and reused assets', async t => {
  const { runtimeDir, previous } = await setup(t);
  const next = plan();
  next.scenes[0].headline = 'A better opening';

  const revised = await buildChatProject({ plan: next, previous, adoptPackage: true, runtimeDir });

  assert.equal(revised.id, previous.id);
  assert.equal(revised.revision, previous.revision, 'PackageStore owns the revision increment');
  assert.deepEqual(revised.scenes.map(scene => scene.id), previous.scenes.map(scene => scene.id));
  assert.equal(revised.scenes[0].copy.headline, 'A better opening');
  assert.equal(revised.scenes[0].copy.sub, 'Keep this subtitle');
  assert.deepEqual(revised.assets, previous.assets, 'a copy-only edit does not regenerate media');
  assert.deepEqual(revised.scenes[1], previous.scenes[1]);
});

test('adoption treats current locked scenes and manual payloads as authoritative', async t => {
  const { runtimeDir, previous } = await setup(t);
  previous.scenes[1].locked = true;
  previous.scenes[1].code = { language: 'js', code: 'const preserve = true;' };
  previous.scenes[1].foreground[0].x = 0.75;
  const next = plan();
  next.scenes[0].headline = 'Only the opening changes';
  next.scenes[1].code = structuredClone(previous.scenes[1].code);

  const revised = await buildChatProject({ plan: next, previous, adoptPackage: true, runtimeDir });
  assert.deepEqual(revised.scenes[1], previous.scenes[1]);

  next.scenes[1].headline = 'This must not bypass the lock';
  await assert.rejects(
    buildChatProject({ plan: next, previous, adoptPackage: true, runtimeDir }),
    error => error.status === 409 && /locked scene s_hero cannot be modified/.test(error.message),
  );
});

test('a missing last-built plan is not silently treated as adoption outside the explicit contract', async t => {
  const { runtimeDir, previous } = await setup(t);
  await assert.rejects(
    buildChatProject({ plan: plan(), previous, runtimeDir }),
    error => error.status === 409 && /last built plan is missing/.test(error.message),
  );
});
