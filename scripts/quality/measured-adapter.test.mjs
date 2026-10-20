import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { allocate } from './allocate.mjs';
import { toDurationsReport } from './measured-adapter.mjs';

// Hand-copied minimal contract from packages/planner/src/measured.ts (read
// only; the planner package is never imported or edited by this adapter):
//
//   export interface DurationsReport {
//     engine?: string;
//     gapSeconds?: number;
//     paddingSeconds?: number;
//     scenes?: Record<string, { chunks?: NarrationChunk[] }>;
//   }
//   export interface NarrationChunk {
//     text: string;
//     seconds: number;
//     words?: NarrationWord[];
//     timing?: NarrationTiming;
//   }
//   export interface NarrationWord { text: string; start: number; end: number; }
//   export type NarrationTiming = 'aligner' | 'syllable-fallback' | (string & {});
//
// measuredFromReport reads only `scenes[sceneId].chunks[]` (plus the optional
// gap/padding/engine fields), so this fixture asserts exactly that shape while
// the editorial data lives beside it in the scene-keyed sidecar.

const FPS = 30;

function measuredUtterances() {
  return [
    {
      id: 'u1',
      scene: 's_kitchen',
      speaker: 'Ada',
      text: 'Here is the setup.',
      startS: 1,
      endS: 3,
      timing: 'measured',
    },
    {
      id: 'u2',
      scene: 's_kitchen',
      speaker: 'Ada',
      text: "Today I cannot reach my sandwich.",
      startS: 3.2,
      endS: 6,
      timing: 'measured',
      words: [
        { text: 'Today', start: 0, end: 0.35 },
        { text: 'sandwich.', start: 2.1, end: 2.8 },
      ],
    },
    {
      id: 'u3',
      scene: 's_courtroom',
      speaker: 'Reporter',
      text: 'The commission continues.',
      startS: 6.5,
      endS: 9,
      timing: 'estimated',
    },
  ];
}

function jokeBeats() {
  return [
    { id: 'b_setup', scene: 's_kitchen', role: 'setup', utterance: 'u1' },
    { id: 'b_reveal', scene: 's_kitchen', role: 'reveal', utterance: 'u2' },
    {
      id: 'b_reaction',
      scene: 's_kitchen',
      role: 'reaction',
      after: 'u2',
      holdS: 1,
      reason: 'hold on the unreachable sandwich',
    },
    { id: 'b_payoff', scene: 's_courtroom', role: 'payoff', utterance: 'u3' },
    {
      id: 'b_action',
      scene: 's_courtroom',
      role: 'action',
      after: 'u3',
      holdS: 2,
      reason: 'hold on the raccoon portrait',
    },
  ];
}

function fixture() {
  const utterances = measuredUtterances();
  const shots = allocate(utterances, jokeBeats(), { targetS: 20, fps: FPS });
  return { utterances, shots };
}

function assertDurationsReportShape(report) {
  assert.equal(typeof report, 'object');
  assert.ok(report !== null);
  if ('engine' in report) assert.equal(typeof report.engine, 'string');
  if ('gapSeconds' in report) assert.equal(Number.isFinite(report.gapSeconds), true);
  if ('paddingSeconds' in report) assert.equal(Number.isFinite(report.paddingSeconds), true);
  assert.equal(typeof report.scenes, 'object');
  for (const [sceneId, scene] of Object.entries(report.scenes)) {
    assert.equal(typeof sceneId, 'string');
    assert.ok(Array.isArray(scene.chunks), `${sceneId} chunks`);
    for (const chunk of scene.chunks) {
      assert.equal(typeof chunk.text, 'string');
      assert.equal(Number.isFinite(chunk.seconds), true);
      assert.equal(chunk.seconds > 0, true);
      if ('words' in chunk) {
        for (const word of chunk.words) {
          assert.equal(typeof word.text, 'string');
          assert.equal(Number.isFinite(word.start), true);
          assert.equal(Number.isFinite(word.end), true);
          assert.ok(word.end >= word.start);
        }
      }
      if ('timing' in chunk) assert.equal(typeof chunk.timing, 'string');
    }
  }
}

test('output satisfies the hand-copied DurationsReport contract', () => {
  const { utterances, shots } = fixture();
  const report = toDurationsReport(utterances, shots, {
    engine: 'kokoro-onnx',
    gapSeconds: 0.15,
    paddingSeconds: 0.25,
  });

  assertDurationsReportShape(report);
  assert.equal(report.engine, 'kokoro-onnx');
  assert.equal(report.gapSeconds, 0.15);
  assert.equal(report.paddingSeconds, 0.25);

  assert.deepEqual(report.scenes.s_kitchen.chunks.map((chunk) => chunk.text), [
    'Here is the setup.',
    "Today I cannot reach my sandwich.",
  ]);
  assert.deepEqual(report.scenes.s_courtroom.chunks.map((chunk) => chunk.text), [
    'The commission continues.',
  ]);
  assert.deepEqual(report.scenes.s_kitchen.chunks[1].words, utterances[1].words);
});

