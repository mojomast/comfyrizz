// IL01G: iteration policy contract with hero picks and voice line counts.
//
// The policy says how much creative iteration a production allows. It is pure
// data: no filesystem, network, clock or randomness. These tests pin the
// levels, the frozen presets, the closed validation and the derived level.
//
// "Level" is derived from the policy content. A preset copied verbatim derives
// its own level; any edited field or a shot override makes it custom. The
// declared level is accepted only when it is one of the four exact names, so a
// friendly alias can never become a second spelling of a level.
//
// `hero` is a video-only pick: it asks on shots the production marks as heroes
// and picks automatically everywhere else. Voice carries `linesPerVoice`, the
// number of local Kokoro audition lines each voice sample reads.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ITERATION_LEVELS,
  ITERATION_PICKS,
  ITERATION_POLICY_SCHEMA,
  ITERATION_PRESETS,
  ITERATION_REVIEW_DEPTHS,
  ITERATION_STAGES,
  MAX_AUDITIONS,
  MAX_LINES_PER_VOICE,
  MAX_ROUNDS,
  MAX_TAKES_PER_ASSET,
  MAX_TAKES_PER_ROUND,
  IterationPolicyError,
  deriveLevel,
  effectivePolicyForShot,
  isHeroShot,
  pickForShot,
  validateIterationPolicy,
} from '../../src/productions/iteration.mjs';

const LEVELS = ['draft', 'balanced', 'director', 'custom'];
const STAGES = ['script', 'voice', 'keyframe', 'video'];

function clone(value) {
  return structuredClone(value);
}

function stage(overrides = {}) {
  return { takes: 1, rounds: 1, auditions: 0, pick: 'auto', ...overrides };
}

function voiceStage(overrides = {}) {
  return stage({ linesPerVoice: 1, ...overrides });
}

function stages(overrides = {}) {
  return {
    script: stage(overrides.script),
    voice: voiceStage(overrides.voice),
    keyframe: stage(overrides.keyframe),
    video: stage(overrides.video),
  };
}

function policy(overrides = {}) {
  return {
    level: 'balanced',
    stages: clone(ITERATION_PRESETS.balanced.stages),
    reviewDepth: 'standard',
    shotOverrides: {},
    ...overrides,
  };
}

function assertPolicyError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof IterationPolicyError, `expected IterationPolicyError, got ${error?.name}: ${error?.message}`);
    if (code !== undefined) assert.equal(error.code, code);
    assert.equal(error.status, 400);
    return true;
  });
}

