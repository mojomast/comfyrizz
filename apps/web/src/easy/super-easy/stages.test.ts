// SE02: the pure Super Easy stage gauge.
//
// A stage is only Done when the snapshot carries explicit evidence for it,
// and the overall bar only reaches 100% when the final video deliverable is
// ready. Unknown or missing fields stay Waiting (or Running with no completed
// work), never success.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY } from './copy.ts';
import {
  STAGE_IDS,
  STAGE_LABELS,
  STAGE_STATUSES,
  STAGE_STATUS_TEXT,
  readStages,
} from './stages.ts';

function approx(actual, expected, message) {
  assert.equal(typeof actual, 'number', `fraction is a number: ${message}`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function byId(result, id) {
  const stage = result.stages.find((entry) => entry.id === id);
  assert.ok(stage, `stage ${id} exists`);
  return stage;
}

function statuses(result) {
  return result.stages.map((stage) => stage.status);
}

test('stage ids, statuses and labels are the agreed vocabulary', () => {
  assert.deepEqual(STAGE_IDS, ['plan', 'characters', 'shots', 'voice', 'render']);
  assert.deepEqual(STAGE_STATUSES, ['waiting', 'starting', 'running', 'done', 'skipped', 'error']);
  assert.deepEqual(STAGE_STATUS_TEXT, {
    waiting: 'Waiting',
    starting: 'Starting',
    running: 'Running',
    done: 'Done',
    skipped: 'Skipped',
    error: 'Error',
  });
  assert.equal(STAGE_LABELS.plan, COPY.stages.plan);
  assert.equal(STAGE_LABELS.characters, COPY.stages.characters);
  assert.equal(STAGE_LABELS.shots, COPY.stages.shots);
  assert.equal(STAGE_LABELS.voice, COPY.stages.voice);
  assert.equal(STAGE_LABELS.render, COPY.stages.video);
});

test('an empty snapshot is waiting at zero and never ready', () => {
  const result = readStages({});

  assert.deepEqual(statuses(result), ['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  for (const stage of result.stages) {
    assert.equal(stage.fraction, 0, stage.id);
    assert.equal(stage.statusText, 'Waiting', stage.id);
    assert.equal(stage.error, null, stage.id);
  }
  assert.equal(result.overall, 0);
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
});

test('a loading snapshot does not inherit stale success', () => {
  const result = readStages({
    loading: true,
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done' },
    render: { status: 'done', fraction: 1 },
    finalVideo: { ready: true },
  });

  assert.deepEqual(statuses(result), ['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
  assert.equal(result.overall, 0);
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
});

test('unknown and missing fields are not success', () => {
  const result = readStages({
    plan: { status: 'mystery', fraction: 1 },
    characters: {},
    shots: [{ id: 'shot-1' }, { id: 'shot-2' }],
    voice: { unusualField: true },
    render: { status: 'done', fraction: 1 },
  });

  assert.equal(byId(result, 'plan').status, 'waiting');
  assert.equal(byId(result, 'plan').fraction, 0);
  assert.equal(byId(result, 'characters').status, 'waiting');
  assert.notEqual(byId(result, 'shots').status, 'done');
  assert.equal(byId(result, 'shots').fraction, 0);
  assert.equal(byId(result, 'voice').status, 'waiting');
  assert.notEqual(byId(result, 'render').status, 'done');
  assert.ok(byId(result, 'render').fraction < 1);
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
  assert.ok(result.overall < 1);
});

test('a partial production reports fractions and statuses per stage', () => {
  const result = readStages({
    plan: { status: 'done' },
    characters: { done: 1, total: 2 },
    shots: [{ status: 'approved' }, { status: 'review' }],
    voice: { status: 'starting' },
    render: { status: 'running', fraction: 0.4 },
  });

  approx(byId(result, 'plan').fraction, 1, 'plan');
  assert.equal(byId(result, 'plan').status, 'done');
  approx(byId(result, 'characters').fraction, 0.5, 'characters');
  assert.equal(byId(result, 'characters').status, 'running');
  approx(byId(result, 'shots').fraction, 0.5, 'shots');
  assert.equal(byId(result, 'shots').status, 'running');
  approx(byId(result, 'voice').fraction, 0, 'voice');
  assert.equal(byId(result, 'voice').status, 'starting');
  approx(byId(result, 'render').fraction, 0.4, 'render');
  assert.equal(byId(result, 'render').status, 'running');
  approx(result.overall, 0.48, 'overall');
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
});

test('a complete-looking snapshot without the final video stops below 100%', () => {
  const result = readStages({
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done' },
    render: { status: 'done', fraction: 1 },
  });

  assert.equal(byId(result, 'render').status, 'running');
  assert.ok(byId(result, 'render').fraction < 1);
  assert.equal(byId(result, 'render').statusText, 'Running');
  assert.ok(result.overall <= 0.99);
  assert.ok(result.overall < 1);
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
});

test('the overall bar reaches 100% only with a ready final video deliverable', () => {
  const result = readStages({
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: [{ status: 'approved' }],
    voice: { status: 'done' },
    render: { status: 'running', fraction: 0.7 },
    finalVideo: { ready: true, url: '/media/final.mp4' },
  });

  assert.equal(byId(result, 'render').status, 'done');
  assert.equal(byId(result, 'render').fraction, 1);
  assert.equal(result.finalReady, true);
  assert.equal(result.complete, true);
  assert.equal(result.overall, 1);
});

test('an error is surfaced without treating the stage as done', () => {
  const result = readStages({
    plan: { status: 'done' },
    characters: { status: 'done' },
    shots: { status: 'error', fraction: 0.4, error: 'Shot 2 failed' },
    voice: { status: 'waiting' },
    render: { status: 'running', fraction: 0.25 },
    finalVideo: { status: 'rendering' },
  });

  const shots = byId(result, 'shots');
  assert.equal(shots.status, 'error');
  assert.equal(shots.statusText, 'Error');
  assert.equal(shots.error, 'Shot 2 failed');
  approx(shots.fraction, 0.4, 'shots');
  approx(result.overall, 0.53, 'overall');
  assert.equal(result.finalReady, false);
  assert.equal(result.complete, false);
});

test('a skipped stage counts as complete but is never called done or failed', () => {
  const withoutFinal = readStages({
    plan: { status: 'done' },
    characters: { status: 'skipped' },
    shots: [{ status: 'approved' }],
    voice: { status: 'skipped' },
    render: { status: 'done' },
  });

  for (const id of ['characters', 'voice']) {
    assert.equal(byId(withoutFinal, id).status, 'skipped');
    assert.equal(byId(withoutFinal, id).statusText, 'Skipped');
    assert.equal(byId(withoutFinal, id).fraction, 1);
    assert.equal(byId(withoutFinal, id).error, null);
  }
  assert.ok(withoutFinal.overall < 1, 'no final video yet');
  assert.equal(withoutFinal.complete, false);

  const withFinal = readStages({
    plan: { status: 'done' },
    characters: { status: 'skipped' },
    shots: [{ status: 'approved' }],
    voice: { status: 'skipped' },
    render: { status: 'done' },
    finalVideo: { ready: true },
  });

  assert.equal(withFinal.overall, 1);
  assert.equal(withFinal.complete, true);
  assert.equal(byId(withFinal, 'characters').status, 'skipped');
  assert.equal(byId(withFinal, 'voice').status, 'skipped');
});

test('a production-like snapshot falls back to durable production fields', () => {
  const result = readStages({
    production: {
      briefVersionId: 'brief_1',
      scriptVersionId: 'script_1',
      characterBindings: [
        { characterId: 'char_1', artifactId: 'artifact_1', voiceId: 'voice_1' },
        { characterId: 'char_2', artifactId: 'artifact_2', voiceId: 'voice_2' },
      ],
      shotIds: ['shot_1', 'shot_2'],
      latestDeliveryId: 'dlv_1',
    },
  });

  assert.equal(byId(result, 'plan').status, 'done');
  assert.equal(byId(result, 'characters').status, 'done');
  assert.notEqual(byId(result, 'shots').status, 'done');
  assert.equal(byId(result, 'voice').status, 'done');
  assert.equal(byId(result, 'render').status, 'done');
  assert.equal(result.finalReady, true);
  assert.equal(result.complete, false);
  assert.ok(result.overall < 1);
});

test('a bare production document is accepted as well as a snapshot', () => {
  const result = readStages({
    briefVersionId: 'brief_1',
    scriptVersionId: 'script_1',
    characterBindings: [{ characterId: 'char_1', voiceId: 'voice_1' }],
    shotIds: ['shot_1'],
    latestDeliveryId: 'dlv_1',
  });

  assert.equal(byId(result, 'plan').status, 'done');
  assert.equal(byId(result, 'characters').status, 'waiting');
  assert.equal(byId(result, 'voice').status, 'done');
  assert.equal(byId(result, 'render').status, 'done');
  assert.equal(result.finalReady, true);
  assert.equal(result.complete, false);
  assert.ok(result.overall < 1);
});

test('counts, arrays and explicit statuses normalise without rounding up', () => {
  const result = readStages({
    plan: { status: 'starting' },
    characters: [{ status: 'done' }, { status: 'unknown' }],
    shots: { done: 2, total: 2 },
    voice: [{ status: 'done' }, { status: 'skipped' }],
    render: { progress: 0.5 },
  });

  assert.equal(byId(result, 'plan').status, 'starting');
  assert.equal(byId(result, 'plan').fraction, 0);
  assert.equal(byId(result, 'characters').status, 'running');
  approx(byId(result, 'characters').fraction, 0.5, 'characters');
  assert.equal(byId(result, 'shots').status, 'done');
  assert.equal(byId(result, 'shots').fraction, 1);
  assert.equal(byId(result, 'voice').status, 'done');
  assert.equal(byId(result, 'voice').fraction, 1);
  assert.equal(byId(result, 'render').status, 'running');
  approx(byId(result, 'render').fraction, 0.5, 'render');
  approx(result.overall, 0.6, 'overall');
});