test('every scene id appears once and keeps integer frame ranges', () => {
  const { utterances, shots } = fixture();
  const report = toDurationsReport(utterances, shots);

  assert.deepEqual(report.sceneIds, ['s_courtroom', 's_kitchen']);
  assert.equal(new Set(report.sceneIds).size, report.sceneIds.length);
  assert.deepEqual(Object.keys(report.scenes).sort(), report.sceneIds);
  assert.deepEqual(Object.keys(report.sidecar).sort(), report.sceneIds);

  for (const sceneId of report.sceneIds) {
    const scene = report.sidecar[sceneId];
    assert.equal(Number.isInteger(scene.startFrame), true, `${sceneId} startFrame`);
    assert.equal(Number.isInteger(scene.endFrame), true, `${sceneId} endFrame`);
    assert.equal(Number.isInteger(scene.durationFrames), true, `${sceneId} durationFrames`);
    assert.equal(scene.durationFrames, scene.endFrame - scene.startFrame);

    for (const utterance of scene.utterances) {
      for (const key of ['startFrame', 'endFrame', 'durationFrames']) {
        assert.equal(Number.isInteger(utterance[key]), true, `${utterance.id}.${key}`);
      }
      assert.equal(utterance.durationFrames, utterance.endFrame - utterance.startFrame);
    }
    for (const pause of scene.pauses) {
      assert.equal(Number.isInteger(pause.startFrame), true);
      assert.equal(Number.isInteger(pause.endFrame), true);
      assert.equal(pause.durationFrames, pause.endFrame - pause.startFrame);
    }
    for (const clip of scene.clips) {
      for (const key of ['in', 'out', 'startFrame', 'endFrame', 'durationFrames']) {
        assert.equal(Number.isInteger(clip[key]), true, `${clip.id}.${key}`);
      }
      assert.equal(clip.out, clip.endFrame);
      assert.equal(clip.in, clip.startFrame);
      assert.equal(clip.durationFrames, clip.out - clip.in);
    }
  }
});

test('measured and estimated provenance is preserved per utterance and chunk', () => {
  const { utterances, shots } = fixture();
  const report = toDurationsReport(utterances, shots);

  const byId = new Map(
    Object.values(report.sidecar)
      .flatMap((scene) => scene.utterances)
      .map((utterance) => [utterance.id, utterance]),
  );
  assert.equal(byId.get('u1').timing, 'measured');
  assert.equal(byId.get('u2').timing, 'measured');
  assert.equal(byId.get('u3').timing, 'estimated');

  assert.equal(report.scenes.s_kitchen.chunks[0].timing, 'measured');
  assert.equal(report.scenes.s_kitchen.chunks[1].timing, 'measured');
  assert.equal(report.scenes.s_courtroom.chunks[0].timing, 'estimated');
  assert.equal(report.scenes.s_kitchen.timing, 'estimated');
});

test('a speaker registry with stable ids tags every utterance', () => {
  const { utterances, shots } = fixture();
  const first = toDurationsReport(utterances, shots);

  assert.deepEqual(first.speakers, [
    { id: 'spk_ada', name: 'Ada' },
    { id: 'spk_reporter', name: 'Reporter' },
  ]);
  assert.equal(first.speakerIds.Ada, 'spk_ada');
  assert.equal(first.speakerRegistry.spk_reporter, 'Reporter');

  for (const scene of Object.values(first.sidecar)) {
    for (const utterance of scene.utterances) {
      assert.ok(utterance.speakerId);
      assert.equal(first.speakerRegistry[utterance.speakerId], utterance.speaker);
    }
    for (const clip of scene.clips) {
      for (const speakerId of clip.speakerIds) {
        assert.ok(first.speakerRegistry[speakerId]);
      }
    }
  }

  const shuffled = toDurationsReport(
    [...utterances].reverse(),
    [...shots].reverse(),
    { fps: FPS },
  );
  assert.deepEqual(shuffled.speakers, first.speakers);
  assert.deepEqual(shuffled.speakerIds, first.speakerIds);
  assert.deepEqual(shuffled.scenes, first.scenes);
  assert.deepEqual(shuffled.sidecar, first.sidecar);
});

