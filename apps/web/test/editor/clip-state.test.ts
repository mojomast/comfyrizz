import test from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_STATES, type ClipSummary } from '../../src/takes/api.ts';
import {
  STATE_STYLE,
  clipChips,
  clipKeyboardAction,
  formatTakeCounter,
} from '../../src/editor/timeline/clip-state.ts';

const timeline = {
  fps: 30,
  durationInFrames: 300,
  scenes: [
    { id: 's1', from: 0, durationInFrames: 90 },
    { id: 's2', from: 90, durationInFrames: 120 },
    { id: 's3', from: 210, durationInFrames: 90 },
  ],
} as never;

function clip(overrides: Partial<ClipSummary> & Pick<ClipSummary, 'clipId' | 'sceneId'>): ClipSummary {
  const { clipId, sceneId, ...rest } = overrides;
  return {
    clipId,
    sceneId,
    assetId: 'a_bg',
    slot: 'background',
    kind: 'plate',
    from: 0,
    durationInFrames: 90,
    state: 'review',
    selected: 'tk_000000000001',
    selectedN: 3,
    takeCount: 3,
    newTakes: 0,
    lastJob: null,
    queued: false,
    ...rest,
  };
}

test('STATE_STYLE covers every server clip state with a badge, label and tone', () => {
  assert.deepEqual(Object.keys(STATE_STYLE).sort(), [...CLIP_STATES].sort());
  for (const state of CLIP_STATES) {
    const style = STATE_STYLE[state];
    assert.ok(style.badge, `${state} badge`);
    assert.ok(style.label, `${state} label`);
    assert.ok(style.aria, `${state} aria phrase`);
    assert.ok(['neutral', 'blue', 'amber', 'green', 'red'].includes(style.tone), `${state} tone`);
  }
  assert.equal(STATE_STYLE.review.badge, 'review');
  assert.equal(STATE_STYLE.review.aria, 'needs review');
  assert.equal(STATE_STYLE.approved.tone, 'green');
  assert.equal(STATE_STYLE.rejected.tone, 'red');
  assert.equal(STATE_STYLE.failed.badge, '!');
  assert.equal(STATE_STYLE.stale.striped, true);
  assert.equal(STATE_STYLE.generating.progress, true);
});

test('clipChips positions each chip in its scene and labels takes for review', () => {
  const chips = clipChips(timeline, [
    clip({ clipId: 's2:a_presenter', sceneId: 's2', assetId: 'a_presenter', slot: 'presenter', kind: 'presenter', from: 90, state: 'approved', selectedN: 1, takeCount: 1 }),
    clip({ clipId: 's2:a_bg', sceneId: 's2', assetId: 'a_bg', from: 90, durationInFrames: 120 }),
    clip({ clipId: 's1:a_fg', sceneId: 's1', assetId: 'a_fg', slot: 'foreground:1', kind: 'still', from: 0, durationInFrames: 90, state: 'generating', lastJob: { progress: 0.42 } }),
  ]);

  assert.deepEqual(chips.map(chip => chip.clipId), ['s1:a_fg', 's2:a_bg', 's2:a_presenter']);
  const [fg, bg, presenter] = chips;
  assert.equal(fg?.sceneIndex, 1);
  assert.equal(fg?.left, 0);
  assert.equal(fg?.width, 90);
  assert.equal(fg?.lane, 0);
  assert.equal(fg?.slotLabel, 'foreground 1');
  assert.equal(fg?.progress, 0.42);
  assert.equal(fg?.indeterminate, false);

  assert.equal(bg?.sceneIndex, 2);
  assert.equal(bg?.left, 90);
  assert.equal(bg?.width, 120);
  assert.equal(bg?.lane, 0);
  assert.equal(bg?.takeCounter, 'take 3 of 3');
  assert.equal(bg?.ariaLabel, 'Scene 2 background, take 3 of 3, needs review');
  assert.equal(bg?.badge, STATE_STYLE.review.badge);
  assert.equal(bg?.tone, 'amber');

  assert.equal(presenter?.sceneIndex, 2);
  assert.equal(presenter?.lane, 1);
  assert.equal(presenter?.ariaLabel, 'Scene 2 presenter, take 1 of 1, approved');
});

