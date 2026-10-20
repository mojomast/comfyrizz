import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allocate, cutsInsideSpeech, FINDING_CODES } from './allocate.mjs';

const FPS = 30;

function jokeUtterances() {
  return [
    { id: 'u1', speaker: 'ada', text: 'Here is the setup.', startS: 1, endS: 3, timing: 'measured' },
    { id: 'u2', speaker: 'ada', text: 'Today I cannot reach my sandwich.', startS: 3.2, endS: 6, timing: 'measured' },
    { id: 'u3', speaker: 'reporter', text: 'The commission continues.', startS: 6.5, endS: 9, timing: 'measured' },
  ];
}

function jokeBeats() {
  return [
    { id: 'b_setup', role: 'setup', utterance: 'u1' },
    { id: 'b_reveal', role: 'reveal', utterance: 'u2' },
    { id: 'b_reaction', role: 'reaction', after: 'u2', holdS: 1, reason: 'hold on the unreachable sandwich' },
    { id: 'b_payoff', role: 'payoff', utterance: 'u3' },
    { id: 'b_action', role: 'action', after: 'u3', holdS: 2, reason: 'hold on the raccoon portrait' },
  ];
}

test('allocation hits exactly 18000 frames without a fixed 300-frame grid', () => {
  const shots = allocate(jokeUtterances(), jokeBeats(), { targetS: 600, fps: FPS });
  const total = shots.reduce((sum, shot) => sum + (shot.out - shot.in), 0);

  assert.equal(shots.totalFrames, 18000);
  assert.equal(shots.targetFrames, 18000);
  assert.equal(total, 18000);
  assert.equal(shots.ok, true);
  assert.ok(shots.length > 5);
  assert.equal(shots.some((shot) => shot.durationFrames !== 300), true);
  assert.equal(shots.some((shot) => 'preferredFrames' in shot), false);
  for (const shot of shots) {
    assert.equal(Number.isInteger(shot.in), true, `${shot.id} in`);
    assert.equal(Number.isInteger(shot.out), true, `${shot.id} out`);
    assert.equal(shot.out - shot.in, shot.durationFrames, `${shot.id} duration`);
    assert.ok(shot.out > shot.in, `${shot.id} is non-empty`);
  }
});

test('shot ranges partition the film contiguously from 0 to targetFrames', () => {
  const shots = allocate(jokeUtterances(), jokeBeats());
  let cursor = 0;
  for (const shot of shots) {
    assert.equal(shot.in, cursor, `${shot.id} must start where the previous one ended`);
    cursor = shot.out;
  }
  assert.equal(cursor, shots.targetFrames);
});

test('setup/reveal/reaction places the reveal cut on the punchline end', () => {
  const utterances = jokeUtterances();
  const shots = allocate(utterances, jokeBeats());
  const punchline = utterances.find((utterance) => utterance.id === 'u2');
  const punchlineEnd = Math.round(punchline.endS * FPS);

  const reveal = shots.find((shot) => shot.beat === 'b_reveal');
  assert.equal(reveal.role, 'reveal');
  assert.equal(reveal.utteranceIds.includes('u2'), true);
  assert.equal(reveal.out, punchlineEnd);
  assert.equal(reveal.endS, 6);

  const reaction = shots.find((shot) => shot.beat === 'b_reaction');
  assert.equal(reaction.role, 'reaction');
  assert.equal(reaction.in, punchlineEnd);
  assert.ok(reaction.durationFrames > 0, 'reaction pause must survive');
  assert.equal(reaction.reason, 'hold on the unreachable sandwich');

  assert.equal(shots.pauses.length, 1);
  assert.equal(shots.pauses[0].shotId, reaction.id);
  assert.equal(shots.pauses[0].startFrame, punchlineEnd);
  assert.ok(shots.pauses[0].endFrame > shots.pauses[0].startFrame);
});