test('selected clip ranges cover every shot exactly once', () => {
  const { utterances, shots } = fixture();
  const report = toDurationsReport(utterances, shots);
  const clips = Object.values(report.sidecar).flatMap((scene) => scene.clips);
  const byId = new Map(clips.map((clip) => [clip.shotId, clip]));

  assert.equal(clips.length, shots.length);
  assert.equal(byId.size, shots.length);
  for (const shot of shots) {
    const clip = byId.get(shot.id);
    assert.ok(clip, `missing clip for ${shot.id}`);
    assert.equal(clip.in, shot.in);
    assert.equal(clip.out, shot.out);
    assert.equal(clip.timing, shot.timing);
    assert.deepEqual(clip.utteranceIds, shot.utteranceIds);
  }
  assert.equal(
    clips.reduce((sum, clip) => sum + clip.durationFrames, 0),
    shots.reduce((sum, shot) => sum + shot.durationFrames, 0),
  );
});

test('reaction pauses stay in their scene sidecar', () => {
  const { utterances, shots } = fixture();
  const report = toDurationsReport(utterances, shots);
  const pause = report.sidecar.s_kitchen.pauses[0];

  assert.ok(pause);
  assert.equal(pause.reason, 'hold on the unreachable sandwich');
  assert.equal(pause.timing, 'estimated');
  assert.equal(pause.startFrame, Math.round(6 * FPS));
  assert.equal(pause.endFrame, Math.round(6.5 * FPS));
  assert.deepEqual(report.sidecar.s_courtroom.pauses, []);
});

test('shots without a scene inherit it from their measured utterance', () => {
  const utterances = [
    { id: 'u1', scene: 's_opening', speaker: 'Nell', text: 'One line.', startS: 1, endS: 2 },
    { id: 'u2', scene: 's_payoff', speaker: 'Nell', text: 'Another line.', startS: 3, endS: 4 },
  ];
  const shots = [
    { id: 'c1', in: 30, out: 60, utteranceIds: ['u1'], kind: 'dialogue' },
    { id: 'c2', in: 90, out: 120, utteranceIds: ['u2'], kind: 'dialogue' },
  ];
  const report = toDurationsReport(utterances, shots, { fps: FPS });

  assert.deepEqual(report.sceneIds, ['s_opening', 's_payoff']);
  assert.deepEqual(report.sidecar.s_opening.clips.map((clip) => clip.shotId), ['c1']);
  assert.deepEqual(report.sidecar.s_payoff.clips.map((clip) => clip.shotId), ['c2']);
});

test('an utterance without a scene inherits it from its shot', () => {
  const utterances = [
    { id: 'u1', speaker: 'Ada', text: 'Measured line.', startS: 2, endS: 3 },
  ];
  const shots = [{ id: 'c1', scene: 's_chair', in: 30, out: 120, utteranceIds: ['u1'] }];
  const report = toDurationsReport(utterances, shots, { fps: FPS });

  assert.deepEqual(report.sceneIds, ['s_chair']);
  assert.equal(report.sidecar.s_chair.utterances[0].startFrame, 60);
  assert.equal(report.sidecar.s_chair.utterances[0].endFrame, 90);
});

test('the adapter is deterministic and does not mutate its input', () => {
  const { utterances, shots } = fixture();
  const utteranceCopy = JSON.parse(JSON.stringify(utterances));
  const shotCopy = JSON.parse(JSON.stringify(shots));

  const first = toDurationsReport(utterances, shots);
  const second = toDurationsReport(utterances, shots);
  assert.deepEqual(first, second);
  assert.deepEqual(utterances, utteranceCopy);
  assert.deepEqual(JSON.parse(JSON.stringify(shots)), shotCopy);
});

test('malformed input is rejected instead of guessed', () => {
  assert.throws(() => toDurationsReport(null, []), TypeError);
  assert.throws(() => toDurationsReport([], null), TypeError);
  assert.throws(() => toDurationsReport([{ id: 'a', startS: 0, endS: 1 }, { id: 'a', startS: 2, endS: 3 }], []), RangeError);
  assert.throws(() => toDurationsReport([{ id: 'a', startS: 3, endS: 3 }], []), RangeError);
  assert.throws(() => toDurationsReport([], [{ id: 's', in: 10, out: 10 }]), RangeError);
});

test('no built planner package is imported and no secret-like value is emitted', () => {
  const source = readFileSync(new URL('./measured-adapter.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, 'adapter must stay dependency-free');
  assert.equal(/packages\/[^'"\n]*\/dist/.test(source), false);
  assert.equal(/require\(['"][^'"]*packages\//.test(source), false);

  const { utterances, shots } = fixture();
  const output = JSON.stringify(toDurationsReport(utterances, shots));
  assert.equal(/password|secret|api[_-]?key|bearer|token/i.test(output), false);
});
