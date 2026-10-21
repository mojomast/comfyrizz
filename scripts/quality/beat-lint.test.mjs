import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import lintShotPlan, { FINDING_CODES, canonicalText, lintShotPlan as namedLint } from './beat-lint.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/sandwich-plan.json', import.meta.url), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(findings) {
  return findings.map((finding) => finding.code);
}

function sandwichBeat() {
  return clone(fixture.cases.sandwichContradiction.beats[0]);
}

test('the fixture is the review sandwich/chair example and not production data', () => {
  assert.equal(fixture.schema, 'comfyrizz.beat-lint-fixture/v1');
  assert.deepEqual(Object.keys(fixture.cases).sort(), [
    'chairSpeakerUnassigned',
    'clean',
    'sandwichContradiction',
  ]);
});

test('a prompt that hands the sandwich to the painter during the line is PROMPT_CONTRADICTS', () => {
  const plan = fixture.cases.sandwichContradiction;
  const findings = lintShotPlan(plan.beats, plan.shots, plan.script);

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    beat: 's08_unreachable_sandwich',
    shot: 'shot-sandwich',
    code: 'PROMPT_CONTRADICTS',
    message: findings[0].message,
  });
  assert.match(findings[0].message, /rejectIf "sandwich handed to painter"/);
  assert.match(findings[0].message, /outside reach/);
});

test('a chair shot that seats the reporter but not Ada is SPEAKER_UNASSIGNED', () => {
  const plan = fixture.cases.chairSpeakerUnassigned;
  const findings = lintShotPlan(plan.beats, plan.shots, plan.script);

  assert.deepEqual(codes(findings), ['SPEAKER_UNASSIGNED']);
  assert.equal(findings[0].beat, 's02_chair_gag');
  assert.equal(findings[0].shot, 'shot-chair');
  assert.match(findings[0].message, /ada/);
  assert.match(findings[0].message, /participants/);
});

test('the clean plan produces no findings', () => {
  const plan = fixture.cases.clean;
  const findings = lintShotPlan(plan.beats, plan.shots, plan.script);

  assert.deepEqual(findings, []);
});

