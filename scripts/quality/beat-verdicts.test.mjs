import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBeat } from './beat-contract.mjs';
import {
  VERDICT_STATUSES,
  validateVerdict,
  gateBeats,
} from './beat-verdicts.mjs';

// The review's proposed s08_unreachable_sandwich contract
// (MOCKUMENTARY_QUALITY_REVIEW_20261020.md section 3) and its review still at
// 03:46.5 (section 1), used as synthetic fixtures.
const sandwichBeat = {
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

const chairBeat = {
  beat: 's09_chair_gag',
  speaker: 'ada',
  participants: ['ada', 'reporter'],
  dialogueAnchor: "I haven't sat down since Tuesday",
  requiredProps: ['chair_01'],
  before: { chair: 'empty' },
  duringLine: { chair: 'empty', adaStanding: true },
  rejectIf: ['reporter seated in Ada chair'],
  reviewEvidence: ['approved first frame', 'end frame'],
};

const GOOD_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sandwichEvidence() {
  return [
    {
      timestamp: '03:46.5',
      file: 'quality-review/sandwich-226.5.png',
      sha256: GOOD_HASH,
    },
  ];
}

function passedVerdict(beat = sandwichBeat.beat) {
  return {
    beat,
    status: 'passed',
    evidence: [
      { timestamp: '03:41.7', file: 'quality-review/sandwich-first.png', sha256: GOOD_HASH },
      { timestamp: '03:46.5', file: 'quality-review/sandwich-226.5.png', sha256: OTHER_HASH },
    ],
    reviewer: 'editor',
    method: 'frame playback',
  };
}

test('the fixtures satisfy the Q01 beat contract', () => {
  assert.equal(validateBeat(clone(sandwichBeat)).ok, true);
  assert.equal(validateBeat(clone(chairBeat)).ok, true);
});

test('the verdict statuses are the four review states', () => {
  assert.deepEqual(VERDICT_STATUSES, ['passed', 'failed', 'substituted', 'not_reviewed']);
});

test('the sandwich beat failed at 03:46.5 blocks assembly', () => {
  const verdicts = [
    {
      beat: sandwichBeat.beat,
      status: 'failed',
      evidence: sandwichEvidence(),
      reviewer: 'editor',
      method: 'frame playback',
      note: 'Ada holds the tray with the sandwich during the line',
    },
    {
      ...passedVerdict(chairBeat.beat),
    },
  ];

  const result = gateBeats([sandwichBeat, chairBeat], verdicts);

  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].beat, sandwichBeat.beat);
  assert.equal(result.blocking[0].status, 'failed');
  assert.equal(result.blocking[0].code, 'BEAT_FAILED');
  assert.match(result.blocking[0].message, /03:46\.5/);
});

test('a passed verdict without cited evidence is rejected', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'passed',
    evidence: [],
    reviewer: 'editor',
    method: 'frame playback',
  };

  const direct = validateVerdict(verdict);
  assert.equal(direct.ok, false);
  assert.ok(direct.errors.some((error) => error.code === 'EVIDENCE_REQUIRED'));

  const result = gateBeats([sandwichBeat], [verdict]);
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].beat, sandwichBeat.beat);
  assert.equal(result.blocking[0].code, 'EVIDENCE_REQUIRED');
  assert.equal(result.blocking[0].status, 'passed');
});

test('a passed verdict with an unhashed timestamp is rejected', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'passed',
    evidence: [{ timestamp: '03:46.5' }],
    reviewer: 'editor',
    method: 'frame playback',
  };

  const result = gateBeats([sandwichBeat], [verdict]);
  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].beat, sandwichBeat.beat);
  assert.ok(
    result.blocking[0].errors.some((error) => error.code === 'INVALID_SHA256'),
  );
});

