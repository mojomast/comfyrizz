import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REF_POLICY_DEFAULTS,
  REF_VERDICT_SCHEMA,
  refRegenJobCap,
  validateRefDecision,
  validateRefVerdict,
} from '../../../../packages/schema/src/ref-review.mjs';
import { decide } from '../../src/ref-watch/decide.mjs';
import {
  EDIT_PLACEHOLDER,
  buildEditInstruction,
  fillEditDecision,
} from '../../src/ref-watch/edit-plan.mjs';

const SHA = 'a'.repeat(64);
const NEGATIVE_START = /^(?:no|not|never|don'?t|do not|avoid|without|remove|removing|delete|eliminate|stop|prevent)\b/i;

const MIRA = {
  characterId: 'mira',
  identityLock: 'Mira: thirty-eight years old, shoulder-length copper hair with a centre part, green eyes flecked with amber',
  wardrobeState: 'yellow oilskin coat, dry',
};

const THEO = {
  characterId: 'theo',
  identityLock: 'Theo: fifty-one years old, short black hair with silver at the temples, broad sturdy build',
  wardrobeState: 'grey trench coat, buttoned',
};

function check(dimension, pass, severity = 'hard', evidence = `${dimension} evidence`, category) {
  return { dimension, pass, severity, evidence, ...(category ? { category } : {}) };
}

function verdict(overall, checks, fixHints = []) {
  return {
    schema: REF_VERDICT_SCHEMA,
    jobId: 'still_s03',
    keyframeSha256: SHA,
    reviewer: 'fake',
    overall,
    checks,
    fixHints,
  };
}

const passedBasics = () => [
  check('technical', true, 'hard', 'the still fills the frame with a wide tonal range'),
  check('identity', true, 'hard', 'copper hair with a centre part and freckles are visible'),
  check('framing', true, 'hard', 'the medium framing holds both figures at the window'),
];

const textArtifactVerdict = (fixHints = []) => verdict('fail', [
  ...passedBasics(),
  check('text_artifact', false, 'hard', 'the sign reads CLOSED'),
], fixHints);

const anatomyVerdict = (evidence = 'the left hand has six fingers') => verdict('fail', [
  ...passedBasics(),
  check('anatomy', false, 'hard', evidence),
]);

const wardrobeVerdict = (evidence = 'the coat is charcoal instead of yellow') => verdict('fail', [
  ...passedBasics(),
  check('prompt', false, 'hard', evidence, 'appearance'),
]);

const rows = [
  {
    name: 'text_artifact-only becomes a targeted edit',
    input: { verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'targeted_edit',
    editDimension: 'text_artifact',
  },
  {
    name: 'hands-and-fingers anatomy becomes a targeted edit',
    input: { verdict: anatomyVerdict(), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'targeted_edit',
    editDimension: 'anatomy',
  },
  {
    name: 'a wardrobe/appearance prompt deduction becomes a targeted edit',
    input: { verdict: wardrobeVerdict(), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'targeted_edit',
    editDimension: 'wardrobe',
  },
  {
    name: 'an identity failure is never an edit',
    input: {
      verdict: verdict('fail', [...passedBasics(), check('identity', false, 'hard', 'the hair is black instead of copper')]),
      attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 1, editsTried: 0,
    },
    action: 'reprompt',
  },
  {
    name: 'a localized failure mixed with identity falls back to reprompt',
    input: {
      verdict: verdict('fail', [...passedBasics(), check('identity', false, 'hard', 'the hair is black instead of copper'), check('text_artifact', false, 'hard', 'the sign reads CLOSED')]),
      attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 1, editsTried: 0,
    },
    action: 'reprompt',
  },
  {
    name: 'a second failure after a targeted edit falls back to reprompt',
    input: { verdict: textArtifactVerdict(), attempt: 1, regenJobsUsed: 1, stillCount: 4, identityFailures: 0, editsTried: 1 },
    action: 'reprompt',
  },
  {
    name: 'the per-still cap exhausted escalates',
    input: { verdict: textArtifactVerdict(), attempt: 2, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'escalate',
  },
  {
    name: 'the production cap exhausted escalates',
    input: { verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 2, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'escalate',
  },
  {
    name: 'non-localized anatomy falls back to reprompt',
    input: { verdict: anatomyVerdict('the spine bends in the wrong direction'), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'reprompt',
  },
  {
    name: 'a localized failure mixed with a framing failure falls back to reprompt',
    input: {
      verdict: verdict('fail', [...passedBasics(), check('framing', false, 'hard', 'the figure is cut off at the waist'), check('text_artifact', false, 'hard', 'the sign reads CLOSED')]),
      attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0,
    },
    action: 'reprompt',
  },
  {
    name: 'a soft text_artifact failure still accepts',
    input: { verdict: verdict('fail', [...passedBasics(), check('text_artifact', false, 'soft', 'the sign lettering is slightly soft')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'accept',
  },
  {
    name: 'an unlocated prompt deduction still accepts',
    input: { verdict: verdict('fail', [...passedBasics(), check('prompt', false, 'hard', 'the prompt wording is muddled')]), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 },
    action: 'accept',
  },
];

test('SP03 decision table: 12 rows', () => {
  assert.equal(rows.length, 12);
  assert.equal(refRegenJobCap(4, REF_POLICY_DEFAULTS), 2);
  for (const row of rows) {
    assert.equal(validateRefVerdict(row.input.verdict).ok, true, `${row.name}: fixture verdict is valid`);
    const decision = decide(row.input);
    assert.equal(validateRefDecision(decision).ok, true, `${row.name}: ${validateRefDecision(decision).errors.join('; ')}`);
    assert.equal(decision.action, row.action, row.name);
    assert.equal(decision.attempt, row.input.attempt, `${row.name}: attempt is echoed`);
    if (row.action === 'targeted_edit') {
      assert.equal(decision.editInstruction, EDIT_PLACEHOLDER, `${row.name}: edit placeholder`);
      assert.equal(decision.editDimension, row.editDimension, `${row.name}: edit dimension`);
      assert.equal(decision.nextPrompt, undefined, `${row.name}: no steer prompt yet`);
    }
    if (row.action === 'reprompt') assert.equal(decision.nextPrompt, '<steer>', `${row.name}: placeholder steer prompt`);
  }
});

test('SP03: a targeted edit consumes one slot against both caps', () => {
  const atLastStillSlot = decide({ verdict: textArtifactVerdict(), attempt: 1, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(atLastStillSlot.action, 'targeted_edit');
  const pastStillCap = decide({ verdict: textArtifactVerdict(), attempt: 2, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(pastStillCap.action, 'escalate');

  const atLastProductionSlot = decide({ verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 1, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(atLastProductionSlot.action, 'targeted_edit');
  const pastProductionCap = decide({ verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 2, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(pastProductionCap.action, 'escalate');
  assert.equal(refRegenJobCap(4, REF_POLICY_DEFAULTS), 2);
});

test('SP03: buildEditInstruction uses a positive fix hint for artwork text', () => {
  const instruction = buildEditInstruction({
    verdict: textArtifactVerdict(['the sign reads OPEN in clean block letters']),
    characters: [MIRA],
  });
  assert.equal(instruction, 'the sign reads OPEN in clean block letters');
  assert.equal(NEGATIVE_START.test(instruction), false);
});

test('SP03: buildEditInstruction synthesizes a five-finger end state from evidence', () => {
  assert.equal(buildEditInstruction({ verdict: anatomyVerdict('the left hand has six fingers'), characters: [MIRA] }), 'the left hand has five fingers');
  assert.equal(buildEditInstruction({ verdict: anatomyVerdict('six fingers on the right hand'), characters: [MIRA] }), 'the right hand has five fingers');
});

test('SP03: buildEditInstruction ignores negative hints and stays positive', () => {
  const instruction = buildEditInstruction({
    verdict: anatomyVerdict('the left hand has six fingers'),
    characters: [MIRA],
  });
  assert.equal(NEGATIVE_START.test(instruction), false);
  const negativeHint = buildEditInstruction({
    verdict: textArtifactVerdict(['no stray letters']),
    characters: [MIRA],
  });
  assert.equal(NEGATIVE_START.test(negativeHint), false);
  assert.notEqual(negativeHint, 'no stray letters');
});

test('SP03: buildEditInstruction restates wardrobeState verbatim for a wardrobe target', () => {
  const instruction = buildEditInstruction({ verdict: wardrobeVerdict('the coat is charcoal instead of yellow'), characters: [MIRA, THEO] });
  assert.ok(instruction.includes(MIRA.wardrobeState), instruction);
  const theoInstruction = buildEditInstruction({ verdict: wardrobeVerdict('theo wears the wrong coat'), characters: [MIRA, THEO] });
  assert.ok(theoInstruction.includes(THEO.wardrobeState), theoInstruction);
});

test('SP03: buildEditInstruction returns an empty string when nothing is localized', () => {
  const identityOnly = verdict('fail', [...passedBasics(), check('identity', false, 'hard', 'the hair is black instead of copper')]);
  assert.equal(buildEditInstruction({ verdict: identityOnly, characters: [MIRA] }), '');
});

test('SP03: fillEditDecision replaces the placeholder immutably and validates', () => {
  const source = decide({ verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(source.editInstruction, EDIT_PLACEHOLDER);
  const instruction = buildEditInstruction({ verdict: textArtifactVerdict(['the sign reads OPEN in clean block letters']), characters: [MIRA] });
  const filled = fillEditDecision(source, { editInstruction: instruction });
  assert.equal(validateRefDecision(filled).ok, true, validateRefDecision(filled).errors.join('; '));
  assert.equal(filled.editInstruction, instruction);
  assert.equal(filled.editInstruction.includes(EDIT_PLACEHOLDER), false);
  assert.equal(source.editInstruction, EDIT_PLACEHOLDER, 'the source decision is not mutated');
});

test('SP03: fillEditDecision leaves other decisions and empty fills unchanged', () => {
  const accepted = decide({ verdict: verdict('pass', passedBasics()), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(fillEditDecision(accepted, { editInstruction: 'the sign reads OPEN' }), accepted);
  const source = decide({ verdict: textArtifactVerdict(), attempt: 0, regenJobsUsed: 0, stillCount: 4, identityFailures: 0, editsTried: 0 });
  assert.equal(fillEditDecision(source, { editInstruction: '   ' }), source);
});
