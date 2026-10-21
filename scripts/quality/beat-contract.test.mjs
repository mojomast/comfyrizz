import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAT_SCHEMA,
  REVIEW_EVIDENCE_KINDS,
  validateBeat,
  validateBeatPlan,
} from './beat-contract.mjs';

// The proposed contract from docs/research/MOCKUMENTARY_QUALITY_REVIEW_20261020.md
// section 3 (P0), quoted as written.
const s08UnreachableSandwich = {
  beat: 's08_unreachable_sandwich',
  speaker: 'painter',
  participants: ['painter'],
  dialogueAnchor: "Today I can't reach my sandwich",
  requiredProps: ['sandwich_01', 'pose_frame_01'],
  before: { painterHands: 'empty', sandwich: 'outside reach' },
  duringLine: { sandwich: 'outside reach' },
  rejectIf: ['painter holds sandwich', 'sandwich handed to painter'],
  reviewEvidence: ['approved first frame', 'action midpoint', 'end frame'],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function paths(result) {
  return result.errors.map((error) => error.path);
}

test('the review s08_unreachable_sandwich example validates', () => {
  const result = validateBeat(clone(s08UnreachableSandwich));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('the schema constant and evidence kinds match the review contract', () => {
  assert.equal(BEAT_SCHEMA, 'comfyrizz.beat/v1');
  assert.deepEqual(REVIEW_EVIDENCE_KINDS, [
    'approved first frame',
    'action midpoint',
    'end frame',
  ]);
});

test('an explicit comfyrizz.beat/v1 schema is accepted and a wrong one rejected', () => {
  const ok = validateBeat({ ...clone(s08UnreachableSandwich), schema: BEAT_SCHEMA });
  assert.equal(ok.ok, true);

  const bad = validateBeat({ ...clone(s08UnreachableSandwich), schema: 'comfyrizz.beat/v2' });
  assert.equal(bad.ok, false);
  assert.ok(paths(bad).includes('$.schema'));
});

test('missing dialogueAnchor is rejected with its JSON path', () => {
  const beat = clone(s08UnreachableSandwich);
  delete beat.dialogueAnchor;
  const result = validateBeat(beat);
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.dialogueAnchor'));
  assert.equal(result.errors.find((e) => e.path === '$.dialogueAnchor').code, 'MISSING_DIALOGUE_ANCHOR');
});

test('empty dialogueAnchor is rejected with its JSON path', () => {
  const beat = { ...clone(s08UnreachableSandwich), dialogueAnchor: '   ' };
  const result = validateBeat(beat);
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.dialogueAnchor'));
});

test('a speaker who is not a participant is rejected with its JSON path', () => {
  const beat = clone(s08UnreachableSandwich);
  beat.participants = ['reporter'];
  const result = validateBeatPlan({ beats: [beat] });
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.beats[0].speaker'));
  assert.equal(
    result.errors.find((e) => e.path === '$.beats[0].speaker').code,
    'SPEAKER_NOT_PARTICIPANT',
  );
});

test('duplicate beat ids are rejected on the later occurrence', () => {
  const first = clone(s08UnreachableSandwich);
  const second = {
    ...clone(s08UnreachableSandwich),
    dialogueAnchor: "Today I can't reach my sandwich, again",
  };
  const result = validateBeatPlan({ beats: [first, second] });
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.beats[1].beat'));
  assert.equal(
    result.errors.find((e) => e.path === '$.beats[1].beat').code,
    'DUPLICATE_BEAT_ID',
  );
});

test('a plan with unique ids and participant speakers validates', () => {
  const result = validateBeatPlan({
    schema: 'comfyrizz.beat-plan/v1',
    beats: [
      clone(s08UnreachableSandwich),
      {
        beat: 's09_chair_gag',
        speaker: 'ada',
        participants: ['ada', 'reporter'],
        dialogueAnchor: "I haven't sat down since Tuesday",
        requiredProps: ['chair_01'],
        before: { chair: 'empty' },
        duringLine: { chair: 'empty', adaStanding: true },
        rejectIf: ['reporter seated in Ada chair'],
        reviewEvidence: ['approved first frame', 'end frame'],
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.count, 2);
});

test('a bare array of beats is accepted as a plan', () => {
  const result = validateBeatPlan([clone(s08UnreachableSandwich)]);
  assert.equal(result.ok, true);
});

test('reviewEvidence outside the approved set is rejected with its JSON path', () => {
  const beat = clone(s08UnreachableSandwich);
  beat.reviewEvidence = ['approved first frame', 'model score 0.97'];
  const result = validateBeat(beat);
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.reviewEvidence[1]'));
  assert.equal(
    result.errors.find((e) => e.path === '$.reviewEvidence[1]').code,
    'INVALID_REVIEW_EVIDENCE',
  );
});

test('required props must be versioned ids', () => {
  const beat = { ...clone(s08UnreachableSandwich), requiredProps: ['sandwich'] };
  const result = validateBeat(beat);
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.requiredProps[0]'));
  assert.equal(
    result.errors.find((e) => e.path === '$.requiredProps[0]').code,
    'UNVERSIONED_PROP_ID',
  );
});

test('after is optional but must be an object when present', () => {
  const withAfter = { ...clone(s08UnreachableSandwich), after: { sandwich: 'reached' } };
  assert.equal(validateBeat(withAfter).ok, true);

  const badAfter = { ...clone(s08UnreachableSandwich), after: 'reached' };
  const result = validateBeat(badAfter);
  assert.equal(result.ok, false);
  assert.ok(paths(result).includes('$.after'));
});

test('a malformed or missing beats plan is rejected with a path', () => {
  const objectPlan = validateBeatPlan({ schema: 'comfyrizz.beat-plan/v1' });
  assert.equal(objectPlan.ok, false);
  assert.ok(paths(objectPlan).includes('$.beats'));

  const scalarPlan = validateBeatPlan('not-a-plan');
  assert.equal(scalarPlan.ok, false);
  assert.ok(paths(scalarPlan).includes('$'));
});

test('validation does not mutate the input', () => {
  const beat = clone(s08UnreachableSandwich);
  const snapshot = clone(beat);
  validateBeat(beat);
  validateBeatPlan({ beats: [beat] });
  assert.deepEqual(beat, snapshot);
});
