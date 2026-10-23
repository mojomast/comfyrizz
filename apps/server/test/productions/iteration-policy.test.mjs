// IL01: iteration policy contract.
//
// The policy says how much creative iteration a production allows. It is pure
// data: no filesystem, network, clock or randomness. These tests pin the
// levels, the frozen presets, the closed validation and the derived level.
//
// "Level" is derived from the policy content. A preset copied verbatim derives
// its own level; any edited field or a shot override makes it custom. The
// declared level is accepted only when it is one of the four exact names, so a
// friendly alias can never become a second spelling of a level.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ITERATION_LEVELS,
  ITERATION_POLICY_SCHEMA,
  ITERATION_PRESETS,
  ITERATION_REVIEW_DEPTHS,
  ITERATION_STAGES,
  MAX_AUDITIONS,
  MAX_ROUNDS,
  MAX_TAKES_PER_ASSET,
  MAX_TAKES_PER_ROUND,
  IterationPolicyError,
  deriveLevel,
  effectivePolicyForShot,
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

function stages(overrides = {}) {
  return {
    script: stage(overrides.script),
    voice: stage(overrides.voice),
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

test('the schema, levels, stages, picks and review depths are the exact contract', () => {
  assert.equal(ITERATION_POLICY_SCHEMA, 'comfyrizz.iteration-policy/v1');
  assert.deepEqual(ITERATION_LEVELS, LEVELS);
  assert.deepEqual(ITERATION_STAGES, STAGES);
  assert.deepEqual(ITERATION_REVIEW_DEPTHS, ['light', 'standard', 'deep']);
  assert.ok(Object.isFrozen(ITERATION_LEVELS));
  assert.ok(Object.isFrozen(ITERATION_STAGES));
  assert.ok(Object.isFrozen(ITERATION_REVIEW_DEPTHS));
});

test('the D4 limits are exported and frozen into the contract', () => {
  assert.equal(MAX_TAKES_PER_ROUND, 4);
  assert.equal(MAX_ROUNDS, 3);
  assert.equal(MAX_TAKES_PER_ASSET, 12);
  assert.equal(MAX_AUDITIONS, 4);
});

test('the frozen presets carry the PLAN 2.2 table', () => {
  const draft = ITERATION_PRESETS.draft;
  const balanced = ITERATION_PRESETS.balanced;
  const director = ITERATION_PRESETS.director;

  assert.deepEqual(Object.keys(ITERATION_PRESETS), ['draft', 'balanced', 'director']);
  assert.deepEqual(draft.stages, stages());
  assert.equal(draft.reviewDepth, 'light');

  assert.deepEqual(balanced.stages, stages({
    script: { takes: 1 },
    voice: { auditions: 2 },
    keyframe: { auditions: 2 },
    video: { takes: 2, pick: 'ask' },
  }));
  assert.equal(balanced.reviewDepth, 'standard');

  assert.deepEqual(director.stages, stages({
    script: { takes: 2, pick: 'ask' },
    voice: { auditions: 3, pick: 'ask' },
    keyframe: { auditions: 3, pick: 'ask' },
    video: { takes: 3, rounds: 2, pick: 'ask' },
  }));
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
    assert.equal(validateIterationPolicy(policy({
      stages: { ...stages(), [name]: stage({ pick: 'ask' }) },
    })).stages[name].pick, 'ask');
  }
  for (const reviewDepth of ITERATION_REVIEW_DEPTHS) {
    assert.equal(validateIterationPolicy(policy({ reviewDepth })).reviewDepth, reviewDepth);
  }
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
      stages: { ...stages(), voice: stage({ auditions }) },
    })), 'ITERATION_POLICY_INVALID');
  }
  assertPolicyError(() => validateIterationPolicy(policy({
    stages: { ...stages(), voice: stage({ auditions: MAX_AUDITIONS + 1 }) },
  })), 'ITERATION_EXCEEDED');
  for (const auditions of [0, 1, 2, 3, MAX_AUDITIONS]) {
    const validated = validateIterationPolicy(policy({
      stages: { ...stages(), voice: stage({ auditions }) },
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
  assert.deepEqual(hero.stages.script, base.stages.script);
  assert.deepEqual(hero.stages.keyframe, base.stages.keyframe);

  const two = effectivePolicyForShot(base, 'shot_two');
  assert.equal(two.stages.keyframe.auditions, MAX_AUDITIONS);
  assert.equal(two.stages.video.takes, 2);
  assert.equal(two.stages.video.pick, 'ask');

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
  assert.deepEqual(effective.stages.voice, stage({ auditions: 4 }));
  assert.deepEqual(effective.stages.keyframe, stage({ takes: 2, auditions: 1 }));
  assert.deepEqual(effective.stages.video, stage({ takes: 4, rounds: 3, pick: 'ask' }));

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
});
