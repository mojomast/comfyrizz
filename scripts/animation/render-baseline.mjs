/** Compare the pack with the prior layouts using identical measured audio and scene overlap. */
import { cpSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderPipeline } from '../../apps/renderer/scripts/render-pipeline.mjs';
import { normalizeMixLoudness } from '../../apps/renderer/scripts/mix-loudness.mjs';
import { compileTimeline } from '../../packages/planner/dist/src/index.js';
import { narrationOptions } from '../../apps/renderer/scripts/render-package-lib.mjs';
import { completedShowcase } from './artifacts.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

if (!process.argv[2]) throw Error('Usage: node scripts/animation/render-baseline.mjs <completed-showcase-artifacts>');
const root = resolve(process.argv[2]);
const { state, runDir, timeline: originalTimeline } = completedShowcase(root);
const work = join(root, 'baseline-source');
cpSync(join(runDir, 'work'), work, { recursive: true });
const pkg = JSON.parse(readFileSync(join(work, 'package.json'), 'utf8'));
for (const scene of pkg.scenes) {
  if (scene.motion) {
    for (const key of ['recipe', 'seed', 'intensity', 'focus', 'morph', 'cue_phrases']) delete scene.motion[key];
    if (!Object.keys(scene.motion).length) delete scene.motion;
  }
  if (scene.transitionOut?.frames > 0) scene.transitionOut = { type: 'fade', frames: scene.transitionOut.frames };
}
writeFileSync(join(work, 'package.json'), JSON.stringify(pkg, null, 2));
const timeline = compileTimeline(pkg, narrationOptions(work));
const timing = t => ({ fps: t.fps, width: t.width, height: t.height, frames: t.durationInFrames, scenes: t.scenes.map(s => [s.id, s.from, s.durationInFrames, s.transitionInFrames, s.transitionOutFrames]) });
assert.deepEqual(timing(timeline), timing(originalTimeline), 'Baseline must preserve every scene boundary and overlap');
const audioHash = directory => createHash('sha256').update(readFileSync(join(directory, 'audio/narration.norm.wav'))).digest('hex');
assert.equal(audioHash(work), audioHash(join(runDir, 'work')), 'Baseline must use identical narration bytes');
writeFileSync(join(work, 'timeline.json'), JSON.stringify(timeline, null, 2));
const start = Date.now(), video = join(root, 'baseline.mp4');
const result = await renderPipeline(join(work, 'package.json'), video, { onEvent: e => { if (e.progress?.completed % 150 === 0 || !e.progress) console.log(JSON.stringify(e)); } });
if (result.frames !== state.result.frames) throw Error('Baseline does not match showcase timing');
const loudness = normalizeMixLoudness(video);
result.bytes = statSync(video).size;
writeFileSync(join(root, 'baseline-report.json'), JSON.stringify({ ...result, runId: state.runId, inputHash: state.inputHash, renderSeconds: (Date.now() - start) / 1000, loudness, narrationSha256: audioHash(work), sameNarration: true, sameOverlapFrames: true, sameSceneBoundaries: true }, null, 2));
console.log(JSON.stringify({ video, ...result }));