function assertPolicyField(fn, code, field) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof IterationPolicyError, `expected IterationPolicyError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    assert.equal(error.field, field, `expected field ${field}, got ${error?.field}`);
    return true;
  });
}

test('the schema, levels, stages, picks and review depths are the exact contract', () => {
  assert.equal(ITERATION_POLICY_SCHEMA, 'comfyrizz.iteration-policy/v1');
  assert.deepEqual(ITERATION_LEVELS, LEVELS);
  assert.deepEqual(ITERATION_STAGES, STAGES);
  assert.deepEqual(ITERATION_PICKS, ['auto', 'ask', 'hero']);
  assert.deepEqual(ITERATION_REVIEW_DEPTHS, ['light', 'standard', 'deep']);
  assert.ok(Object.isFrozen(ITERATION_LEVELS));
  assert.ok(Object.isFrozen(ITERATION_STAGES));
  assert.ok(Object.isFrozen(ITERATION_PICKS));
  assert.ok(Object.isFrozen(ITERATION_REVIEW_DEPTHS));
});

test('the D4 limits and the voice line cap are exported and frozen into the contract', () => {
  assert.equal(MAX_TAKES_PER_ROUND, 4);
  assert.equal(MAX_ROUNDS, 3);
  assert.equal(MAX_TAKES_PER_ASSET, 12);
  assert.equal(MAX_AUDITIONS, 4);
  assert.equal(MAX_LINES_PER_VOICE, 3);
});

test('the frozen presets carry the PLAN 2.2 table with hero and voice lines', () => {
  const draft = ITERATION_PRESETS.draft;
  const balanced = ITERATION_PRESETS.balanced;
  const director = ITERATION_PRESETS.director;

  assert.deepEqual(Object.keys(ITERATION_PRESETS), ['draft', 'balanced', 'director']);
  assert.deepEqual(draft.stages, stages());
  assert.equal(draft.stages.voice.linesPerVoice, 1);
  assert.equal(draft.reviewDepth, 'light');

  assert.deepEqual(balanced.stages, stages({
    voice: { auditions: 2, linesPerVoice: 1 },
    keyframe: { auditions: 2 },
    video: { takes: 2, pick: 'hero' },
  }));
  assert.equal(balanced.stages.voice.linesPerVoice, 1);
  assert.equal(balanced.reviewDepth, 'standard');

  assert.deepEqual(director.stages, stages({
    script: { takes: 2, pick: 'ask' },
    voice: { auditions: 3, pick: 'ask', linesPerVoice: 2 },
    keyframe: { auditions: 3, pick: 'ask' },
    video: { takes: 3, rounds: 2, pick: 'ask' },
  }));
  assert.equal(director.stages.voice.linesPerVoice, 2);
  assert.equal(director.reviewDepth, 'deep');

  for (const level of ['draft', 'balanced', 'director']) {
    const preset = ITERATION_PRESETS[level];
    assert.equal(preset.level, level);
    assert.deepEqual(preset.shotOverrides, {});
    assert.ok(Object.isFrozen(preset), `${level} is not frozen`);
    assert.ok(Object.isFrozen(preset.stages), `${level}.stages is not frozen`);
    assert.ok(Object.isFrozen(preset.shotOverrides), `${level}.shotOverrides is not frozen`);
    for (const name of STAGES) {
      assert.ok(Object.isFrozen(preset.stages[name]), `${level}.${name} is not frozen`);
    }
    assert.deepEqual(
      Object.keys(preset.stages.voice).sort(),
      ['auditions', 'linesPerVoice', 'pick', 'rounds', 'takes'],
      `${level}.voice carries exactly the voice fields`,
    );
    for (const name of ['script', 'keyframe', 'video']) {
      assert.deepEqual(
        Object.keys(preset.stages[name]).sort(),
        ['auditions', 'pick', 'rounds', 'takes'],
        `${level}.${name} carries exactly the shared stage fields`,
      );
    }
  }
});

test('every preset validates and derives its own level', () => {
  for (const level of ['draft', 'balanced', 'director']) {
    const validated = validateIterationPolicy(ITERATION_PRESETS[level]);
    assert.equal(validated.level, level);
    assert.deepEqual(validated.stages, ITERATION_PRESETS[level].stages);
    assert.equal(validated.reviewDepth, ITERATION_PRESETS[level].reviewDepth);
    assert.deepEqual(validated.shotOverrides, {});
    assert.equal(deriveLevel(ITERATION_PRESETS[level]), level);
  }
});

test('the declared level is not authority: it is re-derived from the content', () => {
  const balanced = policy({ level: 'director' });
  assert.equal(validateIterationPolicy(balanced).level, 'balanced');
  assert.equal(deriveLevel(balanced), 'balanced');

  const draft = policy({ level: 'custom', stages: clone(ITERATION_PRESETS.draft.stages), reviewDepth: 'light' });
  assert.equal(validateIterationPolicy(draft).level, 'draft');
  assert.equal(deriveLevel(draft), 'draft');
});

test('any edit to a preset derives custom', () => {
  for (const level of ['draft', 'balanced', 'director']) {
    for (const name of STAGES) {
      for (const field of ['takes', 'rounds', 'auditions', 'pick']) {
        if (field === 'auditions' && (name === 'script' || name === 'video')) continue;
        const edited = clone(ITERATION_PRESETS[level]);
        if (field === 'pick') {
          edited.stages[name].pick = edited.stages[name].pick === 'auto' ? 'ask' : 'auto';
        } else {
          edited.stages[name][field] = edited.stages[name][field] < MAX_TAKES_PER_ROUND ? edited.stages[name][field] + 1 : 1;
        }
        assert.equal(deriveLevel(edited), 'custom', `${level}.${name}.${field} must derive custom`);
        assert.equal(validateIterationPolicy(edited).level, 'custom');
      }
    }

    for (const linesPerVoice of [1, 2, MAX_LINES_PER_VOICE]) {
      const edited = clone(ITERATION_PRESETS[level]);
      if (edited.stages.voice.linesPerVoice === linesPerVoice) continue;
      edited.stages.voice.linesPerVoice = linesPerVoice;
      assert.equal(deriveLevel(edited), 'custom', `${level}.voice.linesPerVoice must derive custom`);
      assert.equal(validateIterationPolicy(edited).level, 'custom');
    }

    const editedDepth = clone(ITERATION_PRESETS[level]);
    editedDepth.reviewDepth = editedDepth.reviewDepth === 'deep' ? 'light' : 'deep';
    assert.equal(deriveLevel(editedDepth), 'custom');

    const overridden = clone(ITERATION_PRESETS[level]);
    overridden.shotOverrides = { shot_1: { stages: { video: { takes: MAX_TAKES_PER_ROUND } } } };
    assert.equal(deriveLevel(overridden), 'custom');
    assert.equal(validateIterationPolicy(overridden).level, 'custom');
  }
});

test('alias and malformed level names are rejected', () => {
  const aliases = ['standard', 'medium', 'high', 'full', 'auto', 'Draft', 'BALANCED', ' balanced', 'balanced ', 'director!', ''];
  for (const level of aliases) {
    assertPolicyError(() => validateIterationPolicy(policy({ level })), 'ITERATION_LEVEL_INVALID');
  }
  for (const level of [null, 1, true, {}, []]) {
    assertPolicyError(() => validateIterationPolicy(policy({ level })), 'ITERATION_LEVEL_INVALID');
  }
  assert.equal(validateIterationPolicy(policy({ level: 'custom' })).level, 'balanced');
});

test('root, stage and override objects are closed', () => {
  assertPolicyError(() => validateIterationPolicy(policy({ extra: true })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({ stages: { ...stages(), audio: stage() } })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({
    stages: { ...stages(), video: { ...stage(), warmth: 1 } },
  })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({
    shotOverrides: { shot_1: { stages: { video: { takes: 2 } }, reviewDepth: 'deep' } },
  })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({
    shotOverrides: { shot_1: { stages: { audio: { takes: 2 } } } },
  })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({
    shotOverrides: { shot_1: { stages: { video: { speed: 2 } } } },
  })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({ shotOverrides: [] })), 'ITERATION_POLICY_INVALID');
});

test('required fields, plain objects and the four stage names are required', () => {
  assertPolicyError(() => validateIterationPolicy(null), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy([]), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy('policy'), 'ITERATION_POLICY_INVALID');

  const missingLevel = policy();
  delete missingLevel.level;
  assertPolicyError(() => validateIterationPolicy(missingLevel), 'ITERATION_POLICY_INVALID');

  const missingDepth = policy();
  delete missingDepth.reviewDepth;
  assertPolicyError(() => validateIterationPolicy(missingDepth), 'ITERATION_POLICY_INVALID');

  const missingStage = policy();
  delete missingStage.stages.voice;
  assertPolicyError(() => validateIterationPolicy(missingStage), 'ITERATION_POLICY_INVALID');

  const missingField = policy();
  delete missingField.stages.video.takes;
  assertPolicyError(() => validateIterationPolicy(missingField), 'ITERATION_POLICY_INVALID');

  assertPolicyError(() => validateIterationPolicy(policy({ stages: [] })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({ stages: { ...stages(), video: null } })), 'ITERATION_POLICY_INVALID');
});

test('pick and review depth use closed vocabularies', () => {
  for (const pick of ['sometimes', 'recommended', true, null, 1]) {
    assertPolicyError(() => validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ pick }) },
    })), 'ITERATION_POLICY_INVALID');
  }
  for (const reviewDepth of ['medium', 'thorough', true, null, 2]) {
    assertPolicyError(() => validateIterationPolicy(policy({ reviewDepth })), 'ITERATION_POLICY_INVALID');
  }
  for (const name of ['script', 'voice', 'keyframe', 'video']) {
    const candidate = name === 'voice' ? voiceStage({ pick: 'ask' }) : stage({ pick: 'ask' });
    assert.equal(validateIterationPolicy(policy({
      stages: { ...stages(), [name]: candidate },
    })).stages[name].pick, 'ask');
  }
  for (const reviewDepth of ITERATION_REVIEW_DEPTHS) {
    assert.equal(validateIterationPolicy(policy({ reviewDepth })).reviewDepth, reviewDepth);
  }
});

test("'hero' is a video-only pick in stages and shot overrides", () => {
  for (const pick of ['auto', 'ask', 'hero']) {
    assert.equal(validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ pick }) },
    })).stages.video.pick, pick);
  }

  for (const name of ['script', 'voice', 'keyframe']) {
    const candidate = name === 'voice' ? voiceStage({ pick: 'hero' }) : stage({ pick: 'hero' });
    assertPolicyField(() => validateIterationPolicy(policy({
      stages: { ...stages(), [name]: candidate },
    })), 'ITERATION_POLICY_INVALID', `policy.stages.${name}.pick`);

    assertPolicyField(() => validateIterationPolicy(policy({
      shotOverrides: { shot_1: { stages: { [name]: { pick: 'hero' } } } },
    })), 'ITERATION_POLICY_INVALID', `shotOverrides.shot_1.stages.${name}.pick`);
  }

  assert.equal(validateIterationPolicy(policy({
    shotOverrides: { shot_1: { stages: { video: { pick: 'hero' } } } },
  })).shotOverrides.shot_1.stages.video.pick, 'hero');
});

test('voice requires linesPerVoice as an integer between one and the cap', () => {
  const missing = policy();
  delete missing.stages.voice.linesPerVoice;
  assertPolicyField(
    () => validateIterationPolicy(missing),
    'ITERATION_POLICY_INVALID',
    'policy.stages.voice.linesPerVoice',
  );

  for (const linesPerVoice of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    assertPolicyField(() => validateIterationPolicy(policy({
      stages: { ...stages(), voice: voiceStage({ linesPerVoice }) },
    })), 'ITERATION_POLICY_INVALID', 'policy.stages.voice.linesPerVoice');
  }
  for (const linesPerVoice of [MAX_LINES_PER_VOICE + 1, 10]) {
    assertPolicyField(() => validateIterationPolicy(policy({
      stages: { ...stages(), voice: voiceStage({ linesPerVoice }) },
    })), 'ITERATION_EXCEEDED', 'policy.stages.voice.linesPerVoice');
  }
  for (const linesPerVoice of [1, 2, MAX_LINES_PER_VOICE]) {
    assert.equal(validateIterationPolicy(policy({
      stages: { ...stages(), voice: voiceStage({ linesPerVoice }) },
    })).stages.voice.linesPerVoice, linesPerVoice);
  }
});

test('linesPerVoice is refused on every stage except voice', () => {
  for (const name of ['script', 'keyframe', 'video']) {
    assertPolicyField(() => validateIterationPolicy(policy({
      stages: { ...stages(), [name]: stage({ linesPerVoice: 2 }) },
    })), 'ITERATION_POLICY_INVALID', `policy.stages.${name}.linesPerVoice`);

    assertPolicyField(() => validateIterationPolicy(policy({
      shotOverrides: { shot_1: { stages: { [name]: { linesPerVoice: 2 } } } },
    })), 'ITERATION_POLICY_INVALID', `shotOverrides.shot_1.stages.${name}.linesPerVoice`);
  }
});

test('a voice shot override may set linesPerVoice and merges field by field', () => {
  const base = policy({
    shotOverrides: {
      shot_1: { stages: { voice: { linesPerVoice: MAX_LINES_PER_VOICE } } },
      shot_2: { stages: { voice: { auditions: 1 } } },
    },
  });

  const first = effectivePolicyForShot(base, 'shot_1');
  assert.equal(first.stages.voice.linesPerVoice, MAX_LINES_PER_VOICE);
  assert.equal(first.stages.voice.auditions, 2, 'unmentioned override fields keep the base value');
  assert.equal(first.stages.voice.pick, 'auto');

  const second = effectivePolicyForShot(base, 'shot_2');
  assert.equal(second.stages.voice.linesPerVoice, 1, 'the base linesPerVoice survives a partial voice override');
  assert.equal(second.stages.voice.auditions, 1);

  for (const linesPerVoice of [0, 1.5, '2', null]) {
    const invalid = policy({ shotOverrides: { shot_1: { stages: { voice: { linesPerVoice } } } } });
    assertPolicyField(
      () => validateIterationPolicy(invalid),
      'ITERATION_POLICY_INVALID',
      'shotOverrides.shot_1.stages.voice.linesPerVoice',
    );
    assertPolicyField(
      () => effectivePolicyForShot(invalid, 'shot_1'),
      'ITERATION_POLICY_INVALID',
      'shotOverrides.shot_1.stages.voice.linesPerVoice',
    );
  }
  const overLimit = policy({ shotOverrides: { shot_1: { stages: { voice: { linesPerVoice: MAX_LINES_PER_VOICE + 1 } } } } });
  assertPolicyField(
    () => validateIterationPolicy(overLimit),
    'ITERATION_EXCEEDED',
    'shotOverrides.shot_1.stages.voice.linesPerVoice',
  );
});

test('bounds reject zero, non-integer, non-finite, non-number and over-limit takes', () => {
  for (const takes of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    assertPolicyError(() => validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ takes }) },
    })), 'ITERATION_POLICY_INVALID');
  }
  for (const takes of [MAX_TAKES_PER_ROUND + 1, 10]) {
    assertPolicyError(() => validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ takes }) },
    })), 'ITERATION_EXCEEDED');
  }
  for (const takes of [1, 2, 3, MAX_TAKES_PER_ROUND]) {
    assert.equal(validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ takes }) },
    })).stages.video.takes, takes);
  }
});

test('bounds reject invalid rounds and cap takes per asset at twelve', () => {
  for (const rounds of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    assertPolicyError(() => validateIterationPolicy(policy({
      stages: { ...stages(), video: stage({ rounds }) },
    })), 'ITERATION_POLICY_INVALID');
  }
  assertPolicyError(() => validateIterationPolicy(policy({
    stages: { ...stages(), video: stage({ rounds: MAX_ROUNDS + 1 }) },
  })), 'ITERATION_EXCEEDED');

  const twelve = validateIterationPolicy(policy({
    stages: { ...stages(), video: stage({ takes: MAX_TAKES_PER_ROUND, rounds: MAX_ROUNDS }) },
  }));
  assert.equal(twelve.stages.video.takes * twelve.stages.video.rounds, MAX_TAKES_PER_ASSET);

  assertPolicyError(() => validateIterationPolicy(policy({
    stages: { ...stages(), video: stage({ takes: MAX_TAKES_PER_ROUND, rounds: MAX_ROUNDS, auditions: 1 }) },
  })), 'ITERATION_POLICY_INVALID');
});

test('auditions are bounded to zero through four and are not takes', () => {
  for (const auditions of [-1, 1.5, NaN, Infinity, '2', null]) {
    assertPolicyError(() => validateIterationPolicy(policy({
      stages: { ...stages(), voice: voiceStage({ auditions }) },
    })), 'ITERATION_POLICY_INVALID');
  }
  assertPolicyError(() => validateIterationPolicy(policy({
    stages: { ...stages(), voice: voiceStage({ auditions: MAX_AUDITIONS + 1 }) },
  })), 'ITERATION_EXCEEDED');
  for (const auditions of [0, 1, 2, 3, MAX_AUDITIONS]) {
    const validated = validateIterationPolicy(policy({
      stages: { ...stages(), voice: voiceStage({ auditions }) },
    }));
    assert.equal(validated.stages.voice.auditions, auditions);
    assert.equal(validated.stages.voice.takes, 1);
  }
});

test('no overrides leaves the policy untouched and frozen', () => {
  const input = policy();
  const before = clone(input);
  const validated = validateIterationPolicy(input);
  assert.deepEqual(input, before, 'validation must not mutate its input');
  assert.deepEqual(validated.stages, input.stages);
  assert.ok(Object.isFrozen(validated));
  assert.ok(Object.isFrozen(validated.stages));
  for (const name of STAGES) assert.ok(Object.isFrozen(validated.stages[name]));
  assert.ok(Object.isFrozen(validated.shotOverrides));

  const effective = effectivePolicyForShot(input, 'shot_1');
  assert.deepEqual(effective.stages, input.stages);
  assert.equal(effective.level, 'balanced');
  assert.equal(effective.reviewDepth, 'standard');
  assert.equal(Object.hasOwn(effective, 'shotOverrides'), false);
  assert.ok(Object.isFrozen(effective));
});

test('a shot override merges field by field and applies to that shot only', () => {
  const base = policy({
    shotOverrides: {
      shot_hero: { stages: { video: { takes: 4, pick: 'auto' }, voice: { auditions: 3 } } },
      shot_two: { stages: { keyframe: { auditions: MAX_AUDITIONS } } },
    },
  });

  const hero = effectivePolicyForShot(base, 'shot_hero');
  assert.equal(hero.level, 'custom', 'an override is an edit, so the base policy is custom');
  assert.equal(hero.stages.video.takes, 4);
  assert.equal(hero.stages.video.pick, 'auto');
  assert.equal(hero.stages.video.rounds, 1, 'unmentioned override fields keep the base value');
  assert.equal(hero.stages.voice.auditions, 3);
  assert.equal(hero.stages.voice.takes, 1);
  assert.equal(hero.stages.voice.linesPerVoice, 1);
  assert.deepEqual(hero.stages.script, base.stages.script);
  assert.deepEqual(hero.stages.keyframe, base.stages.keyframe);

  const two = effectivePolicyForShot(base, 'shot_two');
  assert.equal(two.stages.keyframe.auditions, MAX_AUDITIONS);
  assert.equal(two.stages.video.takes, 2);
  assert.equal(two.stages.video.pick, 'hero');

  const plain = effectivePolicyForShot(base, 'shot_other');
  assert.deepEqual(plain.stages, base.stages, 'an unmentioned shot is unaffected');
  assert.equal(plain.level, 'custom');

  assert.deepEqual(base.shotOverrides.shot_hero.stages.video.takes, 4, 'the source policy is not mutated');
});

test('shot overrides can override every stage but never the level or review depth', () => {
  const base = policy({
    shotOverrides: {
      shot_1: {
        stages: {
          script: { takes: 3, pick: 'ask' },
          voice: { auditions: 4 },
          keyframe: { takes: 2, auditions: 1 },
          video: { takes: 4, rounds: 3 },
        },
      },
    },
  });
  const effective = effectivePolicyForShot(base, 'shot_1');
  assert.equal(effective.level, 'custom');
  assert.equal(effective.reviewDepth, 'standard');
  assert.deepEqual(effective.stages.script, stage({ takes: 3, pick: 'ask' }));
  assert.deepEqual(effective.stages.voice, voiceStage({ auditions: 4 }));
  assert.deepEqual(effective.stages.keyframe, stage({ takes: 2, auditions: 1 }));
  assert.deepEqual(effective.stages.video, stage({ takes: 4, rounds: 3, pick: 'hero' }));

  for (const bad of [
    { stages: { video: { takes: 5 } } },
    { stages: { video: { rounds: 4 } } },
    { stages: { voice: { auditions: 5 } } },
    { stages: { video: { pick: 'sometimes' } } },
  ]) {
    const invalid = policy({ shotOverrides: { shot_1: bad } });
    assertPolicyError(() => validateIterationPolicy(invalid));
    assertPolicyError(() => effectivePolicyForShot(invalid, 'shot_1'));
  }
});

test('shot ids are non-empty identifiers and override objects are closed', () => {
  for (const shotId of ['', ' ', 'shot/1', 'shot\\1', 'a\u0000b']) {
    const candidate = policy();
    candidate.shotOverrides = { [shotId]: { stages: { video: { takes: 2 } } } };
    assertPolicyError(() => validateIterationPolicy(candidate), 'ITERATION_POLICY_INVALID');
  }
  assertPolicyError(() => validateIterationPolicy(policy({ shotOverrides: { shot_1: null } })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({ shotOverrides: { shot_1: { stages: 'video' } } })), 'ITERATION_POLICY_INVALID');
  assertPolicyError(() => validateIterationPolicy(policy({ shotOverrides: { shot_1: { stages: { video: {} }, extra: true } } })), 'ITERATION_POLICY_INVALID');
});

test('an absent shotOverrides is accepted as an empty map', () => {
  const input = policy();
  delete input.shotOverrides;
  const validated = validateIterationPolicy(input);
  assert.deepEqual(validated.shotOverrides, {});
  assert.equal(validated.level, 'balanced');
  assert.deepEqual(effectivePolicyForShot(input, 'shot_1').stages, input.stages);
});

test('the presets are stable across calls and cannot be edited through validation', () => {
  const first = validateIterationPolicy(ITERATION_PRESETS.balanced);
  const second = validateIterationPolicy(ITERATION_PRESETS.balanced);
  assert.deepEqual(first, second);
  assert.notEqual(first.stages, ITERATION_PRESETS.balanced.stages, 'validation returns its own copy');
  assert.equal(ITERATION_PRESETS.balanced.stages.video.takes, 2);
  assert.equal(ITERATION_PRESETS.balanced.stages.video.pick, 'hero');
  assert.equal(ITERATION_PRESETS.balanced.stages.voice.linesPerVoice, 1);
});

test('isHeroShot uses the flagged shots, else the first and last shot', () => {
  const flagged = [
    { id: 'shot_a' },
    { id: 'shot_b', hero: false },
    { id: 'shot_c', hero: true },
    { id: 'shot_d', hero: true },
  ];
  assert.equal(isHeroShot('shot_c', flagged), true);
  assert.equal(isHeroShot('shot_d', flagged), true);
  assert.equal(isHeroShot('shot_b', flagged), false, 'a flagged production ignores the first/last fallback');

  const unflagged = [{ id: 'shot_a' }, { id: 'shot_b' }, { id: 'shot_c' }];
  assert.equal(isHeroShot('shot_a', unflagged), true);
  assert.equal(isHeroShot('shot_c', unflagged), true);
  assert.equal(isHeroShot('shot_b', unflagged), false);

  assert.equal(isHeroShot('only', [{ id: 'only' }]), true, 'a one-shot production makes that shot the hero');
  assert.equal(isHeroShot('solo', [{ id: 'solo', hero: true }]), true);
});

test('isHeroShot refuses an unknown shot and a malformed shot list', () => {
  const shots = [{ id: 'shot_a' }, { id: 'shot_b' }];
  assert.throws(() => isHeroShot('shot_z', shots), TypeError);
  assert.throws(() => isHeroShot('shot_a', 'shots'), TypeError);
  assert.throws(() => isHeroShot('shot_a', null), TypeError);
  assert.throws(() => isHeroShot('shot_a', [null]), TypeError);
  assert.throws(() => isHeroShot('shot_a', [{}]), TypeError);
  assert.throws(() => isHeroShot('shot_a', [{ id: 1 }]), TypeError);
  assert.throws(() => isHeroShot(1, shots), TypeError);
});

test('pickForShot resolves hero for the video stage and keeps explicit picks', () => {
  const shots = [{ id: 'shot_a' }, { id: 'shot_b' }, { id: 'shot_c' }];
  const balanced = policy();

  assert.equal(effectivePolicyForShot(balanced, 'shot_a').stages.video.pick, 'hero');
  assert.equal(pickForShot(balanced, 'video', 'shot_a', shots), 'ask', 'the first unflagged shot is a hero');
  assert.equal(pickForShot(balanced, 'video', 'shot_c', shots), 'ask', 'the last unflagged shot is a hero');
  assert.equal(pickForShot(balanced, 'video', 'shot_b', shots), 'auto', 'a middle unflagged shot is not a hero');

  const flagged = [{ id: 'shot_a' }, { id: 'shot_b', hero: true }, { id: 'shot_c' }];
  assert.equal(pickForShot(balanced, 'video', 'shot_a', flagged), 'auto');
  assert.equal(pickForShot(balanced, 'video', 'shot_b', flagged), 'ask');
  assert.equal(pickForShot(balanced, 'video', 'shot_c', flagged), 'auto');

  const ask = policy({ stages: { ...clone(ITERATION_PRESETS.director.stages) }, reviewDepth: 'deep' });
  assert.equal(pickForShot(ask, 'video', 'shot_b', flagged), 'ask');
  assert.equal(pickForShot(ITERATION_PRESETS.director, 'video', 'shot_b', flagged), 'ask');

  const auto = policy({ stages: clone(ITERATION_PRESETS.draft.stages), reviewDepth: 'light' });
  assert.equal(pickForShot(auto, 'video', 'shot_b', flagged), 'auto');

  assert.equal(pickForShot(balanced, 'voice', 'shot_b', flagged), 'auto');
  assert.equal(pickForShot(ITERATION_PRESETS.director, 'voice', 'shot_b', flagged), 'ask');
});

test('pickForShot reads a hero shot override and refuses malformed input', () => {
  const shots = [{ id: 'shot_a' }, { id: 'shot_b', hero: true }];
  const overridden = policy({
    shotOverrides: {
      shot_a: { stages: { video: { pick: 'ask' } } },
      shot_b: { stages: { video: { pick: 'auto' } } },
    },
  });
  assert.equal(effectivePolicyForShot(overridden, 'shot_b').stages.video.pick, 'auto');
  assert.equal(pickForShot(overridden, 'video', 'shot_a', shots), 'ask');
  assert.equal(pickForShot(overridden, 'video', 'shot_b', shots), 'auto');

  assert.throws(() => pickForShot(policy(), 'video', 'unknown', shots), TypeError);
  assert.throws(() => pickForShot(ITERATION_PRESETS.director, 'video', 'unknown', shots), TypeError,
    'an explicit ask pick still refuses an unknown shot');
  assert.throws(() => pickForShot(ITERATION_PRESETS.draft, 'voice', 'shot_a', null), TypeError,
    'an explicit auto pick still refuses a malformed shot list');
  assert.throws(() => pickForShot(policy(), 'audio', 'shot_a', shots), TypeError);
});