test('a reaction hold is trimmed into the real gap rather than moving speech', () => {
  const utterances = jokeUtterances();
  const beats = jokeBeats();
  beats[2].holdS = 2; // only 0.5 s exists before u3 starts
  const shots = allocate(utterances, beats);
  const reaction = shots.find((shot) => shot.beat === 'b_reaction');
  const payoff = shots.find((shot) => shot.beat === 'b_payoff');
  const u3 = utterances.find((utterance) => utterance.id === 'u3');

  assert.equal(reaction.durationFrames, Math.round((u3.startS - 6) * FPS));
  assert.equal(reaction.out, payoff.in);
  assert.equal(payoff.in, Math.round(u3.startS * FPS));
  const trim = shots.adjustments.find((adjustment) => adjustment.shotId === reaction.id);
  assert.ok(trim);
  assert.equal(trim.cause, 'overlap_trim');
  assert.ok(trim.deltaFrames < 0);
});

test('stretching holds to the target never changes measured speech frames', () => {
  const utterances = jokeUtterances();
  const beats = jokeBeats();
  const short = allocate(utterances, beats, { targetS: 60, fps: FPS });
  const long = allocate(utterances, beats, { targetS: 600, fps: FPS });

  assert.equal(short.totalFrames, 1800);
  assert.equal(long.totalFrames, 18000);

  for (const beat of ['b_setup', 'b_reveal', 'b_payoff']) {
    const a = short.find((shot) => shot.beat === beat);
    const b = long.find((shot) => shot.beat === beat);
    assert.equal(a.in, b.in, `${beat} in is measured, not target-driven`);
    assert.equal(a.out, b.out, `${beat} out is measured, not target-driven`);
  }
  for (const utterance of utterances) {
    const start = Math.round(utterance.startS * FPS);
    const end = Math.round(utterance.endS * FPS);
    const shot = long.find((candidate) => candidate.utteranceIds.includes(utterance.id));
    assert.equal(shot.in <= start, true);
    assert.equal(shot.out >= end, true);
  }
  assert.equal(utterances[1].timing, 'measured');
});

test('all dialogue is retained exactly once', () => {
  const utterances = jokeUtterances();
  const shots = allocate(utterances, jokeBeats());

  assert.deepEqual(shots.droppedUtteranceIds, []);
  assert.deepEqual(shots.retainedUtteranceIds, ['u1', 'u2', 'u3']);
  assert.equal(shots.retainedUtterances.length, 3);

  for (const utterance of utterances) {
    const retained = shots.retainedUtterances.find((item) => item.id === utterance.id);
    assert.ok(retained);
    assert.equal(retained.text, utterance.text);
    assert.equal(retained.speaker, utterance.speaker);
    assert.equal(retained.timing, 'measured');
    assert.ok(shots.some((shot) => shot.dialogue.some((line) => line.id === utterance.id)));
  }
});

test('utterances without a beat are still allocated', () => {
  const utterances = [
    ...jokeUtterances(),
    { id: 'u4', speaker: 'ada', text: 'An extra sentence that has no beat.', startS: 9.5, endS: 11 },
  ];
  const shots = allocate(utterances, jokeBeats());
  const extra = shots.find((shot) => shot.utteranceIds.includes('u4'));
  assert.ok(extra);
  assert.equal(extra.in, Math.round(9.5 * FPS));
  assert.equal(extra.out, Math.round(11 * FPS));
  assert.deepEqual(shots.droppedUtteranceIds, []);
});

test('every action hold carries its editorial reason', () => {
  const shots = allocate(jokeUtterances(), jokeBeats());
  const action = shots.find((shot) => shot.beat === 'b_action');
  assert.equal(action.role, 'action');
  assert.equal(action.reason, 'hold on the raccoon portrait');
  assert.ok(action.durationFrames >= 60);
  for (const shot of shots.filter((candidate) => candidate.role === 'action')) {
    assert.equal(typeof shot.reason, 'string');
    assert.ok(shot.reason.length > 0);
  }
});

