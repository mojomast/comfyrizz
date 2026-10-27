// node:test imports are runtime-only, like the other Easy render tests.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';

import { localStageReadings, mergeLocalStages, PREVIEW_STATUS_TEXT } from './local-stages.ts';
import { readStages } from './stages.ts';

const PKG = {
  id: 'pkg_1',
  voice: { enabled: false, engine: 'none' },
  scenes: [{ id: 's1' }, { id: 's2' }],
};

function stage(progress, id) {
  return progress.stages.find((entry) => entry.id === id);
}

test('idle and pre-plan phases add nothing, so an empty journal still reads Waiting', () => {
  assert.deepEqual(localStageReadings({ phase: 'idle' }), {});
  assert.deepEqual(localStageReadings({ phase: 'idea' }), {});
  const merged = mergeLocalStages(readStages(null), {});
  assert.equal(merged.overall, 0);
});

test('while the plan is written only Plan moves', () => {
  const merged = mergeLocalStages(readStages(null), localStageReadings({ phase: 'plan', pkg: PKG, packageId: 'pkg_1' }));
  assert.equal(stage(merged, 'plan').status, 'running');
  assert.ok(stage(merged, 'plan').fraction > 0);
  for (const id of ['characters', 'shots', 'voice', 'render']) assert.equal(stage(merged, id).status, 'waiting');
  assert.ok(merged.overall > 0, 'the overall gauge leaves 0%');
});

test('after the plan the adopted package fills Characters, Shots and Voice honestly', () => {
  const merged = mergeLocalStages(readStages(null), localStageReadings({ phase: 'approval', pkg: PKG, packageId: 'pkg_1' }));
  assert.equal(stage(merged, 'plan').status, 'done');
  assert.equal(stage(merged, 'shots').status, 'done');
  assert.equal(stage(merged, 'characters').status, 'skipped', 'no cast is skipped, not invented');
  assert.equal(stage(merged, 'voice').status, 'skipped', 'narration off is skipped');
  assert.equal(stage(merged, 'render').status, 'waiting');
});

test('narration and a cast read as done', () => {
  const pkg = { ...PKG, voice: { enabled: true, engine: 'kokoro' }, characters: [{ id: 'c1' }], scenes: [{ id: 's1', narration: 'Hello' }] };
  const readings = localStageReadings({ phase: 'run', pkg, packageId: 'pkg_1' });
  assert.equal(readings.voice.status, 'done');
  assert.equal(readings.characters.status, 'done');
});

test('a package the run is not following is ignored', () => {
  const readings = localStageReadings({ phase: 'approval', pkg: { ...PKG, id: 'pkg_other' }, packageId: 'pkg_1' });
  assert.equal(readings.plan.status, 'done');
  assert.equal(readings.shots, undefined);
  assert.equal(readings.voice, undefined);
});

test('a playable preview leaves Video running at 90% with its own label, never Done', () => {
  const merged = mergeLocalStages(readStages(null), localStageReadings({ phase: 'preview', pkg: PKG, packageId: 'pkg_1' }));
  const video = stage(merged, 'render');
  assert.equal(video.status, 'running');
  assert.equal(video.fraction, 0.9);
  assert.equal(video.statusText, PREVIEW_STATUS_TEXT);
  assert.equal(merged.finalReady, false);
  assert.ok(merged.overall < 1);
});

test('the merge only moves a gauge forward and never hides a server error or done', () => {
  const server = readStages({
    plan: { status: 'error', error: 'Plan broke' },
    shots: { status: 'running', fraction: 0.8 },
    render: { status: 'running', fraction: 0.2 },
  });
  const merged = mergeLocalStages(server, {
    plan: { status: 'done', fraction: 1 },
    shots: { status: 'running', fraction: 0.5 },
    render: { status: 'running', fraction: 0.9 },
  });
  assert.equal(stage(merged, 'plan').status, 'error');
  assert.equal(stage(merged, 'plan').error, 'Plan broke');
  assert.equal(stage(merged, 'shots').fraction, 0.8, 'a further server reading wins');
  assert.equal(stage(merged, 'render').fraction, 0.9);
});

test('a failed run marks the stage it stopped in', () => {
  assert.equal(localStageReadings({ phase: 'plan', failed: true }).plan.status, 'error');
  const late = localStageReadings({ phase: 'run', failed: true, pkg: PKG, packageId: 'pkg_1' });
  assert.equal(late.render.status, 'error');
  assert.equal(late.plan.status, 'done');
});