test('a dialogueAnchor outside the speaker lines is ANCHOR_MISSING', () => {
  const beat = sandwichBeat();
  const script = [{ speaker: 'painter', text: 'The sandwich is on the high shelf.' }];
  const findings = lintShotPlan([beat], [], script);

  assert.deepEqual(codes(findings), ['ANCHOR_MISSING']);
  assert.equal(findings[0].shot, null);
  assert.match(findings[0].message, /Today I can't reach my sandwich/);
});

test('a missing dialogueAnchor and an unknown speaker are both ANCHOR_MISSING', () => {
  const beat = sandwichBeat();
  beat.dialogueAnchor = '';

  const missingAnchor = lintShotPlan([beat], [], [{ speaker: 'painter', text: 'Anything.' }]);
  assert.deepEqual(codes(missingAnchor), ['ANCHOR_MISSING']);

  const missingSpeaker = lintShotPlan(
    [sandwichBeat()],
    [],
    [{ speaker: 'reporter', text: "Today I can't reach my sandwich." }],
  );
  assert.deepEqual(codes(missingSpeaker), ['ANCHOR_MISSING']);
});

test('anchor matching ignores case, punctuation and curly apostrophes', () => {
  const findings = lintShotPlan(
    [sandwichBeat()],
    [],
    [{ speaker: 'Painter', text: 'TODAY I can\u2019t reach my sandwich!' }],
  );

  assert.deepEqual(findings, []);
});

test('an unlicensed state change is STATE_CHANGE_UNLICENSED', () => {
  const beat = sandwichBeat();
  beat.duringLine = { sandwich: 'in painter hand' };
  const findings = lintShotPlan(
    [beat],
    [],
    [{ speaker: 'painter', text: "Today I can't reach my sandwich." }],
  );

  assert.deepEqual(codes(findings), ['STATE_CHANGE_UNLICENSED']);
  assert.equal(findings[0].shot, null);
  assert.match(findings[0].message, /licensing phrase/);
});

test('a state change licensed by an explicit beat phrase is allowed', () => {
  const beat = sandwichBeat();
  beat.dialogueAnchor = 'hand it over';
  beat.licensingPhrase = 'hand it over';
  beat.duringLine = { sandwich: 'in painter hand' };

  const findings = lintShotPlan(
    [beat],
    [],
    [{ speaker: 'painter', text: "I can't reach it, so hand it over." }],
  );

  assert.deepEqual(findings, []);
});

test('a negated verb does not license a state change, an unnegated verb does', () => {
  const beat = sandwichBeat();
  beat.before = { sandwich: 'outside reach' };
  beat.duringLine = { sandwich: 'in painter hand' };

  const negatedBeat = { ...clone(beat), dialogueAnchor: "I can't take the sandwich" };
  const negated = lintShotPlan(
    [negatedBeat],
    [],
    [{ speaker: 'painter', text: "I can't take the sandwich." }],
  );
  assert.deepEqual(codes(negated), ['STATE_CHANGE_UNLICENSED']);

  const licensedBeat = { ...clone(beat), dialogueAnchor: 'I take the sandwich now' };
  const licensed = lintShotPlan(
    [licensedBeat],
    [],
    [{ speaker: 'painter', text: 'I take the sandwich now.' }],
  );
  assert.deepEqual(licensed, []);
});

test('only keys present in duringLine are compared with before', () => {
  const beat = sandwichBeat();
  beat.before = { painterHands: 'empty', sandwich: 'outside reach' };
  beat.duringLine = { sandwich: 'outside reach' };

  assert.deepEqual(lintShotPlan([beat], [], fixture.cases.clean.script), []);
});

test('a rejectIf phrase is matched across prompt spelling and inflection', () => {
  const beat = clone(fixture.cases.sandwichContradiction.beats[0]);
  beat.duringLine = { sandwich: 'within reach' };
  beat.before = { sandwich: 'within reach' };
  beat.rejectIf = ['painter holds sandwich'];
  const shot = {
    id: 'shot-hold',
    beat: 's08_unreachable_sandwich',
    participants: ['painter'],
    actionPrompt: 'The painter holds the sandwich while speaking.',
  };

  const findings = lintShotPlan([beat], [shot], fixture.cases.sandwichContradiction.script);
  assert.deepEqual(codes(findings), ['PROMPT_CONTRADICTS']);
});

test('moving a prop the contract keeps outside reach is flagged without a rejectIf match', () => {
  const beat = clone(fixture.cases.sandwichContradiction.beats[0]);
  beat.rejectIf = [];
  const shot = {
    id: 'shot-move',
    beat: 's08_unreachable_sandwich',
    participants: ['painter'],
    actionPrompt: 'The painter moves the sandwich closer on the high shelf.',
  };

  const findings = lintShotPlan([beat], [shot], fixture.cases.sandwichContradiction.script);
  assert.deepEqual(codes(findings), ['PROMPT_CONTRADICTS']);
  assert.match(findings[0].message, /moves sandwich/);
});

test('a prompt that keeps the sandwich outside reach is not a contradiction', () => {
  const beat = clone(fixture.cases.sandwichContradiction.beats[0]);
  const shot = {
    id: 'shot-safe',
    beat: 's08_unreachable_sandwich',
    participants: ['painter'],
    imagePrompt: 'The sandwich remains outside reach on the high shelf.',
    actionPrompt: "The painter does not move the sandwich; she can't reach it.",
  };

  const findings = lintShotPlan([beat], [shot], fixture.cases.sandwichContradiction.script);
  assert.deepEqual(findings, []);
});

test('a possessive out-of-reach phrase is safe and a negated reject phrase is not a match', () => {
  const beat = clone(fixture.cases.sandwichContradiction.beats[0]);
  const shot = {
    id: 'shot-possessive',
    beat: 's08_unreachable_sandwich',
    participants: ['painter'],
    imagePrompt: "The sandwich sits on a shelf, out of the painter's reach.",
    actionPrompt: 'The painter does not hold the sandwich.',
  };

  const findings = lintShotPlan([beat], [shot], fixture.cases.sandwichContradiction.script);
  assert.deepEqual(findings, []);
});

test('nested image/action prompts and a characters object are supported', () => {
  const beat = clone(fixture.cases.sandwichContradiction.beats[0]);
  beat.duringLine = { sandwich: 'within reach' };
  beat.before = { sandwich: 'within reach' };
  const shot = {
    shot: 'shot-nested',
    beat: 's08_unreachable_sandwich',
    characters: { painter: { costume: 'apron' } },
    image: { prompt: 'The sandwich sits on the bench.' },
    action: { prompt: 'The reporter hands the sandwich to the painter.' },
  };

  const findings = lintShotPlan([beat], [shot], fixture.cases.sandwichContradiction.script);
  assert.equal(findings[0].shot, 'shot-nested');
  assert.deepEqual(codes(findings), ['PROMPT_CONTRADICTS']);
});

test('script forms: lines object, speaker map and single object all resolve the anchor', () => {
  const beat = sandwichBeat();
  const line = { speaker: 'painter', text: "Today I can't reach my sandwich." };

  assert.deepEqual(lintShotPlan([beat], [], { lines: [line] }), []);
  assert.deepEqual(lintShotPlan([beat], [], { painter: line.text }), []);
  assert.deepEqual(lintShotPlan([beat], [], line), []);
});

test('a shot without its own cast inherits the beat participants', () => {
  const plan = fixture.cases.clean;
  const shots = plan.shots.map((shot) => {
    const copy = clone(shot);
    delete copy.participants;
    return copy;
  });

  assert.deepEqual(lintShotPlan(plan.beats, shots, plan.script), []);

  const explicitEmpty = clone(plan.shots);
  explicitEmpty[1].participants = [];
  assert.deepEqual(codes(lintShotPlan(plan.beats, explicitEmpty, plan.script)), [
    'SPEAKER_UNASSIGNED',
  ]);
});

test('findings only carry beat, shot, code and message', () => {
  const plan = fixture.cases.sandwichContradiction;
  const [finding] = lintShotPlan(plan.beats, plan.shots, plan.script);

  assert.deepEqual(Object.keys(finding).sort(), ['beat', 'code', 'message', 'shot']);
  assert.equal(finding.code, FINDING_CODES.PROMPT_CONTRADICTS);
});

test('the default and named exports are the same function', () => {
  assert.equal(lintShotPlan, namedLint);
  assert.equal(canonicalText('  Today\u2019s   SANDWICH! '), "today's sandwich");
});

test('linting does not mutate beats, shots or script', () => {
  const plan = fixture.cases.clean;
  const snapshot = clone(plan);
  lintShotPlan(plan.beats, plan.shots, plan.script);
  assert.deepEqual(plan, snapshot);
});

test('bad top-level inputs fail loudly instead of returning a false clean result', () => {
  assert.throws(() => lintShotPlan(null, [], []), /beats/);
  assert.throws(() => lintShotPlan([], null, []), /shots/);
});
