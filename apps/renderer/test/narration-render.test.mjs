// N7: renderPackage used to compile with no narration options, so scene lengths
// came from preferredFrames (30.5 s silent) instead of the measured timeline
// (36.4 s narrated). It now feeds audio/durations.json to compileTimeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { compileTimeline } from '../../../packages/planner/dist/src/index.js';
import { narrationOptions } from '../scripts/render-package-lib.mjs';
import { resolveSceneMedia } from '../src/media-model.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const exampleDir = join(repoRoot, 'examples', 'showcase-gpu3');
const pkg = JSON.parse(readFileSync(join(exampleDir, 'package.json'), 'utf8'));
const committed = JSON.parse(readFileSync(join(exampleDir, 'timeline.json'), 'utf8'));

test('narrationOptions maps measured chunks for every narrated scene', () => {
  const options = narrationOptions(exampleDir);
  assert.equal(options.narrationGapSeconds, 0.15);
  for (const scene of pkg.scenes) {
    const chunks = options.narration[scene.id];
    assert.ok(Array.isArray(chunks) && chunks.length > 0, `${scene.id} needs measured chunks`);
    for (const chunk of chunks) {
      assert.equal(typeof chunk.text, 'string');
      assert.ok(typeof chunk.seconds === 'number' && chunk.seconds > 0);
    }
  }
});

test('renderPackage compiles the narrated length, not preferredFrames (N7)', () => {
  const timeline = compileTimeline(pkg, narrationOptions(exampleDir));
  assert.equal(timeline.provisional, false);
  assert.equal(timeline.durationInFrames, committed.durationInFrames, 'narrated export must match the committed timeline');
  assert.equal(timeline.hash, committed.hash);

  // The old renderPackage path (no options) is provisional and shorter.
  const silent = compileTimeline(pkg, {});
  assert.equal(silent.provisional, true);
  assert.notEqual(silent.durationInFrames, committed.durationInFrames);
});

test('the compiled scene carries mediaOnly/lowerThird for the media-only scene (N8)', () => {
  const timeline = compileTimeline(pkg, narrationOptions(exampleDir));
  const flow = timeline.scenes.find(scene => scene.id === 's_flow');
  assert.equal(flow.mediaOnly, true);
  assert.deepEqual(flow.lowerThird, { kicker: 'How it flows', text: 'Wind → Turbine → Transformer → Grid → Home' });
  assert.ok(timeline.scenes.filter(scene => !scene.mediaOnly).every(scene => scene.lowerThird === null));
});

test('the compiled timeline replaces the media.json sidecar (N8)', () => {
  const media = JSON.parse(readFileSync(join(exampleDir, 'media.json'), 'utf8'));
  const timeline = compileTimeline(pkg, narrationOptions(exampleDir));
  for (const scene of pkg.scenes) {
    const fromPackage = resolveSceneMedia(scene, pkg, media);
    const fromTimeline = resolveSceneMedia(timeline.scenes.find(item => item.id === scene.id), pkg);
    assert.equal(fromTimeline.mediaOnly, fromPackage.mediaOnly, scene.id);
    assert.deepEqual(fromTimeline.lowerThird, fromPackage.lowerThird, scene.id);
  }
});