test('take counter shows the selected take and "+1 new"', () => {
  assert.equal(formatTakeCounter(3, 3), 'take 3 of 3');
  assert.equal(formatTakeCounter(3, 2, 1), 'take 2 of 3, +1 new');
  assert.equal(formatTakeCounter({ takeCount: 3, selectedN: null }), '3 takes');
  assert.equal(formatTakeCounter({ takeCount: 1 }), '1 take');
  assert.equal(formatTakeCounter(0), '');
  assert.equal(formatTakeCounter({ takeCount: 3, selectedN: 1, newTakes: 2 }), 'take 1 of 3, +2 new');

  const [chip] = clipChips(timeline, [clip({ clipId: 's2:a_bg', sceneId: 's2', selectedN: 2, newTakes: 1 })]);
  assert.equal(chip?.newTakes, 1);
  assert.equal(chip?.takeCounter, 'take 2 of 3, +1 new');
  assert.match(chip?.ariaLabel ?? '', /take 2 of 3, \+1 new, needs review/);
});

test('generating progress is normalised, clamped and indeterminate when unknown', () => {
  const chips = clipChips(timeline, [
    clip({ clipId: 's1:a', sceneId: 's1', state: 'generating', lastJob: { progress: 42 } }),
    clip({ clipId: 's2:a', sceneId: 's2', from: 90, state: 'generating', lastJob: { progress: 1 } }),
    clip({ clipId: 's3:a', sceneId: 's3', from: 210, state: 'generating', lastJob: { progress: 250 } }),
  ]);
  assert.deepEqual(chips.map(chip => chip.progress), [0.42, 1, 1]);
  assert.deepEqual(chips.map(chip => chip.indeterminate), [false, false, false]);

  const unknown = clipChips(timeline, [clip({ clipId: 's1:b', sceneId: 's1', state: 'generating', lastJob: {} })]);
  assert.equal(unknown[0]?.progress, null);
  assert.equal(unknown[0]?.indeterminate, true);

  const approved = clipChips(timeline, [clip({ clipId: 's1:c', sceneId: 's1', state: 'approved', lastJob: { progress: 0.5 } })]);
  assert.equal(approved[0]?.progress, null);
  assert.equal(approved[0]?.indeterminate, false);
});

test('failed chips keep the runner error in the title without changing the aria label', () => {
  const [chip] = clipChips(timeline, [clip({ clipId: 's1:a', sceneId: 's1', state: 'failed', lastJob: { state: 'failed', error: 'runner ran out of memory' } })]);
  assert.equal(chip?.ariaLabel, 'Scene 1 background, take 3 of 3, failed');
  assert.equal(chip?.title, 'Scene 1 background, take 3 of 3, failed: runner ran out of memory');
  assert.equal(chip?.badge, '!');
});

test('clips outside the compiled timeline are dropped and empty input is safe', () => {
  assert.deepEqual(clipChips(null, [clip({ clipId: 's1:a', sceneId: 's1' })]), []);
  assert.deepEqual(clipChips(timeline, null), []);
  assert.deepEqual(clipChips(timeline, []), []);
  const chips = clipChips(timeline, [
    clip({ clipId: 'gone:a', sceneId: 'gone' }),
    clip({ clipId: 's1:a', sceneId: 's1' }),
  ]);
  assert.deepEqual(chips.map(chip => chip.clipId), ['s1:a']);
});

test('[ and ] cycle takes and A approves while a clip is focused', () => {
  const base = { meta: false, ctrl: false, shift: false, alt: false, typing: false, onButton: false };
  assert.deepEqual(clipKeyboardAction({ ...base, key: '[' }), { type: 'prev-take' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: ']' }), { type: 'next-take' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: 'a' }), { type: 'approve' });
  assert.deepEqual(clipKeyboardAction({ ...base, key: 'A', shift: true }), { type: 'approve' });
  assert.equal(clipKeyboardAction({ ...base, key: 'A', ctrl: true }), null);
  assert.equal(clipKeyboardAction({ ...base, key: 'a', meta: true }), null);
  assert.equal(clipKeyboardAction({ ...base, key: 'a', alt: true }), null);
  assert.equal(clipKeyboardAction({ ...base, key: '[', typing: true }), null);
  assert.equal(clipKeyboardAction({ ...base, key: 'x' }), null);
});