test('a substituted beat with a note is allowed through the gate', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'substituted',
    evidence: [],
    reviewer: 'editor',
    method: 'editorial review',
    note: 'Replaced with the wide shot where the sandwich stays on the far table',
  };

  assert.equal(validateVerdict(verdict).ok, true);

  const result = gateBeats([sandwichBeat, chairBeat], [
    verdict,
    passedVerdict(chairBeat.beat),
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test('a substitution without a note is rejected', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'substituted',
    reviewer: 'editor',
    method: 'editorial review',
  };

  const direct = validateVerdict(verdict);
  assert.equal(direct.ok, false);
  assert.ok(direct.errors.some((error) => error.code === 'SUBSTITUTION_NOTE_REQUIRED'));

  const result = gateBeats([sandwichBeat], [verdict]);
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].code, 'SUBSTITUTION_NOTE_REQUIRED');
});

test('a missing verdict is reported as not_reviewed and blocks', () => {
  const result = gateBeats([sandwichBeat, chairBeat], [passedVerdict(chairBeat.beat)]);

  assert.equal(result.ok, false);
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].beat, sandwichBeat.beat);
  assert.equal(result.blocking[0].status, 'not_reviewed');
  assert.equal(result.blocking[0].code, 'NOT_REVIEWED');
});

test('an explicit not_reviewed verdict blocks', () => {
  const result = gateBeats([sandwichBeat], [
    {
      beat: sandwichBeat.beat,
      status: 'not_reviewed',
      evidence: [],
      reviewer: 'editor',
      method: 'frame playback',
    },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].status, 'not_reviewed');
  assert.equal(result.blocking[0].code, 'NOT_REVIEWED');
});

test('a passed verdict citing frame and sha256 allows assembly', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'passed',
    evidence: [
      {
        frame: 6795,
        file: 'quality-review/sandwich-6795.png',
        sha256: GOOD_HASH,
      },
    ],
    reviewer: 'editor',
    method: 'frame playback',
  };

  const result = gateBeats({ beats: [sandwichBeat] }, [verdict]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test('a pass without a reviewer or method is flagged by validateVerdict', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'passed',
    evidence: sandwichEvidence(),
  };

  const direct = validateVerdict(verdict);
  assert.equal(direct.ok, false);
  assert.ok(direct.errors.some((error) => error.code === 'MISSING_REVIEWER'));
  assert.ok(direct.errors.some((error) => error.code === 'MISSING_METHOD'));

  const result = gateBeats([sandwichBeat], [verdict]);
  assert.equal(result.ok, true);
});

test('an unknown verdict status is rejected', () => {
  const verdict = {
    beat: sandwichBeat.beat,
    status: 'looks-good',
    evidence: sandwichEvidence(),
    reviewer: 'editor',
    method: 'frame playback',
  };

  const direct = validateVerdict(verdict);
  assert.equal(direct.ok, false);
  assert.ok(direct.errors.some((error) => error.code === 'INVALID_STATUS'));

  const result = gateBeats([sandwichBeat], [verdict]);
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].code, 'INVALID_STATUS');
});

test('a beat explicitly marked non-critical need not be reviewed', () => {
  const optional = { ...clone(chairBeat), critical: false };
  const result = gateBeats([optional], []);

  assert.equal(result.ok, true);
  assert.deepEqual(result.blocking, []);
});

test('duplicate verdicts for one beat block rather than silently picking one', () => {
  const result = gateBeats([sandwichBeat], [passedVerdict(), passedVerdict()]);

  assert.equal(result.ok, false);
  assert.ok(result.blocking.some((entry) => entry.code === 'DUPLICATE_VERDICT'));
});

test('malformed beat input is blocked with a path-free diagnostic', () => {
  const result = gateBeats('not-a-beat-plan', []);
  assert.equal(result.ok, false);
  assert.equal(result.blocking[0].code, 'INVALID_BEATS');
});

test('gating does not mutate beats or verdicts', () => {
  const beats = clone([sandwichBeat, chairBeat]);
  const verdicts = [passedVerdict(sandwichBeat.beat), passedVerdict(chairBeat.beat)];
  const beatSnapshot = clone(beats);
  const verdictSnapshot = clone(verdicts);

  gateBeats(beats, verdicts);

  assert.deepEqual(beats, beatSnapshot);
  assert.deepEqual(verdicts, verdictSnapshot);
});