test('cuts inside speech are listed with an explanation or a nearest boundary', () => {
  const utterances = [{ id: 'u1', speaker: 'ada', text: 'A long measured line.', startS: 1, endS: 5 }];
  const shots = [
    { id: 's1', in: 30, out: 60 },
    { id: 's2', in: 60, out: 90, cutInReason: 'b-roll of the sandwich' },
    { id: 's3', in: 90, out: 120 },
    { id: 's4', in: 120, out: 150, cutInReason: 'reaction' },
  ];
  const cuts = cutsInsideSpeech(shots, utterances, { fps: FPS });

  assert.equal(cuts.length, 3);
  assert.deepEqual(cuts.map((cut) => cut.cutFrame), [60, 90, 120]);
  assert.deepEqual(cuts.map((cut) => cut.explained), [true, false, true]);
  assert.deepEqual(cuts.map((cut) => cut.reason), ['b-roll', null, 'reaction']);

  const unexplained = cuts.find((cut) => !cut.explained);
  assert.equal(unexplained.code, FINDING_CODES.CUT_INSIDE_SPEECH);
  assert.equal(unexplained.nearestBoundaryFrame, 30); // tie goes to the start
  assert.match(unexplained.message, /move it to frame 30/i);
});

test('a cut exactly on an utterance boundary is not reported', () => {
  const utterances = [{ id: 'u1', startS: 1, endS: 3 }];
  const shots = [
    { id: 's1', in: 0, out: 30 },
    { id: 's2', in: 30, out: 90 },
    { id: 's3', in: 90, out: 120 },
  ];
  assert.deepEqual(cutsInsideSpeech(shots, utterances, { fps: FPS }), []);
});

test('allocate output can be passed straight into cutsInsideSpeech', () => {
  const utterances = jokeUtterances();
  const shots = allocate(utterances, jokeBeats());
  const cuts = cutsInsideSpeech(shots, utterances, { fps: FPS });
  assert.deepEqual(cuts, []);
  assert.deepEqual(shots.cuts, []);
  assert.deepEqual(shots.findings, []);
});

test('the allocation is deterministic and does not mutate its input', () => {
  const utterances = jokeUtterances();
  const beats = jokeBeats();
  const beforeUtterances = JSON.parse(JSON.stringify(utterances));
  const beforeBeats = JSON.parse(JSON.stringify(beats));

  const first = allocate(utterances, beats);
  const second = allocate(utterances, beats);
  assert.deepEqual(first, second);
  assert.deepEqual(utterances, beforeUtterances);
  assert.deepEqual(beats, beforeBeats);
});

test('integer frames follow the configured fps', () => {
  const shots = allocate(jokeUtterances(), jokeBeats(), { targetS: 20, fps: 24 });
  assert.equal(shots.targetFrames, 480);
  assert.equal(shots.totalFrames, 480);
  assert.equal(shots.fps, 24);
  for (const shot of shots) {
    assert.equal(Number.isInteger(shot.in), true);
    assert.equal(Number.isInteger(shot.out), true);
  }
});

test('malformed input is rejected instead of guessed', () => {
  assert.throws(() => allocate(null, []), TypeError);
  assert.throws(() => allocate([], null), TypeError);
  assert.throws(() => allocate([], [], { fps: 0 }), TypeError);
  assert.throws(() => allocate([], [], { targetS: 0 }), TypeError);
  assert.throws(
    () => allocate([{ id: 'same', startS: 0, endS: 1 }, { id: 'same', startS: 2, endS: 3 }], []),
    RangeError,
  );
  assert.throws(() => allocate([{ id: 'u1', startS: 4, endS: 4 }], []), RangeError);
});

test('no output carries secret-like values', () => {
  const shots = allocate(jokeUtterances(), jokeBeats());
  const text = JSON.stringify(shots);
  assert.equal(/password|secret|api[_-]?key|bearer/i.test(text), false);
});
