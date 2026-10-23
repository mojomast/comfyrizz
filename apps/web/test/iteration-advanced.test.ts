// IL16: Advanced iteration controls. Pure functions, no network.
// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import { iterationPresets } from '../src/productions/cards/iteration-card.ts';
import {
  editIterationPolicy,
  readIterationAdvanced,
  renderIterationAdvanced,
  videoTakeTotal,
} from '../src/productions/cards/iteration-advanced.ts';

function shots() {
  return [
    { id: 's1', durationSeconds: 4, characters: ['Pip'] },
    { id: 's2', durationSeconds: 6, characters: ['Ada'], locked: true },
  ];
}

test('editing a preset derives custom and updates the running total', () => {
  const balanced = iterationPresets().balanced;
  assert.equal(videoTakeTotal(balanced, shots()), 4);
  const edited = editIterationPolicy(balanced, {
    kind: 'stage',
    stage: 'video',
    field: 'takes',
    value: 3,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.policy.level, 'custom');
  assert.equal(edited.policy.stages.video.takes, 3);
  assert.equal(videoTakeTotal(edited.policy, shots()), 6);

  const html = renderIterationAdvanced(readIterationAdvanced(null, {
    policy: edited.policy,
    shots: shots(),
    chosen: true,
  }));
  assert.match(html, /data-derived-level="custom"/);
  assert.match(html, /data-iteration-total="6"/);
  assert.match(html, /Running total: 6 video takes/);
  assert.match(html, /does not approve spend/);
  assert.match(html, /data-iteration-stage="script"/);
  assert.match(html, /data-iteration-stage="voice"/);
  assert.match(html, /data-iteration-stage="keyframe"/);
  assert.match(html, /data-iteration-stage="video"/);
  assert.match(html, /Review depth/);
  assert.match(html, /Pip/);
  assert.match(html, /4 s/);
});

test('locked shots are disabled and the edit is refused', () => {
  const draft = iterationPresets().draft;
  const refused = editIterationPolicy(draft, {
    kind: 'shot',
    shotId: 's2',
    stage: 'video',
    field: 'takes',
    value: 2,
  }, { lockedShotIds: ['s2'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ITERATION_SHOT_LOCKED');
  assert.match(refused.message, /in flight/);

  const html = renderIterationAdvanced(readIterationAdvanced({
    policy: draft,
    level: 'draft',
    estimates: {
      draft: {
        gpuMinutes: { low: 1, expected: 1, high: 1 },
        units: { low: 1, expected: 1, high: 1 },
        wallMinutes: { low: 1, expected: 1, high: 1 },
        voiceSamples: 0,
        vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
        labels: ['estimate; other sessions may be running'],
      },
      balanced: {
        gpuMinutes: { low: 1, expected: 1, high: 1 },
        units: { low: 1, expected: 1, high: 1 },
        wallMinutes: { low: 1, expected: 1, high: 1 },
        voiceSamples: 0,
        vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
        labels: [],
      },
      director: {
        gpuMinutes: { low: 1, expected: 1, high: 1 },
        units: { low: 1, expected: 1, high: 1 },
        wallMinutes: { low: 1, expected: 1, high: 1 },
        voiceSamples: 0,
        vsCap: { ceiling: null, fraction: null, status: 'no_cap' },
        labels: [],
      },
    },
    recommendation: { level: 'draft', policy: draft, reasons: ['director'] },
    prefill: null,
    lockedShotIds: ['s2'],
    revision: 2,
  }, { shots: shots(), chosen: true }));
  assert.match(html, /data-iteration-shot="s2"[^>]*data-shot-locked="true"/);
  assert.match(html, /cannot change level|keeps its current level/);
  const lockedRow = html.slice(html.indexOf('data-iteration-shot="s2"'), html.indexOf('data-iteration-shot="s1"') === -1
    ? html.length
    : html.indexOf('</tr>', html.indexOf('data-iteration-shot="s2"')));
  assert.match(lockedRow, /disabled/);
  assert.match(html, /No spend cap set/);
  assert.match(html, /Google Colab/);
  assert.equal(html.replace(/Google Colab/g, '').includes('Colab'), false);
});

test('bounds are enforced for takes, rounds, auditions and asset totals', () => {
  const draft = iterationPresets().draft;
  const takes = editIterationPolicy(draft, { kind: 'stage', stage: 'video', field: 'takes', value: 5 });
  assert.equal(takes.ok, false);
  assert.equal(takes.code, 'ITERATION_EXCEEDED');

  const rounds = editIterationPolicy(draft, { kind: 'stage', stage: 'video', field: 'rounds', value: 4 });
  assert.equal(rounds.ok, false);
  assert.equal(rounds.code, 'ITERATION_EXCEEDED');

  const auditions = editIterationPolicy(draft, { kind: 'stage', stage: 'script', field: 'auditions', value: 2 });
  assert.equal(auditions.ok, false);

  const within = editIterationPolicy(draft, { kind: 'stage', stage: 'video', field: 'takes', value: 4 });
  assert.equal(within.ok, true);
  assert.equal(within.policy.level, 'custom');
  assert.equal(videoTakeTotal(within.policy), 4);

  const depth = editIterationPolicy(iterationPresets().balanced, { kind: 'reviewDepth', value: 'deep' });
  assert.equal(depth.ok, true);
  assert.equal(depth.policy.level, 'custom');
  assert.equal(depth.policy.reviewDepth, 'deep');
});

test('a per-shot override changes only that shot in the total', () => {
  const balanced = iterationPresets().balanced;
  const edited = editIterationPolicy(balanced, {
    kind: 'shot',
    shotId: 's1',
    stage: 'video',
    field: 'takes',
    value: 4,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.policy.level, 'custom');
  assert.equal(videoTakeTotal(edited.policy, [{ id: 's1' }, { id: 's3' }]), 4 + 2);
});
